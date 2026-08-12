import { defineConfig } from "vitest/config";

/**
 * Unit tests. No database, no Redis — these run anywhere, including on a
 * machine with Docker stopped, which is what keeps them cheap enough to
 * run on every save.
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
