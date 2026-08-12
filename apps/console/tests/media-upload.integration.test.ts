import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeRedis } from "@platform/core";
import { mediaStorageKey, sha256 } from "@platform/core/media";
import { closeConnections } from "@platform/db";
import { getStorage } from "@platform/integrations/storage";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The upload route against real Postgres, real libvips, real object
 * storage and a real session.
 *
 * `next/headers` is the one thing stubbed: `cookies()` reads request-
 * scoped async storage that only exists inside a Next server. The token
 * it returns is a genuine session row, so `resolveSession`, the
 * membership lookup and the permission check all run for real — the stub
 * replaces the framework's transport, not the security.
 */

// Set BEFORE getStorage() is first called — it caches the driver.
const MEDIA_ROOT = join(tmpdir(), `platform-console-media-test-${randomUUID()}`);
process.env.STORAGE_DRIVER = "local";
process.env.MEDIA_LOCAL_ROOT = MEDIA_ROOT;

/** Mutable so each test can present a different (or no) session. */
let sessionToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "console_session" && sessionToken ? { name, value: sessionToken } : undefined,
    }),
  headers: () => Promise.resolve(new Headers()),
}));

const { POST } = await import("../src/app/api/media/upload/route");
const { closeQueues } = await import("../src/lib/queue");

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

type MediaRow = {
  id: string;
  tenant_id: string;
  storage_key: string;
  mime_type: string;
  byte_size: number;
  status: string;
  deleted_at: Date | null;
  created_by_user_id: string | null;
};

let tenantA: string;
let tenantB: string;
let ownerToken: string;
let ownerUserId: string;
let cashierToken: string;

async function makeTenant(): Promise<string> {
  const slug = "u-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"u-" + randomUUID().slice(0, 8)}, 'Upload test plan')
    RETURNING id`;
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  return tenant!.id;
}

/** A real staff row, membership and session; returns the raw token. */
async function makeSession(
  tenantId: string,
  role: string,
): Promise<{ token: string; userId: string }> {
  const userId = randomUUID();
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userId}, ${phone}, 'Upload test')`;
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

function uploadRequest(parts: Record<string, string | File>): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(parts)) form.append(name, value);
  return new Request("http://console.test/api/media/upload", { method: "POST", body: form });
}

async function readMediaByTenant(tenantId: string): Promise<MediaRow[]> {
  return admin<MediaRow[]>`
    SELECT id, tenant_id, storage_key, mime_type, byte_size, status, deleted_at,
           created_by_user_id
    FROM media WHERE tenant_id = ${tenantId} ORDER BY created_at`;
}

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();

  const owner = await makeSession(tenantA, "owner");
  ownerToken = owner.token;
  ownerUserId = owner.userId;

  // catalog:read but NOT catalog:write — see ROLE_PERMISSIONS.
  cashierToken = (await makeSession(tenantA, "cashier")).token;
});

afterEach(() => {
  sessionToken = undefined;
});

afterAll(async () => {
  await closeQueues();
  await closeRedis();
  await admin.end();
  await closeConnections();
  await rm(MEDIA_ROOT, { recursive: true, force: true });
});

