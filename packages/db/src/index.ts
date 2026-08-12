/**
 * Public surface of @platform/db.
 *
 * Note what is NOT here: the Drizzle client itself. Callers get
 * withTenant / withPlatform and nothing else, so there is no way to
 * issue a query without deciding, explicitly, which context it runs in.
 */

export * from "./schema/index";
export * from "./tenant-scope";
export {
  PLATFORM_TABLES,
  TENANT_COLUMN,
  TENANT_SETTING,
  allTables,
  tenantScopedTableNames,
} from "./rls";
export { closeConnections } from "./client";

export { sql, eq, and, or, not, isNull, isNotNull, inArray, desc, asc, gt, gte, lt, lte } from "drizzle-orm";
