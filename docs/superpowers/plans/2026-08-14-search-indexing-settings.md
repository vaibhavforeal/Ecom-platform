# Search-Indexing Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the writer for `tenants.search_indexing` — a console `/settings` page whose only control today is search indexing — so the fully-tested read side (`isSearchIndexable`, robots.txt, page metadata) stops being SQL-only.

**Architecture:** A domain function `updateSearchIndexing` in `packages/core/src/tenancy/settings.ts` does the whole invariant chain (one `withTenant` transaction for the `tenants` UPDATE + audit row, no-op skip, fail-soft Redis host-cache invalidation after commit). The console gets `PUT /api/settings` through the existing write pipeline (gated on the pre-existing `settings:write` permission via a new permission parameter), and a `/settings` server page with a client radio-group form. Spec: `docs/superpowers/specs/2026-08-14-search-indexing-settings-design.md`.

**Tech Stack:** Next 16.3.0 (App Router, Turbopack), Drizzle + postgres.js, ioredis, zod 3, vitest integration tests against real Postgres/Redis.

## Global Constraints

- `pnpm` is NOT on PATH in a plain shell. Run `export PATH="$HOME/.pnpm-shim:$PATH"` first in every shell. Run all pnpm commands from the repo root `D:\Software Ideas\Ecommerce Website`.
- Ports are non-default on purpose: Postgres `5442`, PgBouncer `6442`, Redis `6389`. Port 3000 is taken by another project — storefront serves on `3010`, console on `3001`. Do not "fix" any of this.
- Integration tests need Docker up: `pnpm infra:up`, then `pnpm db:migrate`. `pnpm test:integration` is serialized by turbo (`dependsOn: ["^test:integration"]`) — always run it from the root, never in parallel by hand.
- Relative imports are extensionless repo-wide (`./resolve`, never `./resolve.js`).
- No new npm dependencies. Everything needed exists.
- Error contract (already implemented in `handleCatalogWrite` — do not reinvent): `{ error: { code, message, details?: { issues: [{ path, message }] } }, requestId }`; 401 unauthenticated, 403 forbidden, 413 over 1 MiB, 400 `invalid_json`, 422 `invalid_payload`.
- The tenant id comes from the SESSION only. `tenants` has NO RLS — the `WHERE id = actor.tenantId` filter is the only tenant isolation on that table. Never accept a tenantId in a body.
- `SEARCH_INDEXING_MODES = ["auto", "indexed", "noindex"] as const` is exported by `@platform/db` (`packages/db/src/schema/enums.ts:108`), type `SearchIndexing`.
- Do NOT export a type named `WriteContext` from anything the core root barrel re-exports: `packages/core/src/index.ts` does `export *` from both `./tenancy/index` and `./catalog/server`, and `catalog/server` already exports `WriteContext`. A duplicate name silently poisons the root barrel. The new context type is named `SettingsWriteContext`.
- Integration suites delete what they create, in order tenants → users → plans, tracking ids in `Set`s. Two consecutive runs must leave row counts unchanged.
- Do not touch the `NODE_ENV=production` override in the Next build scripts, the `.env` handling, or `turbo.json`.

---

### Task 1: Permission parameter on `handleCatalogWrite`

The shared write pipeline hardcodes `assertCan(actor, "catalog:write")`. Add an optional permission to `opts` so the settings route can reuse the identical pipeline. Existing callers pass no permission and are untouched.

**Files:**
- Modify: `apps/console/src/lib/catalog-routes.ts`
- Test: existing suites, `apps/console` integration (regression only — no new tests in this task)

**Interfaces:**
- Consumes: `Permission` type from `@platform/core` (`packages/core/src/identity/permissions.ts:40`, re-exported by the core root barrel).
- Produces: `handleCatalogWrite(req, schema, run, opts?)` where `opts` is now `{ successStatus?: number; permission?: Permission }`, defaulting to `"catalog:write"`. Task 2's route calls it with `{ permission: "settings:write" }`.

- [ ] **Step 1: Make the edit**

In `apps/console/src/lib/catalog-routes.ts`:

Add to the imports (there is already `import { assertCan } from "@platform/core";` at line 3):

```ts
import { assertCan } from "@platform/core";
import type { Permission } from "@platform/core";
```

Change the signature and the assert (currently lines 62–72):

