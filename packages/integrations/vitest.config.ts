import { defineConfig } from "vitest/config";

/**
 * unstubEnvs matters here: storage/index.test.ts drives getStorage()
 * entirely through vi.stubEnv, and without automatic unstubbing each
 * test inherits the previous test's environment — one test already
 * re-stubbed four vars to undo a leak before this config existed.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    unstubEnvs: true,
  },
});
