import { eq, tenants, withTenant } from "@platform/db";
import type { SearchIndexing } from "@platform/db";
import { SEARCH_INDEXING_MODES } from "@platform/db";

import { recordAudit } from "../audit/index";
import { AppError, NotFoundError } from "../errors";
import { domainsForTenant, invalidateHostCache } from "./resolve";

/**
 * Tenant-level settings writes.
 *
 * `tenants` is control-plane — deliberately not RLS-protected — so the
 * `WHERE id = ctx.tenantId` below is the ONLY tenant isolation on this
 * table. The id must come from the session, never from a payload.
 * The transaction still runs under `withTenant` because the audit row
 * IS RLS-protected and its WITH CHECK needs the tenant GUC; `tenants`
 * itself ignores the GUC.
 */

/** Who is writing, for the audit row. Same shape as the catalog
 * WriteContext, named apart so the root barrel's `export *` of both
 * modules cannot collide. */
export type SettingsWriteContext = {
  tenantId: string;
  actorUserId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export type SearchIndexingUpdate = {
  searchIndexing: SearchIndexing;
  changed: boolean;
};

/**
 * Set the tenant's search-indexing mode.
 *
 * Writing the value already stored is a no-op: no UPDATE, no audit row,
 * no cache invalidation — the same principle as "a no-op import does
 * not purge".
 */
export async function updateSearchIndexing(
  ctx: SettingsWriteContext,
  mode: SearchIndexing,
): Promise<SearchIndexingUpdate> {
  // The route's zod schema already refuses anything outside the enum;
  // this guards future non-HTTP callers.
  if (!(SEARCH_INDEXING_MODES as readonly string[]).includes(mode)) {
    throw new AppError({
      code: "invalid_payload",
      message: `searchIndexing must be one of ${SEARCH_INDEXING_MODES.join(", ")}, got ${mode}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: {
        issues: [{ path: "searchIndexing", message: "Choose one of the listed options." }],
      },
    });
  }

  const result = await withTenant(ctx.tenantId, async (tx) => {
    const [current] = await tx
      .select({ searchIndexing: tenants.searchIndexing })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .limit(1);

    if (!current) throw new NotFoundError("Tenant");

    if (current.searchIndexing === mode) {
      return { searchIndexing: mode, changed: false };
    }

    await tx
      .update(tenants)
      // updatedAt has no $onUpdate — it must be set by hand.
      .set({ searchIndexing: mode, updatedAt: new Date() })
      .where(eq(tenants.id, ctx.tenantId));

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "settings.search_indexing_changed",
      entityType: "tenant",
      entityId: ctx.tenantId,
      before: { searchIndexing: current.searchIndexing },
      after: { searchIndexing: mode },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { searchIndexing: mode, changed: true };
  });

  if (result.changed) {
    // After the commit, so a storefront reader cannot re-cache the
    // pre-commit row. Fail-soft: robots.txt and page metadata read the
    // Redis host cache, so a failed invalidation means staleness bounded
    // by the 300 s TTL, not a failed save.
    try {
      const hosts = await domainsForTenant(ctx.tenantId);
      await invalidateHostCache(
        hosts.map((d) => d.hostname),
        ctx.tenantId,
      );
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "settings.host_cache_invalidation_failed",
          tenantId: ctx.tenantId,
          error: String(err),
        }),
      );
    }
  }

  return result;
}
