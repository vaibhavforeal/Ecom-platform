import { expireCheckout } from "@platform/core/checkout/server";
import { and, eq, orders, sql, tenants, withPlatform, withTenant } from "@platform/db";

/**
 * Abandoned-checkout sweep — the D10 BACKSTOP (the delayed
 * checkout.expire job is the precision driver; a lost enqueue is
 * survivable ONLY because this exists).
 *
 * It iterates tenants because it must: a cross-tenant query on the app
 * role silently matches ZERO rows under FORCE RLS. Candidates are
 * selected FOR UPDATE SKIP LOCKED so the sweep never queues behind an
 * in-flight webhook confirm, with a 5-minute grace past expires_at so a
 * capture racing the boundary wins (§4.6). Expiry itself goes through
 * the ONE door (expireCheckout), which re-checks under its own lock —
 * an order confirmed between selection and expiry reads already_final.
 */

const GRACE = sql`now() - interval '5 minutes'`;
const BATCH_PER_TENANT = 200;

export async function sweepCheckouts(): Promise<{
  tenantsSwept: number;
  abandoned: number;
  skipped: number;
}> {
  const tenantRows = await withPlatform((tx) => tx.select({ id: tenants.id }).from(tenants));

  let abandoned = 0;
  let skipped = 0;
  for (const tenant of tenantRows) {
    // Selection tx: SKIP LOCKED filters out rows an in-flight confirm
    // holds; the locks this SELECT takes release at its own commit.
    const candidates = await withTenant(tenant.id, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenant.id),
            eq(orders.status, "pending_payment"),
            sql`${orders.expiresAt} < ${GRACE}`,
          ),
        )
        .limit(BATCH_PER_TENANT)
        .for("update", { skipLocked: true }),
    );

    for (const candidate of candidates) {
      const { outcome } = await expireCheckout({ tenantId: tenant.id }, candidate.id);
      if (outcome === "abandoned") abandoned += 1;
      else skipped += 1;
    }
  }

  return { tenantsSwept: tenantRows.length, abandoned, skipped };
}
