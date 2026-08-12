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
  pendingRevalidatedTags: string[];
  pendingRevalidates: Record<string, Promise<unknown>>;
  pendingRevalidateWrites: Promise<unknown>[];
};

let workAsyncStorage: { run: <T>(store: unknown, fn: () => T) => T } | undefined;
let executeRevalidates: ((store: unknown) => Promise<unknown>) | undefined;

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

  const store: WorkStore = {
    incrementalCache: (globalThis as Record<string, unknown>).__incrementalCache,
    pendingRevalidatedTags: [],
    pendingRevalidates: {},
    pendingRevalidateWrites: [],
  };

  const response = await workAsyncStorage.run(store, handler);
  await executeRevalidates(store);
  return response;
}
