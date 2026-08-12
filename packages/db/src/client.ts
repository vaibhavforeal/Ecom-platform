import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema/index";

/**
 * PRIVATE. Do not import this module outside packages/db.
 *
 * An ESLint `no-restricted-imports` rule (packages/config/eslint/base.js)
 * blocks it, because a raw handle is a handle with no tenant context —
 * exactly the mistake RLS exists to prevent. Use withTenant() or
 * withPlatform() from the package index instead.
 */

export type AppDatabase = PostgresJsDatabase<typeof schema>;

/** The transaction handle Drizzle hands to a transaction callback. */
export type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let appSql: postgres.Sql | undefined;
let appDb: AppDatabase | undefined;

/**
 * Connections are opened lazily, on first query — never at import time.
 *
 * Importing this package must stay free: consumers routinely want only
 * the schema types or the role enums, and unit tests that touch no
 * database should not need a DATABASE_URL to run. An eager pool here
 * makes `import type { Role }` fail at module load, which is both
 * surprising and quietly corrosive to test hygiene.
 */
export function getAppDb(): AppDatabase {
  if (!appDb) {
    // PgBouncer in transaction pooling mode does not support prepared
    // statements across connections, so `prepare: false` is mandatory.
    // Without it you get intermittent "prepared statement already
    // exists" errors that only appear under concurrency — i.e. in
    // production.
    appSql = postgres(required("DATABASE_URL_APP"), {
      prepare: false,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    appDb = drizzle(appSql, { schema });
  }
  return appDb;
}

/**
 * Migrator connection: owns the schema, has BYPASSRLS. Also lazy, and
 * deliberately separate — a normal application process must never open it.
 */
let migratorSql: postgres.Sql | undefined;

export function getMigratorSql(): postgres.Sql {
  migratorSql ??= postgres(required("DATABASE_URL_MIGRATOR"), {
    max: 1,
    onnotice: () => {},
  });
  return migratorSql;
}

export async function closeConnections(): Promise<void> {
  if (appSql) {
    await appSql.end({ timeout: 5 });
    appSql = undefined;
    appDb = undefined;
  }
  if (migratorSql) {
    await migratorSql.end({ timeout: 5 });
    migratorSql = undefined;
  }
}
