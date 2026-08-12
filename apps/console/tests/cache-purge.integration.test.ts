import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { closeRedis } from "@platform/core";
import { runCatalogImport } from "@platform/core/catalog/server";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The console half of the storefront cache purge.
 *
 * Three properties, and the second one is the whole reason this file
 * exists as its own suite:
 *
 *  1. **The purge is issued AFTER the transaction commits.** Tested by
 *     having the stub storefront, at the moment the purge arrives, read
 *     the row back over an INDEPENDENT database connection. Under READ
 *     COMMITTED an uncommitted write is invisible to that connection, so
 *     "the stub can already see the new title" is a direct observation
 *     that the commit happened first. A purge issued mid-transaction can
 *     race a storefront reader into re-caching the pre-commit row, and
 *     that entry then survives its full TTL rather than expiring.
 *
 *  2. **A failed purge does not fail the merchant's write.** Refused
 *     connection, 500, hang, misconfiguration — every one of them, the
 *     save still returns 200 and the row is still correct. This is the
 *     property most likely to regress, because the natural way to write
 *     the purge call is to `await` it and let it throw.
 *
 *  3. **A dry-run import does not purge.** It rolls its transaction
 *     back, so there is nothing to invalidate; purging would evict a
 *     correct cache and refill it with the same rows.
 *
 * Only `next/headers` is stubbed — it reads request-scoped async storage
 * that only exists inside a Next server. The session token is a genuine
 * row, so the permission check runs for real.
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

const { POST: createProductRoute } = await import("../src/app/api/products/route");
const { PUT: updateProductRoute } = await import("../src/app/api/products/[id]/route");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

/** A second pool, so the stub storefront reads on its own connection. */
const observer = postgres(migratorUrl, { max: 2, onnotice: () => {} });

const TEST_SECRET = "console-purge-secret-4d81ba";

type Received = {
  secret: string | null;
  body: { tenantId?: string; tags?: string[] };
  /** What an independent connection could see when the purge landed. */
  titleVisibleToOthers: string | null;
};

let server: Server;
let origin: string;
let received: Received[] = [];

/** How the stub storefront answers. Set per test. */
let behaviour: "ok" | "error" | "hang" = "ok";
/** The product the observer reads back when a purge arrives, if any. */
let watchProductId: string | null = null;

function startStubStorefront(): Promise<{ server: Server; origin: string }> {
  const created = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        // Read the row on a connection that has nothing to do with the
        // console's transaction. If the write had not committed, this
        // would still show the OLD title.
        let titleVisibleToOthers: string | null = null;
        if (watchProductId) {
          const [row] = await observer<{ title: string }[]>`
            SELECT title FROM products WHERE id = ${watchProductId}`;
          titleVisibleToOthers = row?.title ?? null;
        }

        received.push({
          secret: (req.headers["x-internal-secret"] as string | undefined) ?? null,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Received["body"],
          titleVisibleToOthers,
        });

        // Never answers. Exercises the timeout rather than an error.
        if (behaviour === "hang") return;

        res.writeHead(behaviour === "error" ? 500 : 200, {
          "content-type": "application/json",
        });
        res.end(behaviour === "error" ? '{"error":{"code":"boom"}}' : '{"purged":4}');
      })();
    });
  });

  return new Promise((resolve) => {
    created.listen(0, "127.0.0.1", () => {
      const address = created.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server: created, origin: `http://127.0.0.1:${port}` });
    });
  });
}

let tenantId: string;
let ownerToken: string;
let ownerUserId: string;

async function makeTenant(): Promise<string> {
  const slug = "cp-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"cp-" + randomUUID().slice(0, 8)}, 'Cache purge test plan')
    RETURNING id`;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  return tenant!.id;
}

function jsonRequest(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createProduct(title: string): Promise<string> {
  const response = await createProductRoute(
    jsonRequest("http://console.test/api/products", {
      title,
      status: "active",
      variants: [{ sku: `CP-${randomUUID().slice(0, 8)}`, price: "1299", weightGrams: 240 }],
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { productId: string }).productId;
}

async function renameProduct(
  productId: string,
  title: string,
  slug: string,
): Promise<{ status: number }> {
  const response = await updateProductRoute(
    jsonRequest(
      `http://console.test/api/products/${productId}`,
      {
        title,
        slug,
        status: "active",
        variants: [{ sku: `CP-${randomUUID().slice(0, 8)}`, price: "1399", weightGrams: 240 }],
      },
      "PUT",
    ),
    { params: Promise.resolve({ id: productId }) },
  );
  return { status: response.status };
}

