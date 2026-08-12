import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { tenantTagPrefix } from "@platform/core/catalog";

import { isAuthorisedInternalRequest } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
// `revalidateTag` and the incremental cache behind it are Node-only.
export const runtime = "nodejs";

/**
 * Storefront cache purge, called by the console after a catalog write.
 *
 * WHY THIS ENDPOINT EXISTS
 *
 * `revalidateTag` clears the cache of the process that calls it and
 * nothing else — Next's tag manifest is a module-level Map. The console
 * and the storefront are separate Next apps in separate containers, so
 * the console cannot purge this cache from its own process however it
 * calls the function. It has to ask, over HTTP, and this is the ear.
 *
 * WHAT IT REFUSES, AND IN WHAT ORDER
 *
 *  1. **No valid secret → 403 before the body is read.** Same secret and
 *     same header as the console's `/api/internal/verify-domain`, and
 *     the same empty-bodied refusal: a prober learns nothing, and an
 *     unauthenticated caller cannot make this endpoint do any work at
 *     all — which is what keeps it from being a cache-stampede lever.
 *     Note that verify-domain skips its check when no secret is set;
 *     this one does the opposite and refuses everyone. See
 *     `lib/internal-auth`.
 *
 *  2. **Every tag must be scoped to the tenant named in the body.**
 *     Tenant scoping does not stop at the database. Without this, one
 *     tenant's purge — or a console bug, or the secret leaking — could
 *     empty every merchant's cache at once and stampede the database
 *     with the refills. Refused as a set rather than filtered: a request
 *     carrying a foreign tag is a bug or an attack, and purging the
 *     valid half of it would hide that.
 *
 * The body is read only for a caller that has already presented the
 * secret, and the tag count is capped, so the work an authenticated
 * request can ask for is bounded.
 */

/**
 * Enough for any write this repo makes — a product write sends four
 * tags, a taxonomy or bulk write three — and small enough that a single
 * request cannot ask for an unbounded amount of work.
 */
const MAX_TAGS = 64;

/**
 * Expire the tag NOW. **A named `cacheLife` profile here would break
 * this endpoint**, so do not "simplify" it to one.
 *
 * Next 16 made `revalidateTag`'s second argument mandatory — the
 * one-argument call this endpoint used on Next 15 is a type error now,
 * and at runtime it logs a deprecation notice recommending `"max"` or
 * `updateTag`. Both of those recommendations are wrong here.
 *
 * `FileSystemCache.revalidateTag` writes the two forms differently:
 *
 *  - `{ expire: 0 }` → `{ stale: now, expired: now }`
 *  - a profile, e.g. `"max"` → `{ stale: now, expired: now + expire }`,
 *    a YEAR out for `max`
 *
 * and only `expired` is a purge. `IncrementalCache.get` drops a
 * FETCH-kind entry — which is what `unstable_cache` stores — solely on
 * `areTagsExpired`; `areTagsStale` merely sets `isStale`. On a DYNAMIC
 * render (`isStaticGeneration: false`, which is every render this
 * storefront does, because every route is `force-dynamic`)
 * `unstable_cache` hands a stale entry BACK TO THE CALLER unchanged and
 * refreshes it in the background. So a profile purge answers 200 and the
 * very next visitor is still served the old page — precisely the symptom
 * this endpoint exists to remove.
 *
 * Measured, same tag, three consecutive write-then-purge rounds, reads
 * inside a work store:
 *
 *     { expire: 0 }   →  Title 1 | Title 2 | Title 3   (correct)
 *     "max"           →  Title 0 | Title 1 | Title 2   (one behind, always)
 *     { expire: 60 }  →  Title 0 | Title 1 | Title 2   (one behind, always)
 *
 * The same reads taken OUTSIDE a work store show all three as correct,
 * because that branch recomputes a stale entry synchronously. That is a
 * trap for tests, not a defence — see `runDynamicRender` in
 * `tests/next-cache-harness.ts`, which the regression test uses.
 *
 * `{ expire: 0 }` is not quite what the one-argument call used to do: it
 * also sets `stale`, where the old form set only `expired`. Strictly
 * more aggressive, which is the safe direction for a purge.
 *
 * `updateTag` is the other immediate-expiry API and cannot be used here:
 * it throws outside a Server Action, and this is a route handler by
 * necessity — the caller is another app, over HTTP.
 */
const IMMEDIATE = { expire: 0 } as const;

type PurgeRequest = { tenantId: string; tags: string[] };

function parsePurgeRequest(body: unknown): PurgeRequest | null {
  if (typeof body !== "object" || body === null) return null;

  const { tenantId, tags } = body as Record<string, unknown>;
  if (typeof tenantId !== "string" || tenantId === "") return null;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > MAX_TAGS) return null;
  if (!tags.every((tag): tag is string => typeof tag === "string" && tag !== "")) return null;

  return { tenantId, tags };
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isAuthorisedInternalRequest(req)) {
    return new NextResponse(null, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_json" } }, { status: 400 });
  }

  const parsed = parsePurgeRequest(body);
  if (parsed === null) {
    return NextResponse.json({ error: { code: "invalid_payload" } }, { status: 400 });
  }

  const prefix = tenantTagPrefix(parsed.tenantId);
  const foreign = parsed.tags.filter((tag) => !tag.startsWith(prefix));
  if (foreign.length > 0) {
    // Worth a log line: the only way to reach this is a console bug or
    // a caller that should not have the secret.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "cache.purge_refused",
        tenantId: parsed.tenantId,
        tags: foreign,
      }),
    );
    return NextResponse.json({ error: { code: "tag_outside_tenant" } }, { status: 400 });
  }

  for (const tag of parsed.tags) revalidateTag(tag, IMMEDIATE);

  return NextResponse.json({ purged: parsed.tags.length });
}
