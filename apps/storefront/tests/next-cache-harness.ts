import { AsyncLocalStorage } from "node:async_hooks";

// Next's async-local-storage module reads `globalThis.AsyncLocalStorage`
// at import time and throws "Invariant: AsyncLocalStorage accessed in
// runtime where it is not available" if it is missing. The Next server
// sets it; a plain Node process does not. It has to be in place BEFORE
// anything from `next/` is imported, which is why every import below is
// dynamic.
(globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real Next data cache, outside a Next server.
 *
 * WHY THIS EXISTS
 *
 * The property under test is "the storefront stops serving the old
 * value". A test that asserts the purge endpoint returned 200, or that
 * spies on `revalidateTag`, proves neither of the two things that
 * actually break: that the tag strings the console sends are the same
 * strings `unstable_cache` stored the entry under, and that a purge of
 * one tenant's tag leaves another tenant's entries alone. A tag typo
 * fails neither of those weaker tests and purges nothing in production.
 *
 * So this wires up the two pieces of the Next server that
 * `unstable_cache` and `revalidateTag` need, and nothing else:
 *
 *  - `globalThis.__incrementalCache`, which is the documented path
 *    `unstable_cache` itself takes when it runs outside a render (see
 *    `next/dist/server/web/spec-extension/unstable-cache.js`). Reads in
 *    these tests go through it, exactly as a page's reads do.
 *
 *  - A work store around the route handler. `revalidateTag` does not
 *    purge anything itself — it appends to `store.pendingRevalidatedTags`
 *    and the server flushes that to the cache after the handler returns.
 *    `runRouteHandler` is that wrapper, and it uses Next's own
 *    `executeRevalidates` to do the flush rather than reimplementing it.
 *
 * The cache is `FileSystemCache` with `flushToDisk: false`, so it is the
 * real handler a self-hosted `next start` uses, backed by its in-memory
 * LRU. Note `maxMemoryCacheSize` is required: without it FileSystemCache
 * builds no memory store and, with `flushToDisk` off, caches nothing at
 * all — which would make every assertion here silently vacuous. The
 * tests defend against that directly by asserting a STALE read before
 * each purge.
 */

type WorkStore = {
  incrementalCache: unknown;
  // Next 16 changed this from `string[]` to `{ tag, profile }[]`;
  // `revalidateTag` pushes an object with the profile it was called with.
  pendingRevalidatedTags: { tag: string; profile?: unknown }[];
  pendingRevalidates: Record<string, Promise<unknown>>;
  pendingRevalidateWrites: Promise<unknown>[];
  /**
   * `false` = a dynamic render. `unstable_cache` branches on this and
   * the branches disagree about staleness — see `runDynamicRender`.
   */
  isStaticGeneration: boolean;
  isDraftMode: boolean;
  isOnDemandRevalidate: boolean;
  nextFetchId: number;
  route: string;
  /**
   * Next resolves a named `revalidateTag` profile through this. It is
   * taken from Next's own `defaultConfig` rather than written out here,
   * because a hand-copied table that drifts would make a purge look
   * correct in tests and behave differently in the server.
   */
  cacheLifeProfiles: unknown;
};

let workAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T } | undefined;
let executeRevalidates: ((store: unknown) => Promise<unknown>) | undefined;
let cacheLifeProfiles: unknown;

function newWorkStore(): WorkStore {
  return {
    incrementalCache: (globalThis as Record<string, unknown>).__incrementalCache,
    pendingRevalidatedTags: [],
    pendingRevalidates: {},
    pendingRevalidateWrites: [],
    cacheLifeProfiles,
    // Every storefront route is `force-dynamic`, so a render here is
    // never a static generation. This field decides whether a stale
    // entry is served or awaited, so it is not a formality.
    isStaticGeneration: false,
    isDraftMode: false,
    isOnDemandRevalidate: false,
    nextFetchId: 1,
    route: "/[slug]",
  };
}

/**
 * Installs the cache. Call once, before importing anything that reads
 * through `unstable_cache`.
 */
