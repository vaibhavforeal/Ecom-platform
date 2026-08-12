import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "vitest/config";

config({ path: resolve(import.meta.dirname, "../../.env") });

/**
 * Route handlers against real infrastructure.
 *
 * The upload route holds the highest-value security properties in the
 * app — tenant from the session, 401 before any work, magic-byte
 * rejection, EXIF stripping before storage — and every one of them is a
 * single careless edit from silently regressing. These call the exported
 * `POST` with a constructed `Request`; only `next/headers`, which needs
 * a server request context that does not exist outside Next, is stubbed.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