async function titleOf(productId: string): Promise<string> {
  const [row] = await admin<{ title: string }[]>`
    SELECT title FROM products WHERE id = ${productId}`;
  return row!.title;
}

beforeAll(async () => {
  const started = await startStubStorefront();
  server = started.server;
  origin = started.origin;

  tenantId = await makeTenant();

  ownerUserId = randomUUID();
  const phone = "+9199" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`
    INSERT INTO users (id, phone_e164, name) VALUES (${ownerUserId}, ${phone}, 'Cache purge')`;
  await admin`
    INSERT INTO tenant_members (tenant_id, user_id, role, accepted_at)
    VALUES (${tenantId}, ${ownerUserId}, 'owner', now())`;

  ownerToken = randomUUID() + randomUUID();
  await admin`
    INSERT INTO sessions (id, token_hash, user_id, tenant_id, expires_at, idle_expires_at)
    VALUES (${randomUUID()}, ${createHash("sha256").update(ownerToken).digest("hex")},
            ${ownerUserId}, ${tenantId}, now() + interval '1 day', now() + interval '1 day')`;
});

beforeEach(() => {
  received = [];
  behaviour = "ok";
  watchProductId = null;
  sessionToken = ownerToken;
  process.env.INTERNAL_API_SECRET = TEST_SECRET;
  process.env.STOREFRONT_INTERNAL_ORIGIN = origin;
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeRedis();
  await admin.end();
  await observer.end();
  await closeConnections();
});

describe("the console purges after a committed catalog write", () => {
  it("sends the tenant's tags, with the secret, once per write", async () => {
    const productId = await createProduct("Purge Me");

    expect(received).toHaveLength(1);
    const purge = received[0]!;

    expect(purge.secret).toBe(TEST_SECRET);
    expect(purge.body.tenantId).toBe(tenantId);

    // Written out in full. If the tag scheme changes on one side only,
    // the storefront purges nothing and says nothing — so the strings
    // are pinned here rather than derived from `catalogTags`.
    expect(purge.body.tags).toEqual([
      `t:${tenantId}:catalog`,
      `t:${tenantId}:slugs`,
      `t:${tenantId}:categories`,
      `t:${tenantId}:product:${productId}`,
    ]);
  });

  it("has already committed the row by the time the purge arrives", async () => {
    const productId = await createProduct("Before The Rename");
    received = [];
    watchProductId = productId;

    const { status } = await renameProduct(productId, "After The Rename", "after-the-rename");
    expect(status).toBe(200);

    expect(received).toHaveLength(1);
    // Read by a DIFFERENT connection at the moment the purge landed.
    // Under READ COMMITTED this is the old title if the purge was
    // issued from inside the transaction, and the new one if the
    // transaction had already committed.
    expect(received[0]!.titleVisibleToOthers).toBe("After The Rename");
  });

  it("purges a taxonomy write without any product tag", async () => {
    const { POST: createCategoryRoute } = await import("../src/app/api/categories/route");

    received = [];
    const response = await createCategoryRoute(
      jsonRequest("http://console.test/api/categories", { title: `Cat ${randomUUID().slice(0, 6)}` }),
    );
    expect(response.status).toBe(201);

    expect(received).toHaveLength(1);
    expect(received[0]!.body.tags).toEqual([
      `t:${tenantId}:catalog`,
      `t:${tenantId}:slugs`,
      `t:${tenantId}:categories`,
    ]);
  });
});

