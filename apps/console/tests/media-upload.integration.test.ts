import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeRedis } from "@platform/core";
import { MAX_IMAGE_PIXELS, mediaStorageKey, sha256 } from "@platform/core/media";
import { closeConnections } from "@platform/db";
import { getStorage } from "@platform/integrations/storage";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MAX_UPLOAD_PIXELS } from "../src/lib/image";

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

/**
 * The producer is stubbed, deliberately.
 *
 * A real `add()` puts a job on the SHARED `media` queue at whatever
 * REDIS_URL is configured, pointing at a temp media root this file
 * deletes in `afterAll`. A developer with a worker running then burns
 * five retries and a backoff cycle on each before dead-lettering it —
 * every time anyone runs the suite. `obliterate()` in `afterAll` would
 * fix that by also wiping their genuine local jobs, which is worse.
 *
 * What the route owns is the CALL and its payload, and that is asserted
 * below; the BullMQ wiring is one `queue.add` and is exercised by the
 * live run recorded in the task report.
 */
const enqueued: { tenantId: string; mediaId: string }[] = [];
let enqueueFails = false;

vi.mock("../src/lib/queue", () => ({
  enqueueMediaProcessing: (payload: { tenantId: string; mediaId: string }) => {
    if (enqueueFails) return Promise.reject(new Error("redis unavailable"));
    enqueued.push(payload);
    return Promise.resolve();
  },
}));

const { POST } = await import("../src/app/api/media/upload/route");

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
let tenantOrphan: string;
let orphanToken: string;

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

  tenantOrphan = await makeTenant();
  orphanToken = (await makeSession(tenantOrphan, "owner")).token;
});

afterEach(() => {
  sessionToken = undefined;
  enqueueFails = false;
});