```ts
export async function handleCatalogWrite<TSchema extends z.ZodTypeAny, TOutput>(
  req: Request,
  schema: TSchema,
  run: CatalogWriteHandler<z.infer<TSchema>, TOutput>,
  opts: { successStatus?: number; permission?: Permission } = {},
): Promise<NextResponse> {
  const requestId = newRequestId();

  try {
    const actor = await getActorOrThrow();
    assertCan(actor, opts.permission ?? "catalog:write");
```

Nothing else in the function changes. Extend the function's doc comment (the block at lines 53–61) with one sentence at the end:

```
 * Despite the name, the pipeline is not catalog-specific: `opts.permission`
 * lets a non-catalog route (settings) reuse it with its own gate.
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean, 6/6 packages.

- [ ] **Step 3: Regression — existing console integration tests still pass**

Run: `pnpm --filter @platform/console test:integration`
Expected: PASS, 101 tests (the pre-existing count; this task adds none).

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/lib/catalog-routes.ts
git commit -m "refactor(console): let handleCatalogWrite gate on a caller-supplied permission"
```

---

### Task 2: Domain write, `PUT /api/settings`, and the six-test suite

The heart of the feature. TDD: the test suite is written first against a route that does not exist yet.

**Files:**
- Create: `packages/core/src/tenancy/settings.ts`
- Modify: `packages/core/src/tenancy/index.ts` (one export line)
- Create: `apps/console/src/app/api/settings/route.ts`
- Test: `apps/console/tests/settings.integration.test.ts` (new)

**Interfaces:**
- Consumes: `handleCatalogWrite(req, schema, run, { permission })` from Task 1; `recordAudit(tx, tenantId, entry)` (`packages/core/src/audit/index.ts:36`); `invalidateHostCache(hosts: string[], tenantId?: string)` and `domainsForTenant(tenantId)` (`packages/core/src/tenancy/resolve.ts:96,140` — both already exported); `withTenant`, `tenants`, `eq`, `SEARCH_INDEXING_MODES`, type `SearchIndexing` from `@platform/db`; `NotFoundError`, `AppError` from `../errors`.
- Produces: `updateSearchIndexing(ctx: SettingsWriteContext, mode: SearchIndexing): Promise<{ searchIndexing: SearchIndexing; changed: boolean }>` and `type SettingsWriteContext = { tenantId: string; actorUserId: string; ip?: string | null; userAgent?: string | null; requestId?: string | null }`, both exported from `@platform/core` (via the tenancy barrel). Route `PUT /api/settings` responding `{ searchIndexing, changed, requestId }` on 200. Task 3's form calls `PUT /api/settings` with body `{ searchIndexing: "auto" | "indexed" | "noindex" }`.

- [ ] **Step 1: Write the failing test suite**

Create `apps/console/tests/settings.integration.test.ts`. The harness (mocked `next/headers`, migrator connection, tracked-id cleanup) copies `product-crud.integration.test.ts` deliberately — same idiom, same reasons.

