/**
 * Runs once when the server boots.
 *
 * This exists for a single check: that `INTERNAL_API_SECRET` is set.
 * Without it the purge endpoint refuses every caller, so catalog edits
 * sit stale until the TTL — the exact bug the endpoint was added to fix,
 * back again and invisible. Better to not start.
 *
 * The import is dynamic and behind the runtime guard because
 * `internal-auth` uses `node:crypto`, which the edge runtime has no
 * implementation of. Next compiles this file for every runtime it
 * builds; a static import would put `node:crypto` in the edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertInternalSecretConfigured } = await import("./lib/internal-auth");
  assertInternalSecretConfigured();
}
