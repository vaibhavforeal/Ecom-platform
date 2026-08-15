-- Hand-written data migration (no schema change; drizzle-kit generate has
-- nothing to diff). Backfills the low-stock threshold onto variants that
-- were tracked before the write layer began seeding it: a null threshold
-- means "never low", so these rows were invisible to /inventory?low=1 —
-- including any sitting at zero. New writes seed DEFAULT_LOW_STOCK_AT (2,
-- @platform/core/inventory) at the write layer; this catches the rows that
-- predate that rule. Runs under app_migrator (BYPASSRLS), so it sees every
-- tenant's rows — which is the point.
UPDATE product_variants
SET low_stock_at = 2
WHERE tracks_inventory = true AND low_stock_at IS NULL;
