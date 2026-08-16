import {
  and,
  customers,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  not,
  or,
  orders,
  sql,
  withTenant,
} from "@platform/db";
import type { Tx } from "@platform/db";

import { AppError } from "../errors";

/**
 * Customers — SERVER barrel (no pure barrel: guest checkout has no
 * client-side customer surface in Phase 2). S0 SCHEMA SPINE: signatures
 * FROZEN; bodies implemented by lot B4.
 */

/** Mirrors the customers_phone_e164_check CHECK (same regex as users). */
const PHONE_E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Get-or-create the lean buyer row by phone inside the CALLER's checkout
 * tx (race-safe on customers_tenant_phone_key), refreshing last-seen
 * name/email. `firstOrderAt === null` is what the `first_order`
 * promotion condition evaluates.
 */
export async function upsertCustomerByPhone(
  tx: Tx,
  tenantId: string,
  input: { phoneE164: string; name?: string | null; email?: string | null },
): Promise<{ customerId: string; firstOrderAt: Date | null }> {
  if (typeof input.phoneE164 !== "string" || !PHONE_E164_RE.test(input.phoneE164)) {
    // Caught here rather than as an opaque 23514 from the CHECK.
    throw new AppError({
      code: "invalid_payload",
      message: `Phone ${JSON.stringify(input.phoneE164)} is not E.164`,
      status: 422,
      publicMessage: "Enter a valid phone number.",
      details: { issues: [{ path: "phone", message: "Enter a valid phone number (+91…)." }] },
    });
  }

  const name = input.name?.trim() || null;
  const email = input.email?.trim() || null;

  // ON CONFLICT is the race guard: two concurrent first checkouts for the
  // same phone serialize on customers_tenant_phone_key rather than racing
  // a SELECT-then-INSERT. NULL inputs never erase a previously seen
  // name/email — "last seen", not "last request".
  const [row] = await tx
    .insert(customers)
    .values({ tenantId, phoneE164: input.phoneE164, name, email })
    .onConflictDoUpdate({
      target: [customers.tenantId, customers.phoneE164],
      set: {
        name: sql`coalesce(${name}, ${customers.name})`,
        email: sql`coalesce(${email}, ${customers.email})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ customerId: customers.id, firstOrderAt: customers.firstOrderAt });

  if (!row) {
    // FORCE RLS matches zero rows silently when tenant context is absent
    // — fail loudly rather than return a phantom customer.
    throw new Error("customers upsert returned no row — is the transaction missing tenant context?");
  }
  return row;
}

/** Sets first_order_at once (WHERE first_order_at IS NULL), inside the confirming tx. */
export async function markFirstOrder(
  tx: Tx,
  tenantId: string,
  customerId: string,
): Promise<void> {
  await tx
    .update(customers)
    .set({ firstOrderAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId),
        isNull(customers.firstOrderAt),
      ),
    );
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

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

/** ILIKE pattern with the user's %/_ made literal. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export async function listCustomers(
  tenantId: string,
  opts: { q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: CustomerListRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim();

  return withTenant(tenantId, async (tx) => {
    const filters = [eq(customers.tenantId, tenantId), isNull(customers.deletedAt)];
    if (q) {
      const pattern = likePattern(q);
      filters.push(
        or(
          ilike(customers.name, pattern),
          ilike(customers.phoneE164, pattern),
          ilike(customers.email, pattern),
        )!,
      );
    }
    const where = and(...filters);

    // Order count is a JOIN + GROUP BY aggregate, never a correlated
    // SELECT-list subquery (the unqualified-column trap) and never a
    // projection column (D14). Abandoned and cancelled orders are not
    // "orders" to a merchant scanning this list; a pending_payment order
    // still counts — it is a live claim.
    const [items, [totalRow]] = await Promise.all([
      tx
        .select({
          id: customers.id,
          name: customers.name,
          phoneE164: customers.phoneE164,
          email: customers.email,
          firstOrderAt: customers.firstOrderAt,
          orderCount: sql<number>`count(${orders.id})::int`.as("order_count"),
        })
        .from(customers)
        .leftJoin(
          orders,
          and(
            eq(orders.tenantId, tenantId),
            eq(orders.customerId, customers.id),
            not(inArray(orders.status, ["abandoned", "cancelled"])),
          ),
        )
        .where(where)
        .groupBy(customers.id)
        .orderBy(desc(customers.createdAt))
        .limit(limit)
        .offset(offset),
      tx.select({ total: sql<number>`count(*)::int`.as("total") }).from(customers).where(where),
    ]);

    return { items, total: totalRow?.total ?? 0 };
  });
}