afterAll(async () => {
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

  it("refuses an animated WebP rather than silently flattening it", async () => {
    sessionToken = ownerToken;
    const rowsBefore = (await readMediaByTenant(tenantA)).length;
    const queuedBefore = enqueued.length;

    // A genuine three-frame animation: frames stacked vertically and
    // tagged with pageHeight, which is how libvips models animation.
    const width = 60;
    const frameHeight = 40;
    const frames = 3;
    const raw = Buffer.alloc(width * frameHeight * frames * 4);
    for (let i = 0; i < frames; i += 1) {
      for (let p = 0; p < width * frameHeight; p += 1) {
        const o = (i * width * frameHeight + p) * 4;
        raw[o] = i * 80;
        raw[o + 1] = 255 - i * 80;
        raw[o + 2] = 30;
        raw[o + 3] = 255;
      }
    }
    const animated = await sharp(raw, {
      raw: { width, height: frameHeight * frames, channels: 4, pageHeight: frameHeight },
    })
      .webp({ loop: 0, delay: 120 })
      .toBuffer();

    // Precondition: it really is multi-frame, and the sanitiser's own
    // re-encode really would drop the frames.
    expect((await sharp(animated, { limitInputPixels: false }).metadata()).pages).toBe(frames);

    const response = await POST(
      uploadRequest({ file: new File([animated], "spin.webp", { type: "image/webp" }) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "animated_image_unsupported" },
    });
    // Nothing stored, nothing queued: told, not silently degraded.
    expect(await readMediaByTenant(tenantA)).toHaveLength(rowsBefore);
    expect(enqueued).toHaveLength(queuedBefore);
  });

  it("refuses an APNG, which libvips reports no pages for", async () => {
    sessionToken = ownerToken;
    const rowsBefore = (await readMediaByTenant(tenantA)).length;

    // Hand-built, because sharp will not write one: signature, IHDR,
    // acTL (the animation control chunk), IDAT, IEND.
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const chunk = (type: string, data: Buffer): Buffer => {
      const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
      let c = 0xffffffff;
      for (const byte of typed) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
      return Buffer.concat([length, typed, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(40, 0);
    ihdr.writeUInt32BE(30, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(3, 0); // num_frames
    const apng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("acTL", actl),
      chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
      chunk("IEND", Buffer.alloc(0)),
    ]);

    // Precondition: sharp cannot tell. `pages` is undefined for an APNG,
    // so the multi-page check alone would let this through.
    expect(
      (await sharp(apng, { limitInputPixels: false }).metadata()).pages,
    ).toBeUndefined();

    const response = await POST(
      uploadRequest({ file: new File([apng], "loop.png", { type: "image/png" }) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "animated_image_unsupported" },
    });
    expect(await readMediaByTenant(tenantA)).toHaveLength(rowsBefore);
  });

  it("refuses an image above the request path's pixel ceiling", async () => {
    sessionToken = ownerToken;
    const rowsBefore = (await readMediaByTenant(tenantA)).length;

    // The ceiling is PINNED, not read from the constant to build the
    // fixture — a fixture sized from MAX_UPLOAD_PIXELS scales with it and
    // the test can never fail, however high the ceiling is raised.
    expect(MAX_UPLOAD_PIXELS).toBe(30_000_000);
    // And it must stay BELOW the worker's: the worker decodes two at a
    // time in its own process, this decodes unbounded inside the console.
    expect(MAX_UPLOAD_PIXELS).toBeLessThan(MAX_IMAGE_PIXELS);

    // 31.2 MP: legal, well under the 10 MB byte cap, and ~125 MB of raw
    // pixels to decode. This is the shape that makes an unbounded
    // web-tier decode dangerous.
    const huge = await sharp({
      create: { width: 6000, height: 5200, channels: 3, background: { r: 7, g: 7, b: 7 } },
    })
      .png()
      .toBuffer();

    expect(huge.length).toBeLessThan(1024 * 1024);
    expect(6000 * 5200).toBeGreaterThan(MAX_UPLOAD_PIXELS);

    const response = await POST(
      uploadRequest({ file: new File([huge], "huge.png", { type: "image/png" }) }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "image_too_large" } });
    expect(await readMediaByTenant(tenantA)).toHaveLength(rowsBefore);
  });

  it("marks the row failed when the job cannot be queued", async () => {
    // Its own tenant: this is the one negative-path test that DOES write
    // a row, and the counts elsewhere should not have to know about it.
    sessionToken = orphanToken;
    enqueueFails = true;

    const png = await sharp({
      create: { width: 80, height: 80, channels: 3, background: { r: 6, g: 6, b: 6 } },
    })
      .png()
      .toBuffer();

    const response = await POST(
      uploadRequest({ file: new File([png], "orphan.png", { type: "image/png" }) }),
    );

    // Redis is down. The row must not be left `pending` forever — a
    // spinner nobody is alerted about is invisible breakage.
    expect(response.status).toBe(500);

    const rows = await readMediaByTenant(tenantOrphan);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
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

    // The call the route owns: the worker's tenant comes from here, and
    // getting it from anywhere else is the cross-tenant bug.
    expect(enqueued.at(-1)).toEqual({ tenantId: tenantA, mediaId: row.id });
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

  it("retries a FAILED row when the same file is uploaded again", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 210, height: 140, channels: 3, background: { r: 3, g: 61, b: 90 } },
    })
      .png()
      .toBuffer();

    const first = await POST(
      uploadRequest({ file: new File([png], "retry.png", { type: "image/png" }) }),
    );
    expect(first.status).toBe(201);
    const { mediaId } = (await first.json()) as { mediaId: string };

    // What the worker writes when libvips or storage lets it down, and
    // what the route itself writes when Redis is unreachable. Nothing
    // retries it: there is no retry endpoint, and the console renders a
    // status line rather than a button.
    await admin`
      UPDATE media SET status = 'failed', processing_error = 'libvips said no'
      WHERE id = ${mediaId}`;

    const before = (await readMediaByTenant(tenantA)).length;
    const enqueuedBefore = enqueued.length;

    const second = await POST(
      uploadRequest({ file: new File([png], "retry-again.png", { type: "image/png" }) }),
    );

    // NOT a 200 `deduplicated: true`. That was the defect: the dedupe
    // SELECT matched the failed row, the route returned it untouched and
    // never re-enqueued, and the merchant's only escape was altering the
    // bytes to change the checksum.
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ mediaId, status: "pending" });

    // The same row, reset — not a second one. `(tenant, storage_key)` is
    // unique and the key is the checksum, so a duplicate is impossible
    // anyway; this pins that the conflict was resolved by repairing.
    expect(await readMediaByTenant(tenantA)).toHaveLength(before);

    const [row] = await admin<{ status: string; processing_error: string | null }[]>`
      SELECT status, processing_error FROM media WHERE id = ${mediaId}`;
    expect(row!.status).toBe("pending");
    expect(row!.processing_error).toBeNull();

    // The half that makes it a retry rather than a relabel.
    expect(enqueued.slice(enqueuedBefore)).toEqual([{ tenantId: tenantA, mediaId }]);
  });

  it("returns the alt already on the row it deduplicated onto", async () => {
    sessionToken = ownerToken;

    const png = await sharp({
      create: { width: 190, height: 190, channels: 3, background: { r: 120, g: 4, b: 200 } },
    })
      .png()
      .toBuffer();

    const first = await POST(
      uploadRequest({ file: new File([png], "shared.png", { type: "image/png" }) }),
    );
    expect(first.status).toBe(201);
    const { mediaId, alt: freshAlt } = (await first.json()) as {
      mediaId: string;
      alt: string | null;
    };

    // A brand-new row has no alt, and the response says so with null
    // rather than "". The console treats null as "nothing to write".
    expect(freshAlt).toBeNull();

    await admin`UPDATE media SET alt = 'A folded linen shirt' WHERE id = ${mediaId}`;

    const second = await POST(
      uploadRequest({ file: new File([png], "shared-again.png", { type: "image/png" }) }),
    );

    // Without this the console attaches the image with a blank alt and
    // the next save writes that blank to `media.alt` — which is shared,
    // so it clears the sentence on EVERY product using the photograph,
    // without the merchant touching the box.
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      mediaId,
      deduplicated: true,
      alt: "A folded linen shirt",
    });
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
