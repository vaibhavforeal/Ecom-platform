import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The isolation suite asserts on connection-pool behaviour, so the
    // files must share one pool rather than run in parallel workers.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
