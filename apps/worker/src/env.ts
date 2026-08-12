import { resolve } from "node:path";

import { config } from "dotenv";

/**
 * Loads `.env` before anything else in this process reads it.
 *
 * This is its own module for one reason: ES module imports are evaluated
 * before the importing module's own body runs. Calling `config()` in
 * `index.ts` therefore happened AFTER `queues.ts` had already read
 * `process.env.REDIS_URL` and built its client — so the worker silently
 * fell back to `redis://localhost:6379` and retried a port nothing is
 * listening on, forever, logging an empty error string.
 *
 * `import "./env"` as the FIRST import of the entrypoint is what fixes
 * that, and it only works while it stays first.
 */
config({ path: resolve(import.meta.dirname, "../../../.env") });