describe("a failed purge never fails the merchant's write", () => {
  /**
   * The row is committed and correct; the cache is stale for at most the
   * TTL. Turning that into a 500 would tell a merchant their save failed
   * when it did not, and the retry would be a second identical write.
   */
  it("survives a storefront that refuses the connection", async () => {
    const productId = await createProduct("Refused Connection");

    // Port 1 — privileged, nothing listens, and the connection is
    // refused immediately rather than timing out.
    process.env.STOREFRONT_INTERNAL_ORIGIN = "http://127.0.0.1:1";

    const { status } = await renameProduct(productId, "Saved Anyway", "saved-anyway");

    expect(status).toBe(200);
    expect(await titleOf(productId)).toBe("Saved Anyway");
  });

  it("survives a storefront that answers 500", async () => {
    const productId = await createProduct("Error Response");
    behaviour = "error";
    received = [];

    const { status } = await renameProduct(productId, "Saved Despite 500", "saved-despite-500");

    expect(status).toBe(200);
    expect(await titleOf(productId)).toBe("Saved Despite 500");
    // The request really was made and really did fail.
    expect(received).toHaveLength(1);
  });

  it("survives a storefront that never answers, without hanging the save", async () => {
    const productId = await createProduct("Hanging Storefront");
    behaviour = "hang";
    received = [];

    const startedAt = Date.now();
    const { status } = await renameProduct(productId, "Saved Despite Hang", "saved-despite-hang");
    const elapsed = Date.now() - startedAt;

    expect(status).toBe(200);
    expect(await titleOf(productId)).toBe("Saved Despite Hang");
    expect(received).toHaveLength(1);
    // Bounded by the purge timeout rather than by the socket's own,
    // which is minutes. 10s is generous room around the 2s budget and
    // still fails loudly if the timeout is ever removed.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("survives a misconfigured origin", async () => {
    const productId = await createProduct("Misconfigured");

    for (const bad of ["", "not a url"]) {
      process.env.STOREFRONT_INTERNAL_ORIGIN = bad;

      const title = `Saved With ${bad === "" ? "Unset" : "Garbage"}`;
      const { status } = await renameProduct(
        productId,
        title,
        `saved-${bad === "" ? "unset" : "garbage"}`,
      );

      expect(status, bad).toBe(200);
      expect(await titleOf(productId)).toBe(title);
    }
  });

  it("survives a storefront that refuses the secret", async () => {
    const productId = await createProduct("Wrong Secret");
    // The console and the storefront disagreeing about the secret is a
    // 403 on every purge — and still must not break saving.
    process.env.INTERNAL_API_SECRET = "";
    received = [];

    const { status } = await renameProduct(productId, "Saved Unauthorised", "saved-unauthorised");

    expect(status).toBe(200);
    expect(await titleOf(productId)).toBe("Saved Unauthorised");
    // Nothing was even sent: with no secret to present there is nothing
    // the storefront would accept.
    expect(received).toHaveLength(0);
  });
});

describe("the CSV importer purges once, and only on a commit", () => {
  const header = ["handle", "title", "sku", "price", "weight_grams"];

  function file(handle: string, title: string): string[][] {
    return [header, [handle, title, `IMP-${randomUUID().slice(0, 8)}`, "1000", "200"]];
  }

  it("does not purge a dry run", async () => {
    received = [];

    const report = await runCatalogImport(
      { tenantId, actorUserId: ownerUserId },
      file(`dry-${randomUUID().slice(0, 6)}`, "Dry Run Product"),
      // No `commit`, which is the default and the safe one.
    );

    expect(report.committed).toBe(false);
    // Nothing was written, so there is nothing to invalidate. Purging
    // here would evict a correct cache for a write that did not happen.
    expect(received).toHaveLength(0);
  });

  it("does not purge a committed file that changed nothing", async () => {
    const handle = `noop-${randomUUID().slice(0, 6)}`;
    const rows = file(handle, "No-Op Product");

    // First commit creates it, and purges — that much is the test below.
    const created = await runCatalogImport({ tenantId, actorUserId: ownerUserId }, rows, {
      commit: true,
    });
    expect(created.created).toBe(1);

    received = [];

    // The same file again. This is the ordinary case, not a contrived
    // one: a merchant exports their catalog, reads it in a spreadsheet,
    // changes nothing and uploads it again.
    const again = await runCatalogImport({ tenantId, actorUserId: ownerUserId }, rows, {
      commit: true,
    });

    expect(again.committed).toBe(true);
    expect({ created: again.created, updated: again.updated, skipped: again.skipped }).toEqual({
      created: 0,
      updated: 0,
      skipped: 1,
    });

    // Nothing was written — no audit row, no `updated_at` bump — so
    // there is nothing to invalidate. Purging would empty the tenant's
    // ENTIRE catalog cache and refill it against Postgres for a file
    // that did not change a byte.
    expect(received).toHaveLength(0);
  });

  it("purges once for a committed file, with no per-product tags", async () => {
    received = [];

    const report = await runCatalogImport(
      { tenantId, actorUserId: ownerUserId },
      file(`live-${randomUUID().slice(0, 6)}`, "Committed Product"),
      { commit: true },
    );

    expect(report.committed).toBe(true);
    expect(received).toHaveLength(1);
    // Tenant-wide only. `t:<tenant>:catalog` is on every cached entry,
    // so a thousand-row import does not need a thousand tags — and the
    // endpoint caps them at 64.
    expect(received[0]!.body.tags).toEqual([
      `t:${tenantId}:catalog`,
      `t:${tenantId}:slugs`,
      `t:${tenantId}:categories`,
    ]);
  });
});
