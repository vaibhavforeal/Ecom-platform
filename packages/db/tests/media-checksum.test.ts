import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections } from "../src/index";

/**
 * `media_tenant_checksum_idx` is UNIQUE.
 *
 * The checksum is what makes a re-upload of the same photograph reuse
 * derivatives already paid for instead of costing another decode and
 * eighteen encodes. Two rows for one checksum break that silently: the
 * dedupe SELECT finds one of them, and the other's derivatives sit in
 * object storage referenced by nothing.
 *
 * Nothing in TypeScript can express this, and the upload route's
 * `onConflictDoNothing` reads exactly the same either way — so the
 * constraint is asserted here, against the database that has it.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;

/** The same bytes, hashed. Shared by both tenants below on purpose. */
const CHECKSUM = "0f9c1e2b3a4d5c6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";

async function insertMedia(
  tenantId: string,
  storageKey: string,
  opts: { checksum?: string | null; deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, checksum, status,
                       deleted_at)
    VALUES (${id}, ${tenantId}, ${storageKey}, 'image/jpeg', 1234,
            ${opts.checksum === undefined ? CHECKSUM : opts.checksum}, 'ready',
            ${opts.deleted ? new Date() : null})`;
  return id;
}

beforeAll(async () => {
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"chk-" + randomUUID().slice(0, 8)}, 'Checksum test plan')
    RETURNING id`;

  const mk = async () => {
    const slug = "chk-" + randomUUID().slice(0, 12);
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
      RETURNING id`;
    return t!.id;
  };

  tenantA = await mk();
  tenantB = await mk();
});

afterAll(async () => {
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await admin.end({ timeout: 5 });
  await closeConnections();
});

describe("media (tenant_id, checksum)", () => {
  it("refuses a second row for the same checksum", async () => {
    await insertMedia(tenantA, "chk/originals/first.jpg");

    // A different storage key, so the other unique index cannot be what
    // rejects this. Same bytes, second row: that is the bug.
    await expect(insertMedia(tenantA, "chk/originals/second.png")).rejects.toThrow(
      /media_tenant_checksum_idx/,
    );
  });

  it("still refuses it when the first row is soft-deleted", async () => {
    // Deliberately NOT partial on `deleted_at IS NULL`. The upload route
    // depends on a re-upload of a deleted file colliding so it can
    // revive that row rather than growing a second one; a partial index
    // would let the second row through and strand the first.
    await insertMedia(tenantB, "chk/originals/gone.jpg", { deleted: true });

    await expect(insertMedia(tenantB, "chk/originals/back.png")).rejects.toThrow(
      /media_tenant_checksum_idx/,
    );
  });

  it("lets a different tenant upload the identical file", async () => {
    // Two merchants uploading the same stock photograph is normal, and
    // an index missing its tenant_id leading column would block the
    // second one — cross-tenant coupling with no error message that
    // says so.
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM media
       WHERE tenant_id IN (${tenantA}, ${tenantB}) AND checksum = ${CHECKSUM}`;

    expect(rows[0]?.n).toBe(2);
  });

  it("allows any number of rows with no checksum yet", async () => {
    // Nullable, and NULLs are distinct under a unique index. A row can
    // exist before its bytes are hashed; that must not be a collision.
    await insertMedia(tenantA, "chk/originals/unhashed-1.jpg", { checksum: null });
    await insertMedia(tenantA, "chk/originals/unhashed-2.jpg", { checksum: null });

    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM media
       WHERE tenant_id = ${tenantA} AND checksum IS NULL`;

    expect(rows[0]?.n).toBe(2);
  });
});