```ts
import { createHash, randomUUID } from "node:crypto";

import { closeRedis, invalidateHostCache, platformKey, redis, resolveTenantByHost } from "@platform/core";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/settings against real PostgreSQL and Redis.
 *
 * The route handler is called directly with a constructed `Request`,
 * exactly as product-crud.integration.test.ts does. Only `next/headers`
 * is stubbed; the session, membership and permission checks run for
 * real.
 *
 * `tenants` has no RLS, so every DB assertion here is about the table
 * itself — reads go through the migrator connection like the other
 * suites, for consistency rather than necessity.
 */

let sessionToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { PUT: updateSettingsRoute } = await import("../src/app/api/settings/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

/** Tenant A: happy path, validation, authz. B: cache invalidation. C: no-op. */
let tenantA: string;
let tenantB: string;
let tenantC: string;
let hostB: string;
let hostC: string;
let ownerAToken: string;
let ownerAUserId: string;
let catalogManagerAToken: string;
let ownerBToken: string;
let ownerCToken: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

async function makeTenant(): Promise<{ id: string; hostname: string }> {
  const slug = "st-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"st-" + randomUUID().slice(0, 8)}, 'Settings test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  // A verified domain so resolveTenantByHost can warm the Redis host
  // cache for this tenant. Cascade-deleted with the tenant.
  const hostname = `${slug}.settings-test.localhost`;
  await admin`
    INSERT INTO domains (id, tenant_id, hostname, is_primary, verified_at)
    VALUES (${randomUUID()}, ${tenant!.id}, ${hostname}, true, now())`;
  return { id: tenant!.id, hostname };
}

async function makeSession(
  tenantId: string,
  role: string,
): Promise<{ token: string; userId: string }> {
  const userId = randomUUID();
  createdUsers.add(userId);
  const phone = "+9197" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Settings test')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenantId}, ${userId}, ${role}, now())`;

  const token = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(token).digest("hex")},
            ${userId}, ${tenantId}, now() + interval '1 day', now() + interval '1 day')`;

  return { token, userId };
}

async function putSettings(
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const response = await updateSettingsRoute(
    new Request("http://console.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

type TenantRow = { search_indexing: string; updated_at: Date };

async function tenantRow(id: string): Promise<TenantRow> {
  const [row] = await admin<TenantRow[]>`
    SELECT search_indexing, updated_at FROM tenants WHERE id = ${id}`;
  return row!;
}

async function settingsAudits(
  tenantId: string,
): Promise<{ action: string; before: unknown; after: unknown }[]> {
  return admin<{ action: string; before: unknown; after: unknown }[]>`
    SELECT action, before, after FROM audit_log
    WHERE tenant_id = ${tenantId} AND action = 'settings.search_indexing_changed'
    ORDER BY created_at`;
}

beforeAll(async () => {
  const a = await makeTenant();
  const b = await makeTenant();
  const c = await makeTenant();
  tenantA = a.id;
  tenantB = b.id;
  hostB = b.hostname;
  tenantC = c.id;
  hostC = c.hostname;

  const ownerA = await makeSession(tenantA, "owner");
  ownerAToken = ownerA.token;
  ownerAUserId = ownerA.userId;
  catalogManagerAToken = (await makeSession(tenantA, "catalog_manager")).token;
  ownerBToken = (await makeSession(tenantB, "owner")).token;
  ownerCToken = (await makeSession(tenantC, "owner")).token;
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  // The warmed host keys have a 300 s TTL, but leave nothing behind.
  await invalidateHostCache([hostB, hostC]);
  await closeRedis();
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("PUT /api/settings", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { status } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(401);
  });

  it("refuses a role holding only settings:read with 403", async () => {
    sessionToken = catalogManagerAToken;
    const { status, data } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(403);
    expect((data.error as { code: string }).code).toBe("forbidden");
    // And nothing changed.
    expect((await tenantRow(tenantA)).search_indexing).toBe("auto");
  });

  it("refuses a value outside the enum with a field-level 422", async () => {
    sessionToken = ownerAToken;
    const { status, data } = await putSettings({ searchIndexing: "always" });
    expect(status).toBe(422);
    const error = data.error as { code: string; details: { issues: { path: string }[] } };
    expect(error.code).toBe("invalid_payload");
    expect(error.details.issues.some((i) => i.path === "searchIndexing")).toBe(true);
  });

  it("updates the column, bumps updated_at, and writes the audit row", async () => {
    sessionToken = ownerAToken;
    const before = await tenantRow(tenantA);
    expect(before.search_indexing).toBe("auto");

    const { status, data } = await putSettings({ searchIndexing: "noindex" });
    expect(status).toBe(200);
    expect(data.searchIndexing).toBe("noindex");
    expect(data.changed).toBe(true);

    const after = await tenantRow(tenantA);
    expect(after.search_indexing).toBe("noindex");
    expect(after.updated_at.getTime()).not.toBe(before.updated_at.getTime());

    const audits = await settingsAudits(tenantA);
    expect(audits.length).toBe(1);
    expect(audits[0]!.before).toEqual({ searchIndexing: "auto" });
    expect(audits[0]!.after).toEqual({ searchIndexing: "noindex" });
  });

  it("invalidates the Redis host cache so the resolver serves the new value", async () => {
    // Warm the cache from the DB, as a storefront request would.
    const warmed = await resolveTenantByHost(hostB);
    expect(warmed?.searchIndexing).toBe("auto");

    sessionToken = ownerBToken;
    const { status } = await putSettings({ searchIndexing: "indexed" });
    expect(status).toBe(200);

    // Without invalidation this still serves the 300 s-cached "auto".
    const fresh = await resolveTenantByHost(hostB);
    expect(fresh?.searchIndexing).toBe("indexed");
  });

  it("treats writing the current value as a no-op: no audit row, cache untouched", async () => {
    const warmed = await resolveTenantByHost(hostC);
    expect(warmed?.searchIndexing).toBe("auto");

    sessionToken = ownerCToken;
    const { status, data } = await putSettings({ searchIndexing: "auto" });
    expect(status).toBe(200);
    expect(data.changed).toBe(false);

    expect(await settingsAudits(tenantC)).toEqual([]);
    // The warmed key is still there — a no-op must not purge.
    expect(await redis().get(platformKey("host", hostC))).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @platform/console test:integration -- settings`
