import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env") });

/**
 * Tests that need Postgres.
 *
 * The catalog query layer is mostly SQL — including several correlated
 * subqueries and a UNION that `tsc` is perfectly happy with and the
 * database may not be. Only a real connection proves those work.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
