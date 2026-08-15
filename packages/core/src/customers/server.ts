import type { Tx } from "@platform/db";

/**
 * Customers — SERVER barrel (no pure barrel: guest checkout has no
 * client-side customer surface in Phase 2). S0 SCHEMA SPINE: signatures
 * FROZEN; bodies implemented by lot B4.
 */

/**
 * Get-or-create the lean buyer row by phone inside the CALLER's checkout
 * tx (race-safe on customers_tenant_phone_key), refreshing last-seen
 * name/email. `firstOrderAt === null` is what the `first_order`
 * promotion condition evaluates.
 */
export async function upsertCustomerByPhone(
  _tx: Tx,
  _tenantId: string,
  _input: { phoneE164: string; name?: string | null; email?: string | null },
): Promise<{ customerId: string; firstOrderAt: Date | null }> {
  throw new Error("S0 stub: implemented by lot B4");
}

/** Sets first_order_at once (WHERE first_order_at IS NULL), inside the confirming tx. */
export async function markFirstOrder(
  _tx: Tx,
  _tenantId: string,
  _customerId: string,
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B4");
}

export type CustomerListRow = {
  id: string;
  name: string | null;
  phoneE164: string;
  email: string | null;
  firstOrderAt: Date | null;
  /** Aggregate query, not a projection column (design D14). */
  orderCount: number;
};

export async function listCustomers(
  _tenantId: string,
  _opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: CustomerListRow[]; total: number }> {
  throw new Error("S0 stub: implemented by lot B4");
}
