import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { buildRlsScript, tenantScopedTableNames } from "../src/rls";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const APP_ROLE = process.env.DB_APP_ROLE ?? "app_user";

/**
 * Migration runner.
 *
 * Order matters: schema first, then policies and grants. The RLS script
 * is regenerated from the schema and re-applied on EVERY run, which is
 * what makes "someone added a table and forgot the policy" impossible
 * rather than merely discouraged.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) throw new Error("DATABASE_URL_MIGRATOR is not set");

  /**
   * NOTICE is noise here — every `DROP POLICY IF EXISTS` in the RLS
   * script emits one on every run — but anything louder is a migration
   * telling you what it did to your data, and swallowing that is how a
   * destructive step goes unnoticed. Only NOTICE and below is dropped.
   */
  const quiet = new Set(["DEBUG", "LOG", "INFO", "NOTICE"]);
  const sql = postgres(url, {
    max: 1,
    onnotice: (notice) => {
      if (!quiet.has(notice.severity ?? "NOTICE")) {
        console.warn(`  ! ${notice.severity}: ${notice.message}`);
      }
    },
  });

  try {
    if (!existsSync(MIGRATIONS_DIR)) {
      console.error(
        `\n  No migrations found at ${MIGRATIONS_DIR}\n` +
          `  Run \`pnpm db:generate\` first to create the initial migration.\n`,
      );
      process.exit(1);
    }

    console.log("→ Applying schema migrations…");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

    const scoped = tenantScopedTableNames();
    console.log(`→ Applying RLS to ${scoped.length} tenant-scoped table(s):`);
    for (const t of scoped) console.log(`    · ${t}`);

    // Single statement so a failure rolls the whole policy set back
    // rather than leaving half the tables unprotected.
    await sql.unsafe(`BEGIN;\n${buildRlsScript(APP_ROLE)}\nCOMMIT;`);

    console.log(`→ Grants issued to role "${APP_ROLE}".`);
    console.log("\n✔ Migration complete.\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error("\n✖ Migration failed:\n", err);
  process.exit(1);
});
