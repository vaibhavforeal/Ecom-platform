/*
  media_tenant_checksum_idx becomes UNIQUE.

  Two rows with the same (tenant_id, checksum) are the same bytes twice.
  The checksum is what lets a re-upload reuse derivatives already paid
  for, so a duplicate means the dedupe SELECT picks one of them and the
  other's eighteen derivatives are orphaned in object storage — billed
  forever, referenced by nothing.

  PRE-EXISTING DUPLICATES ARE COLLAPSED FIRST, in this transaction.
  Without that, this migration fails on any database that has them —
  and it cannot be a CREATE INDEX CONCURRENTLY instead, because the
  runner (drizzle's migrator) wraps every migration in a single
  transaction and CONCURRENTLY is illegal there. Collapsing first is
  also the better half of that trade: it leaves the database correct,
  rather than leaving an INVALID index behind and a report nobody reads.

  Objects in storage are NOT touched. Derivative keys are content
  addressed, so a loser's derivatives either share the keeper's keys or
  are orphaned bytes; reclaiming those is storage's problem, not DDL's.
*/
DO $$
DECLARE
  hidden_by_rls boolean;
  collapsed     integer;
BEGIN
  /*
    Refuse to run half-blind.

    "media" is FORCE ROW LEVEL SECURITY'd with a policy keyed on
    app.tenant_id, which no migration sets. A role that cannot bypass
    RLS therefore sees ZERO rows here, finds no duplicates, reports
    nothing, and leaves CREATE UNIQUE INDEX to fail with a message that
    explains none of it. Migrations run as a BYPASSRLS role by design
    (see infra/docker/postgres/init/01-roles.sh); this asserts it.
  */
  SELECT c.relrowsecurity
         AND (c.relforcerowsecurity OR pg_get_userbyid(c.relowner) <> current_user)
         AND NOT EXISTS (
           SELECT 1 FROM pg_roles r
            WHERE r.rolname = current_user AND (r.rolbypassrls OR r.rolsuper))
    INTO hidden_by_rls
    FROM pg_class c
   WHERE c.oid = 'media'::regclass;

  IF hidden_by_rls THEN
    RAISE EXCEPTION
      'row security on "media" hides rows from "%", so duplicate checksums cannot be found or fixed. Run migrations as a BYPASSRLS role.',
      current_user;
  END IF;

  /*
    The survivor of each group: a ready row over an unprocessed one, a
    live row over a soft-deleted one, and the oldest of whatever is
    left — the row everything is most likely to point at already, and
    the one whose derivatives exist.

    `checksum IS NOT NULL` matters. NULLs are distinct under a unique
    index, so un-hashed rows are not duplicates; grouping them would
    collapse every one of them onto a single row.
  */
  CREATE TEMP TABLE media_checksum_dupes ON COMMIT DROP AS
    SELECT id AS loser,
           first_value(id) OVER (
             PARTITION BY tenant_id, checksum
             ORDER BY (status = 'ready') DESC, (deleted_at IS NULL) DESC, created_at, id
           ) AS keeper
      FROM media
     WHERE checksum IS NOT NULL;

  DELETE FROM media_checksum_dupes WHERE loser = keeper;
  SELECT count(*) INTO collapsed FROM media_checksum_dupes;

  IF collapsed = 0 THEN
    RETURN;
  END IF;

  -- Repoint every reference before deleting anything. These columns are
  -- ON DELETE SET NULL, so deleting first would silently blank a
  -- category's or a variant's image instead of moving it.
  UPDATE categories c
     SET image_media_id = d.keeper
    FROM media_checksum_dupes d
   WHERE c.image_media_id = d.loser;

  UPDATE collections c
     SET image_media_id = d.keeper
    FROM media_checksum_dupes d
   WHERE c.image_media_id = d.loser;

  UPDATE product_variants v
     SET image_media_id = d.keeper
    FROM media_checksum_dupes d
   WHERE v.image_media_id = d.loser;

  /*
    product_media is keyed (tenant_id, product_id, media_id), so
    repointing a loser to its keeper is never safe on its own: one
    product can hold the keeper and several of its losers — the same
    photograph uploaded three times before dedupe existed, then dropped
    into one gallery twice — and every one of those rows would be
    updated to the same key.

    So attach the keeper where it is missing and drop every loser row,
    which is one end state for all three topologies (keeper + loser,
    loser alone, several losers) and needs no case analysis.

    DISTINCT ON collapses the several-losers case to a single candidate
    before the insert: ON CONFLICT arbitrates against rows already in
    the table, not against the rest of its own command. Ordering by
    position means the survivor keeps the earliest slot the image held.
  */
  INSERT INTO product_media (tenant_id, product_id, media_id, position)
  SELECT DISTINCT ON (pm.tenant_id, pm.product_id, d.keeper)
         pm.tenant_id, pm.product_id, d.keeper, pm.position
    FROM product_media pm
    JOIN media_checksum_dupes d ON d.loser = pm.media_id
   ORDER BY pm.tenant_id, pm.product_id, d.keeper, pm.position
  ON CONFLICT DO NOTHING;

  DELETE FROM product_media pm
   USING media_checksum_dupes d
   WHERE pm.media_id = d.loser;

  DELETE FROM media m
   USING media_checksum_dupes d
   WHERE m.id = d.loser;

  /*
    WARNING, not NOTICE. The migration runner silences NOTICE — every
    idempotent DROP ... IF EXISTS in the RLS script emits one — and
    prints anything louder. Deleting rows is not something a migration
    gets to do quietly.
  */
  RAISE WARNING
    'media: collapsed % duplicate (tenant_id, checksum) row(s) onto the earliest ready row; image references were repointed',
    collapsed;
END $$;
--> statement-breakpoint
DROP INDEX "media_tenant_checksum_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "media_tenant_checksum_idx" ON "media" USING btree ("tenant_id","checksum");
