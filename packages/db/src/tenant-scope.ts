import { sql } from "drizzle-orm";

import { getAppDb } from "./client";
import type { Tx } from "./client";
import { TENANT_SETTING } from "./rls";

export type { Tx };

/**
 * The only sanctioned way to touch tenant data.
 *
 * Everything about this file is about making the *safe* thing the *only*
 * thing. The raw client is unexported; this module is the public door.
 *
 * See PLATFORM_BLUEPRINT.md §2.2.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(value: unknown) {
    super(`Invalid tenant id: ${JSON.stringify(value)}`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Run `fn` with PostgreSQL-enforced isolation to a single tenant.
 *
 * Three things make this safe, and all three are load-bearing:
 *
 *  1. `set_config(..., is_local => true)` is TRANSACTION-scoped. A
 *     session-level `SET` would survive the request and leak tenant
 *     context to whichever request next borrows that pooled connection.
 *     That bug is intermittent, unreproducible in dev, and catastrophic.
 *     There is no situation in this codebase where a session-level SET
 *     of app.tenant_id is correct.
 *
 *  2. The tenant id is BOUND as a parameter, never interpolated, so a
 *     hostile value cannot become SQL.
 *
 *  3. It is validated as a UUID first, so a malformed id fails loudly
 *     here rather than as an opaque cast error deep inside a policy.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  return getAppDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config(${TENANT_SETTING}, ${tenantId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` against control-plane tables (tenants, domains, users,
 * sessions, tenant_members) which have no RLS policy because they are
 * queried before a tenant is known.
 *
 * This does NOT elevate privileges — it uses the same unprivileged
 * app_user role. Any RLS-protected table touched in here returns zero
 * rows, by design: this is not an escape hatch out of tenant isolation,
 * and if you find yourself wanting it to be, you want withTenant().
 */
export async function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getAppDb().transaction(async (tx) => fn(tx));
}

/** Reads back the active tenant context. Used by the isolation suite. */
export async function currentTenantContext(tx: Tx): Promise<string | null> {
  const rows = await tx.execute<{ tenant: string | null }>(
    sql`SELECT current_setting(${TENANT_SETTING}, true) AS tenant`,
  );
  const first = (rows as unknown as { tenant: string | null }[])[0];
  return first?.tenant ?? null;
}