export async function installNextDataCache(): Promise<void> {
  const { IncrementalCache } = await import("next/dist/server/lib/incremental-cache");
  const FileSystemCache = (
    await import("next/dist/server/lib/incremental-cache/file-system-cache")
  ).default;
  const { nodeFs } = await import("next/dist/server/lib/node-fs-methods");

  workAsyncStorage = (await import("next/dist/server/app-render/work-async-storage.external"))
    .workAsyncStorage as unknown as { run: <T>(store: unknown, fn: () => T) => T };
  executeRevalidates = (await import("next/dist/server/revalidation-utils"))
    .executeRevalidates as unknown as (store: unknown) => Promise<unknown>;
  cacheLifeProfiles = (await import("next/dist/server/config-shared")).defaultConfig.cacheLife;

  const cache = new IncrementalCache({
    dev: false,
    requestHeaders: {},
    flushToDisk: false,
    // Required, or nothing is cached. See the note above.
    maxMemoryCacheSize: 50 * 1024 * 1024,
    fs: nodeFs,
    serverDistDir: mkdtempSync(join(tmpdir(), "storefront-cache-")),
    CurCacheHandler: FileSystemCache,
    getPrerenderManifest: () => ({
      version: 4,
      routes: {},
      dynamicRoutes: {},
      notFoundRoutes: [],
      preview: {
        previewModeId: "test",
        previewModeSigningKey: "test",
        previewModeEncryptionKey: "test",
      },
    }),
  } as never);

  (globalThis as Record<string, unknown>).__incrementalCache = cache;
}

/**
 * Runs a route handler the way the Next server runs one: inside a work
 * store, then flushing whatever it asked to revalidate.
 *
 * Without the flush, `revalidateTag` records the tag and nothing is
 * evicted — which is exactly the shape of bug this harness exists to
 * catch, so the flush is Next's own `executeRevalidates` rather than a
 * hand-rolled loop that might diverge from it.
 */
export async function runRouteHandler(handler: () => Promise<Response>): Promise<Response> {
  if (!workAsyncStorage || !executeRevalidates) {
    throw new Error("installNextDataCache() must be called first");
  }

  const store = newWorkStore();
  const response = await workAsyncStorage.run(store, handler);
  await executeRevalidates(store);
  return response;
}

/**
 * Runs a cached read the way a DYNAMIC PAGE RENDER runs one — inside a
 * work store, with `isStaticGeneration: false`.
 *
 * THIS IS NOT CEREMONY. `unstable_cache` branches on whether a work
 * store is present, and the two branches disagree about what a STALE
 * entry means:
 *
 *  - **No work store** — which is what a bare `await getCachedProduct()`
 *    in a test is — takes `unstable-cache.js`'s
 *    `else if (!cacheEntry.isStale) return cached`, falls through, and
 *    recomputes SYNCHRONOUSLY. The caller gets fresh data.
 *  - **Work store, `isStaticGeneration: false`** — every render this
 *    storefront does — returns the stale value to the caller AS IS and
 *    schedules the recompute in the background.
 *
 * So a purge that only marks a tag `stale` rather than `expired` looks
 * like it worked when read without a store, and serves the visitor the
 * old page in production. Measured, three rounds, same tag:
 *
 *     {expire: 0}   post=Title 1 | post=Title 2 | post=Title 3
 *     "max"         post=Title 0 | post=Title 1 | post=Title 2
 *     {expire: 60}  post=Title 0 | post=Title 1 | post=Title 2
 *
 * Any assertion of the form "the visitor now sees the new value" has to
 * go through here. `runRouteHandler` above uses the same store shape, so
 * a purge issued through it is issued the way the real route issues one.
 *
 * The pending revalidates are flushed before returning, because in this
 * branch Next does NOT await the cache write inline — it parks it on the
 * store for the server to drain at the end of the request. Without the
 * flush the entry is not written and the next read races it.
 *
 * ONE CAVEAT, AND IT COSTS TEST TIME RATHER THAN CORRECTNESS
 *
 * A read issued in the same instant as a purge may still see the entry.
 * `areTagsExpired` evaluates `expiredAt <= performance.timeOrigin +
 * performance.now()` against an `expiredAt` written from `Date.now()` —
 * two different clocks. `performance.timeOrigin` is fixed when the
 * process starts, so its offset from the wall clock is per-process and
 * drifts: measured here at -0.699ms to +0.301ms, and when it is negative
 * a just-issued purge has not "happened" yet by the performance clock.
 * Called in the same instant as the purge, `areTagsExpired` returned
 * false 70% of the time (20,000 samples). `areTagsStale` reads no clock
 * and is never affected, which is why a stale-marking purge looks more
 * reliable here than an expiring one — the opposite of what matters.
 *
 * This is Next's code, not the harness's, so the window is real in
 * production too. It is just unreachable there: a purge arrives over
 * HTTP from the console and the next visitor is at least a network round
 * trip behind it, not microseconds. Only a same-process test can land
 * inside a sub-millisecond window, so tests put a gap between a purge
 * and the read that checks it.
 */
export async function runDynamicRender<T>(read: () => Promise<T>): Promise<T> {
  if (!workAsyncStorage || !executeRevalidates) {
    throw new Error("installNextDataCache() must be called first");
  }

  const store = newWorkStore();
  const value = await workAsyncStorage.run(store, read);
  await executeRevalidates(store);
  return value;
}