Expected: FAIL at module load — `Cannot find module '../src/app/api/settings/route'` (the route does not exist yet).

(Requires Docker up: `pnpm infra:up && pnpm db:migrate` first if not already running.)

- [ ] **Step 3: Write the domain function**

Create `packages/core/src/tenancy/settings.ts`:

```ts
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
```

Add to `packages/core/src/tenancy/index.ts` (currently two lines):

```ts
export * from "./indexing";
export * from "./resolve";
export * from "./settings";
```

- [ ] **Step 4: Write the route**

Create `apps/console/src/app/api/settings/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { updateSearchIndexing } from "@platform/core";
import { SEARCH_INDEXING_MODES } from "@platform/db";
import { z } from "zod";

import { handleCatalogWrite } from "../../../lib/catalog-routes";

/**
 * Tenant settings. One field today; later settings join this schema.
 *
 * The tenant is the session's — `handleCatalogWrite` builds the write
 * context from the actor and there is no way to pass a tenant in the
 * body. That matters more than usual here: `tenants` has no RLS, so the
 * domain function's WHERE clause is the only isolation.
 */
const settingsPayloadSchema = z.object({
  searchIndexing: z.enum(SEARCH_INDEXING_MODES),
});

export async function PUT(req: Request): Promise<NextResponse> {
  return handleCatalogWrite(
    req,
    settingsPayloadSchema,
    (ctx, payload) => updateSearchIndexing(ctx, payload.searchIndexing),
    { permission: "settings:write" },
  );
}
```

(`ctx` is the catalog `WriteContext`; it is structurally identical to `SettingsWriteContext`, so it passes straight through.)

- [ ] **Step 5: Run the suite to verify it passes**

Run: `pnpm --filter @platform/console test:integration -- settings`
Expected: PASS, 6 tests.

- [ ] **Step 6: Full typecheck, lint, and the whole integration matrix**

Run: `pnpm typecheck && pnpm lint && pnpm test:integration`
Expected: clean; integration total 191 (was 185; console 101 → 107). If any OTHER suite broke, stop and investigate — this task must not touch existing behaviour.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/tenancy/settings.ts packages/core/src/tenancy/index.ts apps/console/src/app/api/settings/route.ts apps/console/tests/settings.integration.test.ts
git commit -m "feat(settings): updateSearchIndexing domain write and PUT /api/settings"
```

---

### Task 3: `/settings` page, form, and the dashboard chip

**Files:**
- Create: `apps/console/src/app/settings/page.tsx`
- Create: `apps/console/src/app/settings/SearchIndexingForm.tsx`
- Modify: `apps/console/src/app/page.tsx:38-47` (the toolbar nav)

**Interfaces:**
- Consumes: `PUT /api/settings` from Task 2 (body `{ searchIndexing }`, errors in the shared shape); `isSearchIndexable`, `can` from `@platform/core`; `requireActor` from `../../lib/session`; `withPlatform`, `tenants`, `eq` from `@platform/db`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the client form**

Create `apps/console/src/app/settings/SearchIndexingForm.tsx`. Fetch-based like `ProductForm` — no Server Actions (explicit prior decision, `ProductForm.tsx:23`). The mode values are typed as a local literal union so the client chunk resolves nothing from `@platform/db`.

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "auto" | "indexed" | "noindex";
type Issue = { path: string; message: string };

type Props = {
  current: Mode;
  status: string;
  indexable: boolean;
  canWrite: boolean;
};

const OPTIONS: { value: Mode; label: string; detail: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    detail: "Search engines may index this store once it is active. Trial stores stay hidden.",
  },
  {
    value: "indexed",
    label: "Always indexed",
    detail: "Ask search engines to index this store, even during a trial.",
  },
  {
    value: "noindex",
    label: "Hidden",
    detail: "Ask search engines not to index this store.",
  },
];

export function SearchIndexingForm({ current, status, indexable, canWrite }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(current);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  // isSearchIndexable's platform override: these two statuses are never
  // indexed, whatever the merchant chooses. Rendered, not re-derived —
  // the server computed `indexable` with the real function.
  const overridden = status === "suspended" || status === "churned";

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setIssues([]);
    setSaved(null);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchIndexing: mode }),
      });

      const data = (await res.json()) as {
        error?: { message?: string; details?: { issues?: Issue[] } };
      };

      if (!res.ok) {
        setIssues(
          data.error?.details?.issues ?? [
            { path: "form", message: data.error?.message ?? "That could not be saved." },
          ],
        );
        return;
      }

      setSaved("Saved.");
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="panel">
      <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Search engine indexing</h2>

      <p className="muted">
        Search engines are currently {indexable ? "allowed" : "not allowed"} to index this store.
      </p>
      {overridden && (
        <p className="muted">
          This store is {status}, so it stays out of search engines whatever is chosen here.
        </p>
      )}

      <div className="section">
        {OPTIONS.map((option) => (
          <label key={option.value} style={{ display: "block", marginBottom: 8 }}>
            <input
              type="radio"
              name="searchIndexing"
              value={option.value}
              checked={mode === option.value}
              onChange={() => setMode(option.value)}
              disabled={!canWrite}
            />{" "}
            <strong>{option.label}</strong>
            <span className="muted"> — {option.detail}</span>
          </label>
        ))}
      </div>

      {issues.length > 0 && (
        <ul className="error">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path === "form" ? "" : `${issue.path}: `}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {saved && <p className="muted">{saved}</p>}

      <p className="muted">
        The storefront updates right away. robots.txt may be cached by a CDN for up to an hour.
      </p>

      <button type="submit" disabled={busy || !canWrite}>
        {busy ? "Saving…" : "Save"}
      </button>
      {!canWrite && <p className="muted">Your role can view settings but not change them.</p>}
    </form>
  );
}
```

