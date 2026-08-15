import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "./schema/index";

/**
 * Row Level Security policy generation.
 *
 * Policies are DERIVED FROM THE SCHEMA, never hand-written. Hand-written
 * policies drift: someone adds a table, forgets the policy, and the leak
 * is invisible until a customer finds it. Here, a table with a tenant_id
 * column gets a policy automatically, and a table without one must be
 * explicitly justified in PLATFORM_TABLES below or CI fails.
 *
 * See PLATFORM_BLUEPRINT.md §2.1 and §7.4.
 */

export const TENANT_COLUMN = "tenant_id";
export const TENANT_SETTING = "app.tenant_id";

/**
 * Tables that legitimately have no tenant_id, each with the reason.
 *
 * Adding an entry here is a security decision. It should be reviewed
 * like one. The isolation suite fails if a table is neither
 * RLS-protected nor listed here, so the only way to skip RLS is to
 * write down why.
 */
export const PLATFORM_TABLES: Record<string, string> = {
  plans:
    "Platform catalogue of subscription plans. Identical for all tenants; no tenant data.",
  tenants:
    "The tenant registry itself. Cannot be filtered by app.tenant_id — it is what defines it.",
  domains:
    "Hostname → tenant lookup runs BEFORE tenant context exists, on every storefront request. " +
    "Contains no customer or business data; worst-case exposure is the list of hostnames we serve. " +
    "All tenant-facing reads/writes go through domainsForTenant() which filters explicitly.",
  users:
    "Identity is global by design so one person can staff several stores. Membership, not identity, is tenant-scoped.",
  tenant_members:
    "The tenancy control plane. Login must ask 'which tenants may this user enter?' before a tenant is chosen.",
  sessions:
    "Session lookup by token hash happens before we know which tenant the request is for.",
  otp_challenges:
    "Keyed by phone number during login, before any tenant is established.",

  // Drizzle's migration bookkeeping. Not ours to police.
  __drizzle_migrations: "Drizzle migration journal.",
};

/** Every Drizzle table in the schema, with its physical name and columns. */
export function allTables(): { name: string; columns: string[] }[] {
  // The schema barrel also exports enum tuples, so widen to unknown
  // before narrowing to PgTable — otherwise the predicate has to be
  // assignable to a union that includes those arrays.
  const exported: unknown[] = Object.values(schema);

  return exported
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return { name: cfg.name, columns: cfg.columns.map((c) => c.name) };
    });
}

/**
 * Tables that must be RLS-protected: everything not explicitly excused.
 *
 * Note the direction. Membership is decided by the PLATFORM_TABLES
 * allowlist, NOT by "does it have a tenant_id column". Several
 * control-plane tables (domains, sessions, tenant_members) do carry
 * tenant_id but are queried before tenant context exists — during
 * hostname resolution and login — so a policy on them would make the
 * platform unable to log anyone in. Deriving from the column would
 * silently re-add those policies every migration.
 *
 * Default-deny: a new table is tenant-scoped unless someone writes down
 * why it is not.
 */
export function tenantScopedTableNames(): string[] {
  return allTables()
    .filter((t) => !(t.name in PLATFORM_TABLES))
    .map((t) => t.name)
    .sort();
}

/**
 * Tables that must be RLS-protected but have no tenant_id to key on.
 * This is always a mistake — either add the column or justify the table
 * in PLATFORM_TABLES.
 */
export function tablesMissingTenantColumn(): string[] {
  return allTables()
    .filter((t) => !(t.name in PLATFORM_TABLES) && !t.columns.includes(TENANT_COLUMN))
    .map((t) => t.name)
    .sort();
}

