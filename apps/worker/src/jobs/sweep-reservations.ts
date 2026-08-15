import { sql, stockReservations, tenants, withPlatform, withTenant } from "@platform/db";

/**
 * Reservation GC — HYGIENE ONLY. An expired hold already counts nowhere
 * (every reader filters expires_at > now(), and holdStock sweeps its own
 * variant opportunistically); this job just keeps abandoned-checkout
 * rows from accumulating. Nothing breaks if it never runs.
 *
 * It iterates tenants because it must: a cross-tenant DELETE on the app
 * role silently matches ZERO rows — FORCE RLS with no tenant context
 * returns nothing rather than erroring. The grace day keeps rows
 * around long enough that a slow payment's consumeStock can still
 * report `unheld` honestly and a human can inspect yesterday's holds.
 */
export async function sweepReservations(): Promise<{ tenantsSwept: number; deleted: number }> {
  const tenantRows = await withPlatform((tx) => tx.select({ id: tenants.id }).from(tenants));

  let deleted = 0;
  for (const tenant of tenantRows) {
    const gone = await withTenant(tenant.id, (tx) =>
      tx
        .delete(stockReservations)
        .where(sql`${stockReservations.expiresAt} <= now() - interval '1 day'`)
        .returning({ id: stockReservations.id }),
    );
    deleted += gone.length;
  }
  return { tenantsSwept: tenantRows.length, deleted };
}
