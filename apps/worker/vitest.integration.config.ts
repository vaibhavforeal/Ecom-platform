import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env") });

/**
 * Worker jobs against real infrastructure.
 *
 * There is nothing worth unit-testing in a job handler: the logic that
 * can be tested in isolation lives in @platform/core, and what is left
 * is Postgres, object storage and libvips. Mocking those three would
 * test the mocks.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    // Encoding eighteen derivatives with libvips is genuinely slow.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