/**
 * SQL to enforce isolation on one table.
 *
 * FORCE ROW LEVEL SECURITY is the line people miss. Plain ENABLE is
 * silently bypassed whenever the connecting role owns the table, which
 * is the default in most setups — and the reason RLS so often appears
 * to "do nothing". We connect as app_user (owns nothing) AND force the
 * policy, so both layers have to fail before data leaks.
 *
 * The NULLIF is not cosmetic — it is what makes the policy fail closed.
 *
 * `current_setting(name, true)` returns NULL only while the GUC has
 * never existed. The first `set_config` in a session creates a
 * placeholder, so once ANY transaction on that pooled backend has set a
 * tenant, later transactions that set none read back an EMPTY STRING
 * rather than NULL. Casting '' to uuid raises 22P02, so without NULLIF
 * every context-less query errors instead of returning nothing — and
 * under PgBouncer that starts happening only after the pool warms up,
 * which is a spectacularly confusing production-only failure.
 *
 * With NULLIF, the comparison becomes `tenant_id = NULL` → NULL → row
 * filtered. No context, no rows, no error.
 */
export function rlsStatementsFor(table: string): string[] {
  const t = `"${table}"`;
  const ctx = `NULLIF(current_setting('${TENANT_SETTING}', true), '')::uuid`;
  return [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS tenant_isolation ON ${t};`,
    `CREATE POLICY tenant_isolation ON ${t}
       USING (${TENANT_COLUMN} = ${ctx})
       WITH CHECK (${TENANT_COLUMN} = ${ctx});`,
  ];
}

/**
 * Grants for the application role.
 *
 * audit_log gets INSERT and SELECT only. Append-only is enforced by the
 * absence of an UPDATE/DELETE grant rather than by developer discipline,
 * because an audit trail an application can rewrite is not an audit trail.
 */
export function grantStatements(appRole: string): string[] {
  const tables = allTables().map((t) => t.name);
  // An audit trail — or a stock ledger — the application can rewrite is
  // neither. Both are append-only by ABSENT GRANT, not by discipline.
  const appendOnly = new Set(["audit_log", "stock_movements"]);

  const stmts = [
    `GRANT USAGE ON SCHEMA public TO ${appRole};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
  ];

  for (const table of tables) {
    const privs = appendOnly.has(table)
      ? "SELECT, INSERT"
      : "SELECT, INSERT, UPDATE, DELETE";
    stmts.push(`REVOKE ALL ON "${table}" FROM ${appRole};`);
    stmts.push(`GRANT ${privs} ON "${table}" TO ${appRole};`);
  }

  return stmts;
}

/**
 * Statements that remove isolation from a table.
 *
 * Emitted for PLATFORM_TABLES so that moving a table into the allowlist
 * actually takes effect. Without this, a policy applied by an earlier
 * migration would linger forever and quietly break the control plane.
 */
export function platformTableStatementsFor(table: string): string[] {
  const t = `"${table}"`;
  return [
    `DROP POLICY IF EXISTS tenant_isolation ON ${t};`,
    `ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
  ];
}

/** Full idempotent policy + grant script, applied after every migration. */
export function buildRlsScript(appRole: string): string {
  const missing = tablesMissingTenantColumn();
  if (missing.length) {
    throw new Error(
      `Table(s) [${missing.join(", ")}] have no ${TENANT_COLUMN} column and are not listed ` +
        `in PLATFORM_TABLES. Add the column, or add a written justification to ` +
        `packages/db/src/rls.ts. Refusing to generate policies.`,
    );
  }

  const lines: string[] = [
    "-- GENERATED by packages/db/src/rls.ts — do not edit by hand.",
    "-- Re-applied idempotently on every migration run.",
    "",
  ];

  for (const table of tenantScopedTableNames()) {
    lines.push(`-- ${table} (tenant-scoped)`, ...rlsStatementsFor(table), "");
  }

  const platform = allTables()
    .map((t) => t.name)
    .filter((name) => name in PLATFORM_TABLES)
    .sort();

  for (const table of platform) {
    lines.push(`-- ${table} (control plane, justified)`, ...platformTableStatementsFor(table), "");
  }

  lines.push("-- grants", ...grantStatements(appRole), "");
  return lines.join("\n");
}