describe("POST /api/media/upload", () => {
  it("refuses an unauthenticated request before reading the body", async () => {
    const response = await POST(uploadRequest({ file: new File(["x"], "a.png") }));

    expect(response.status).toBe(401);
    expect(await readMediaByTenant(tenantA)).toHaveLength(0);
  });

  it("refuses an authenticated actor without catalog:write", async () => {
    sessionToken = cashierToken;

    const png = await sharp({
      create: { width: 60, height: 60, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const response = await POST(
      uploadRequest({ file: new File([png], "a.png", { type: "image/png" }) }),
    );

    expect(response.status).toBe(403);
    expect(await readMediaByTenant(tenantA)).toHaveLength(0);
  });

  it("refuses an HTML document declared image/png", async () => {
    sessionToken = ownerToken;

    const response = await POST(
      uploadRequest({
        file: new File(["<!DOCTYPE html><script>alert(1)</script>"], "x.png", {
          type: "image/png",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_image_type" },
    });
    expect(await readMediaByTenant(tenantA)).toHaveLength(0);
  });

  it("caps the body when the request declares no Content-Length", async () => {
    sessionToken = ownerToken;

    // A chunked / HTTP-2 style body: no length header to check, so only
    // counting bytes off the socket can stop it. 12 MB in 1 MB chunks.
    let remaining = 12;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining === 0) {
          controller.close();
          return;
        }
        remaining -= 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });

    const request = new Request("http://console.test/api/media/upload", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----x" },
      body,
      // Required by undici for a streaming request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "file_too_large" } });
  });

  it("strips EXIF from the stored ORIGINAL and bakes the orientation in", async () => {
    sessionToken = ownerToken;

    // 1000×500 stored pixels tagged Orientation 6 — a quarter turn, so
    // what a human sees is 500×1000 — carrying the sort of payload a
    // phone attaches. The ORIGINAL is what ProductGrid, the PDP hero and
    // JSON-LD `image` all link, so this is the byte stream that would
    // otherwise publish the merchant's home coordinates.
    const jpeg = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: { r: 200, g: 90, b: 40 } },
    })
      .withMetadata({
        orientation: 6,
        exif: {
          IFD0: { Copyright: "MERCHANT-HOME-ADDRESS" },
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 30/1" },
        },
      })
      .jpeg()
      .toBuffer();

    // Precondition: the upload really does carry what must be lost.
    const uploadedMeta = await sharp(jpeg).metadata();
    expect(uploadedMeta.exif?.toString("latin1")).toContain("MERCHANT-HOME-ADDRESS");
    expect(uploadedMeta.orientation).toBe(6);

    const response = await POST(
      uploadRequest({ file: new File([jpeg], "phone.jpg", { type: "image/jpeg" }) }),
    );
    expect(response.status).toBe(201);

    const rows = await readMediaByTenant(tenantA);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    const storedMeta = await sharp(await getStorage().get(row.storage_key)).metadata();

    expect(storedMeta.exif).toBeUndefined();
    expect(storedMeta.orientation).toBeUndefined();
    // Baked, not merely dropped: strip without rotating and this is
    // 1000×500, and every portrait photo ships sideways.
    expect(storedMeta.width).toBe(500);
    expect(storedMeta.height).toBe(1000);

    // The checksum still keys the UPLOADED bytes, so dedupe matches what
    // the merchant sent rather than what we happened to re-encode.
    expect(row.storage_key).toBe(
      mediaStorageKey({ tenantId: tenantA, checksum: await sha256(jpeg), ext: "jpg" }),
    );
    expect(row.byte_size).toBe((await getStorage().get(row.storage_key)).length);
    expect(row.status).toBe("pending");
    expect(row.created_by_user_id).toBe(ownerUserId);
  });

  it("accepts a PNG the client named .jpg, on its real type", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 700, height: 400, channels: 3, background: { r: 9, g: 40, b: 90 } },
    })
      .png()
      .toBuffer();

    const response = await POST(
      uploadRequest({ file: new File([png], "photo.jpg", { type: "image/jpeg" }) }),
    );
    expect(response.status).toBe(201);

    const row = (await readMediaByTenant(tenantA)).at(-1)!;
    expect(row.mime_type).toBe("image/png");
    expect(row.storage_key.endsWith(".png")).toBe(true);
  });

  it("takes the tenant from the session and ignores one in the body", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 120, height: 120, channels: 3, background: { r: 3, g: 3, b: 3 } },
    })
      .png()
      .toBuffer();

    const response = await POST(
      uploadRequest({
        file: new File([png], "x.png", { type: "image/png" }),
        tenantId: tenantB,
      }),
    );
    expect(response.status).toBe(201);

    const { mediaId } = (await response.json()) as { mediaId: string };
    const [row] = await admin<{ tenant_id: string; storage_key: string }[]>`
      SELECT tenant_id, storage_key FROM media WHERE id = ${mediaId}`;

    expect(row!.tenant_id).toBe(tenantA);
    expect(row!.tenant_id).not.toBe(tenantB);
    expect(row!.storage_key.startsWith(`${tenantA}/`)).toBe(true);
    expect(await readMediaByTenant(tenantB)).toHaveLength(0);
  });

  it("returns the existing row instead of reprocessing an identical upload", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 77, g: 12, b: 12 } },
    })
      .png()
      .toBuffer();

    const first = await POST(
      uploadRequest({ file: new File([png], "dup.png", { type: "image/png" }) }),
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { mediaId: string };

    const before = (await readMediaByTenant(tenantA)).length;

    const second = await POST(
      uploadRequest({ file: new File([png], "dup-again.png", { type: "image/png" }) }),
    );

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      mediaId: firstBody.mediaId,
      deduplicated: true,
    });
    expect(await readMediaByTenant(tenantA)).toHaveLength(before);
  });

  it("revives a soft-deleted row rather than colliding with it forever", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 260, height: 130, channels: 3, background: { r: 44, g: 99, b: 22 } },
    })
      .png()
      .toBuffer();

    const first = await POST(
      uploadRequest({ file: new File([png], "gone.png", { type: "image/png" }) }),
    );
    expect(first.status).toBe(201);
    const { mediaId } = (await first.json()) as { mediaId: string };

    // What Task 4's delete will do. The dedupe SELECT filters
    // `deleted_at IS NULL`, but the unique index on (tenant, storage_key)
    // has no such predicate — so this upload used to collide, and would
    // have kept colliding for this file forever.
    await admin`UPDATE media SET deleted_at = now(), status = 'ready' WHERE id = ${mediaId}`;

    const second = await POST(
      uploadRequest({ file: new File([png], "back.png", { type: "image/png" }) }),
    );

    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ mediaId, status: "pending" });

    const [row] = await admin<{ deleted_at: Date | null; status: string }[]>`
      SELECT deleted_at, status FROM media WHERE id = ${mediaId}`;
    expect(row!.deleted_at).toBeNull();
    expect(row!.status).toBe("pending");
  });
});