- [ ] **Step 2: Write the page**

Create `apps/console/src/app/settings/page.tsx`:

```tsx
import Link from "next/link";

import { can, isSearchIndexable } from "@platform/core";
import { eq, tenants, withPlatform } from "@platform/db";

import { requireActor } from "../../lib/session";
import { SearchIndexingForm } from "./SearchIndexingForm";

export const dynamic = "force-dynamic";

/**
 * Tenant settings. One control today — search-engine indexing — on a
 * page shaped so later settings have a home.
 *
 * The effective state is computed HERE with the real resolver and passed
 * down: the client never re-derives platform policy.
 */
export default async function SettingsPage() {
  const actor = await requireActor();

  if (!can(actor, "settings:read")) {
    return (
      <main>
        <h1>Settings</h1>
        <p className="error">Your role does not include access to settings.</p>
      </main>
    );
  }

  const [tenant] = await withPlatform(async (tx) =>
    tx
      .select({ status: tenants.status, searchIndexing: tenants.searchIndexing })
      .from(tenants)
      .where(eq(tenants.id, actor.tenantId))
      .limit(1),
  );

  if (!tenant) {
    return (
      <main>
        <h1>Settings</h1>
        <p className="error">This store could not be loaded.</p>
      </main>
    );
  }

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link>
      </nav>

      <h1>Settings</h1>

      <SearchIndexingForm
        current={tenant.searchIndexing}
        status={tenant.status}
        indexable={isSearchIndexable(tenant)}
        canWrite={can(actor, "settings:write")}
      />
    </main>
  );
}
```

- [ ] **Step 3: Add the dashboard chip**

In `apps/console/src/app/page.tsx`, replace the toolbar block (lines 38–47):

```tsx
      {can(actor, "catalog:read") && (
        <nav className="toolbar">
          <Link href="/products" className="chip">
            Products
          </Link>
          <Link href="/products/taxonomy" className="chip">
            Categories &amp; collections
          </Link>
        </nav>
      )}
```

with:

```tsx
      {(can(actor, "catalog:read") || can(actor, "settings:read")) && (
        <nav className="toolbar">
          {can(actor, "catalog:read") && (
            <>
              <Link href="/products" className="chip">
                Products
              </Link>
              <Link href="/products/taxonomy" className="chip">
                Categories &amp; collections
              </Link>
            </>
          )}
          {can(actor, "settings:read") && (
            <Link href="/settings" className="chip">
              Settings
            </Link>
          )}
        </nav>
      )}
```

