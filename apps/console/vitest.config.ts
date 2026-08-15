import { defineConfig } from "vitest/config";

/**
 * Unit tests. No database, no Redis — pure form/display logic (money
 * parsing, settlement arithmetic) that costs real money when it drifts.
 *
 * Integration tests live alongside them as `*.integration.test.ts` and
 * are excluded here; see vitest.integration.config.ts.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts", "**/node_modules/**"],
  },
});
