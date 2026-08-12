/**
 * Telling the storefront to drop what it cached. SERVER ONLY.
 *
 * `revalidateTag` clears the cache of the PROCESS that calls it and
 * nothing else — Next's tag manifest is a module-level Map, per
 * instance. The console and the storefront are separate Next apps in
 * separate containers, so a `revalidateTag` in the console purges the
 * console's (empty) cache and leaves the storefront serving the old
 * title, the old price and the old redirect until the 300s TTL lapses.
 * This module is the console's way to reach across that boundary: a POST
 * to the storefront's internal purge endpoint, authenticated with the
 * shared secret that already guards `/api/internal/verify-domain`.
 *
 * TWO RULES, BOTH LEARNED THE EXPENSIVE WAY ELSEWHERE
 *
 *  1. **Called after the transaction commits, never inside it.** Every
 *     caller in `writes.ts` and `bulk.ts` awaits its `withTenant` first.
 *     A purge issued mid-transaction can race a storefront reader into
 *     re-caching the PRE-commit row, and that entry then survives its
 *     full TTL — strictly worse than the stale cache it was meant to
 *     fix, because it is stale with a fresh timestamp.
 *
 *  2. **A failed purge must never fail the merchant's write.** The row
 *     is committed and correct; the only casualty is a cache that goes
 *     stale for at most the TTL, which is exactly the backstop the TTL
 *     exists to be. So nothing in here throws — not a refused
 *     connection, not a 500, not a timeout, not a DNS failure. It logs
 *     and returns.
 */

/**
 * How long a purge may hold up the merchant's save.
 *
 * Short on purpose. This is awaited inside the write path, so it is
 * latency a merchant feels on every save; a storefront that is wedged
 * rather than down must not turn a one-second save into a thirty-second
 * one. Two seconds is far more than a same-network POST that does no
 * I/O needs, and the TTL covers whatever falls off the end.
 */
export const PURGE_TIMEOUT_MS = 2_000;

/** Where the internal purge endpoint lives on the storefront. */
const PURGE_PATH = "/api/internal/revalidate";

function warn(event: string, tenantId: string, detail: Record<string, unknown>): void {
  console.warn(JSON.stringify({ level: "warn", event, tenantId, ...detail }));
}

/**
 * Asks the storefront to purge `tags` for one tenant. Never throws.
 *
 * The environment is read per call rather than at module load: the
 * console's integration tests point this at a stub server and at a dead
 * port in the same process, and a module-level read would freeze
 * whichever they happened to import first.
 */
export async function purgeStorefrontCache(
  tenantId: string,
  tags: readonly string[],
): Promise<void> {
  if (tags.length === 0) return;

  const origin = process.env.STOREFRONT_INTERNAL_ORIGIN;
  const secret = process.env.INTERNAL_API_SECRET;

  // Loud rather than silent. An unset variable here means every catalog
  // edit on this deployment waits out the TTL, which looks exactly like
  // the bug this endpoint was built to fix — so it says so on every
  // write instead of being invisible.
  if (!origin || !secret) {
    warn("cache.purge_unconfigured", tenantId, {
      missing: !origin ? "STOREFRONT_INTERNAL_ORIGIN" : "INTERNAL_API_SECRET",
    });
    return;
  }

  try {
    const response = await fetch(new URL(PURGE_PATH, origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ tenantId, tags }),
      // No `cache: "no-store"`. Next patches `fetch` inside a route
      // handler, but it treats any method outside GET/HEAD as
      // uncacheable and sets `autoNoCache` itself, so a POST is never
      // served from the fetch cache — and `cache` is not in Node's own
      // `RequestInit`, so naming it here would only be a type error.
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    });

    if (!response.ok) {
      warn("cache.purge_failed", tenantId, { status: response.status, tags: tags.length });
    }
  } catch (err) {
    // Refused connection, DNS failure, timeout, a malformed
    // STOREFRONT_INTERNAL_ORIGIN that makes `new URL` throw — all of it
    // ends here, and none of it reaches the merchant.
    warn("cache.purge_failed", tenantId, { error: String(err), tags: tags.length });
  }
}
