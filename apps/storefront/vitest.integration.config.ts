import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env") });

/**
 * The purge endpoint against a real Next data cache and real PostgreSQL.
 *
 * These tests are the only ones in the repo that can tell the difference
 * between "the endpoint answered 200" and "the cache was actually
 * emptied", so they build a real `IncrementalCache`, populate it through
 * the same `unstable_cache` wrappers the pages use, and then check what
 * comes back. See `tests/next-cache-harness.ts`.
 *
 * `fileParallelism: false` because that cache — and Next's tag manifest
 * behind it — are process-global.
 */
export default defineConfig({
  // `tsconfig.json` sets `jsx: preserve`, because Next owns that
  // transform in a real build. Vitest has no such step, so a component
  // rendered in a test would compile to the classic `React.createElement`
  // and fail on a `React` that App Router files never import. The
  // automatic runtime is what Next itself uses.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