(Every default role holds `catalog:read` today, but per-member `permissionOverrides` can revoke it while leaving `settings:read` — the OR-gate keeps the nav correct in that case rather than rendering an empty bar.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean, 2/2 Next apps. The build is the boundary check: the client chunk must not drag in `@platform/db` (the form deliberately imports nothing from it).

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/settings/ apps/console/src/app/page.tsx
git commit -m "feat(console): /settings page with the search-indexing control"
```

---

### Task 4: Docs, the full gate, and the live pass

**Files:**
- Modify: `PROJECT_STATUS.md` (Phase 1 table row, "Last updated", new verified block)
- Modify: `docs/PHASE1_FOLLOWUPS.md` (move the known-limitation to the fixed list)
- Test: the entire matrix, then live HTTP

**Interfaces:**
- Consumes: everything above, committed.
- Produces: the documented, verified feature.

- [ ] **Step 1: Run the full gate**

```bash
export PATH="$HOME/.pnpm-shim:$PATH"
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:integration
```

Expected: lint clean, 6/6 typecheck, 2/2 builds, 325 unit tests (unchanged), 191 integration (console 101 → 107, all others unchanged). Record the ACTUAL numbers — do not copy these expectations into the docs unverified.

- [ ] **Step 2: Live pass**

```bash
pnpm infra:up && pnpm db:migrate
```

If `users` is empty (it is after a volume reset), add the staff row with the SQL in `README.md`. Then serve production builds — console on 3001, storefront on 3010 (3000 is taken) — with the repo's own start scripts, and verify in a browser:

1. `http://acme.localhost:3010/robots.txt` → `Allow` with a sitemap line (acme is active + auto).
2. Log into the console at `http://acme.localhost:3001`, open Dashboard → the Settings chip is visible → `/settings` shows "currently allowed" with Automatic selected.
3. Choose Hidden, Save → "Saved." appears; reload `robots.txt` → `Disallow: /` immediately (no TTL wait — that immediacy is the Redis invalidation working).
4. A storefront product page's `<meta name="robots">` now carries `noindex`.
5. Flip back to Automatic, Save → `robots.txt` allows again.

If step 3 or 5 needs a ~5-minute wait to change, the invalidation is NOT working — stop and debug (likely `REDIS_URL` differs between the two processes).

- [ ] **Step 3: Update the docs**

In `PROJECT_STATUS.md`:
- The Phase 1 table row for "Per-tenant search indexing" (line 23): ⚠️ → ✅, new text: "`tenants.search_indexing` (`auto`/`indexed`/`noindex`) + `isSearchIndexable`, read by `robots.txt` and page metadata, **written by the console's `/settings` page** (`PUT /api/settings`, `settings:write`, audited, Redis host-cache invalidated on change)".
- The "Not an open question — a missing screen" paragraph (lines 70–80): rewrite its ending to say the screen now exists at `/settings`.
- Add a "Re-verified 2026-08-14 (search-indexing settings, full, all green)" block after the last verified block, with the gate's actual counts and one line attributing the integration delta (+6 = the new `settings.integration.test.ts`), plus a sentence on the live pass (robots.txt flipped immediately on save).
- Update "Last updated" to 2026-08-14.

In `docs/PHASE1_FOLLOWUPS.md`:
- Remove the "known limitation" entry "**`tenants.search_indexing` has no writer.**" (around line 83) and add an entry to the "Fixed" section: "**`tenants.search_indexing` now has a writer** — the console `/settings` page (`PUT /api/settings`), gated on `settings:write`, audited as `settings.search_indexing_changed`, with the Redis host cache invalidated on change. (commit hashes of Tasks 1–3)".

- [ ] **Step 4: Commit**

```bash
git add PROJECT_STATUS.md docs/PHASE1_FOLLOWUPS.md
git commit -m "docs: record the search-indexing settings UI as verified"
```

---

## Notes for the reviewer

- The spec is `docs/superpowers/specs/2026-08-14-search-indexing-settings-design.md`; every requirement in it maps to Task 1 (permission parameter), Task 2 (domain write, route, all six tests), Task 3 (page, form, chip, copy), or Task 4 (gate, live pass, docs).
- Out of scope, per the spec: any second setting; CDN purge for robots.txt (`s-maxage=3600` staleness is documented in the UI copy); changes to `isSearchIndexable` or the column.
- The `changed` field in the route response is not consumed by the form today; it exists because the domain function must distinguish no-ops anyway, and the tests assert through it.
