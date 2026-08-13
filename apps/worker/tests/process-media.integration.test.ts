import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeConnections } from "@platform/db";
import { derivativeStorageKey, mediaStorageKey, sha256 } from "@platform/core/media";
import type { MediaDerivative } from "@platform/core/media";
import { getStorage } from "@platform/integrations/storage";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { processMedia } from "../src/jobs/process-media";

/**
 * The media pipeline against real Postgres, real libvips and the real
 * local storage driver.
 *
 * None of what matters here is checkable any other way: whether libvips
 * honours the pixel limit, whether the rows it writes have the shape the
 * storefront's `srcset` builder reads, whether RLS lets the job see a
 * row at all. Mocking any of the three would test the mock.
 */

// Set BEFORE getStorage() is first called — it caches the driver.
const MEDIA_ROOT = join(tmpdir(), `platform-media-test-${randomUUID()}`);
process.env.STORAGE_DRIVER = "local";
process.env.MEDIA_LOCAL_ROOT = MEDIA_ROOT;

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

// BYPASSRLS, so setup and read-back are independent of the tenant
// context the job under test is responsible for setting.
const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

type MediaRow = {
  status: string;
  width: number | null;
  height: number | null;
  checksum: string | null;
  derivatives: unknown;
  processing_error: string | null;
  storage_key?: string | null;
};

let tenantA: string;
let tenantB: string;

async function readMedia(id: string): Promise<MediaRow> {
  const rows = await admin<MediaRow[]>`
    SELECT status, width, height, checksum, derivatives, processing_error, storage_key
    FROM media WHERE id = ${id}`;
  const row = rows[0];
  if (!row) throw new Error(`media ${id} vanished`);
  return row;
}

/** Alias for readMedia — matches task brief nomenclature. */
const adminRow = readMedia;

/** Stores the bytes and inserts the `pending` row the upload endpoint would. */
async function givenPendingMedia(
  tenantId: string,
  opts: { bytes?: Buffer; checksum?: string | null; mimeType?: string; ext?: string; store?: boolean },
): Promise<{ id: string; checksum: string; storageKey: string }> {
  const bytes = opts.bytes ?? (await fixtureImage());
  const checksum = opts.checksum !== undefined ? opts.checksum : await sha256(bytes);
  const mimeType = opts.mimeType ?? "image/png";
  const ext = opts.ext ?? "png";
  // Use a unique key per test row to avoid storage_key collisions when
  // testing multiple rows with identical bytes.
  const uniqueKey = checksum ?? randomUUID();
  const storageKey = mediaStorageKey({ tenantId, checksum: uniqueKey, ext });

  if (opts.store !== false) {
    await getStorage().put(storageKey, bytes, { contentType: mimeType });
  }

  const id = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, checksum, status)
    VALUES (${id}, ${tenantId}, ${storageKey}, ${mimeType}, ${bytes.length},
            ${checksum}, 'pending')`;

  return { id, checksum: checksum ?? "", storageKey };
}

/** Inserts a `ready` row with derivatives already built. */
async function givenReadyMedia(
  tenantId: string,
  opts: { checksum: string; bytes: Buffer },
): Promise<{ id: string; checksum: string; storageKey: string }> {
  const { checksum, bytes } = opts;
  const storageKey = mediaStorageKey({ tenantId, checksum, ext: "png" });

  await getStorage().put(storageKey, bytes, { contentType: "image/png" });

  const metadata = await sharp(bytes).metadata();
  const derivatives: MediaDerivative[] = [
    {
      format: "avif",
      width: metadata.width ?? 100,
      height: metadata.height ?? 100,
      storageKey: derivativeStorageKey({ tenantId, checksum, width: metadata.width ?? 100, format: "avif" }),
      byteSize: 1234,
    },
  ];

  const id = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, checksum, status, width, height, derivatives)
    VALUES (${id}, ${tenantId}, ${storageKey}, ${"image/png"}, ${bytes.length},
            ${checksum}, 'ready', ${metadata.width ?? 100}, ${metadata.height ?? 100},
            ${JSON.stringify(derivatives)}::text::jsonb)`;

  return { id, checksum, storageKey };
}

/** Returns a minimal valid PNG fixture. */
async function fixtureImage(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 100, b: 150 } },
  })
    .png()
    .toBuffer();
}

/** Returns sha256 hex of given bytes, matching what the worker computes. */
function sha256hex(bytes: Buffer): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function asDerivatives(value: unknown): MediaDerivative[] {
  expect(Array.isArray(value)).toBe(true);
  return value as MediaDerivative[];
}

/**
 * A PNG whose IHDR claims enormous dimensions but whose payload is a few
 * bytes — the decompression bomb this pipeline exists to refuse. 10^8
 * pixels is deliberately BELOW sharp's own 268M-pixel default and above
 * our 50M ceiling, so this test fails the moment `limitInputPixels` is
 * dropped from the job.
 */
function bombPng(width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuf = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([length, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A stub storefront, standing in for the purge endpoint.
 *
 * It exists for two reasons. The first is that `vitest.integration.config.ts`
 * loads the repo `.env`, which points `STOREFRONT_INTERNAL_ORIGIN` at
 * `http://localhost:3000` — so without an origin of our own, every job
 * in this file would POST the real internal secret at whatever holds
 * that port. The second is that the purge is a property of the job now:
 * the console purges while the row is still `pending`, so if this one
 * does not purge on completion, the storefront serves a placeholder card
 * and a hero-less PDP for the full 300s TTL.
 */
let purgeServer: Server;
let purged: { secret: string | null; body: { tenantId?: string; tags?: string[] } }[] = [];

function startStubStorefront(): Promise<{ server: Server; origin: string }> {
  const created = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      purged.push({
        secret: (req.headers["x-internal-secret"] as string | undefined) ?? null,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
          tenantId?: string;
          tags?: string[];
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"purged":3}');
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

const PURGE_SECRET = "worker-purge-secret-77c31e";

beforeAll(async () => {
  const started = await startStubStorefront();
  purgeServer = started.server;
  process.env.STOREFRONT_INTERNAL_ORIGIN = started.origin;
  process.env.INTERNAL_API_SECRET = PURGE_SECRET;

  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"m-" + randomUUID().slice(0, 8)}, 'Media test plan')
    RETURNING id`;

  const mkTenant = async () => {
    const slug = "m-" + randomUUID().slice(0, 12);
    const [t] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
      RETURNING id`;
    return t!.id;
  };

  tenantA = await mkTenant();
  tenantB = await mkTenant();
});

beforeEach(() => {
  purged = [];
});

afterAll(async () => {
  await new Promise<void>((resolve) => purgeServer.close(() => resolve()));
  await admin.end();
  await closeConnections();
  await rm(MEDIA_ROOT, { recursive: true, force: true });
});

describe("processMedia", () => {
  it("turns a pending PNG into a ready row with readable derivatives", async () => {
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();

    const { id, checksum } = await givenPendingMedia(tenantA, {
      bytes: png,
      mimeType: "image/png",
      ext: "png",
    });

    const result = await processMedia({ tenantId: tenantA, mediaId: id });
    expect(result).toEqual({ width: 1200, height: 800, derivatives: 12 });

    const row = await readMedia(id);
    expect(row.status).toBe("ready");
    expect(row.processing_error).toBeNull();
    expect(row.width).toBe(1200);
    expect(row.height).toBe(800);

    const derivatives = asDerivatives(row.derivatives);

    // 320/480/640/960 fit inside 1200; 1280 and 1920 would be upscales.
    expect(derivatives).toHaveLength(12);
    expect([...new Set(derivatives.map((d) => d.width))].sort((a, b) => a - b)).toEqual([
      320, 480, 640, 960,
    ]);
    expect(new Set(derivatives.map((d) => d.format))).toEqual(
      new Set(["avif", "webp", "jpeg"]),
    );

    // The shape the storefront reads. An extra or missing key here is
    // the failure that renders nothing and reports nothing.
    for (const derivative of derivatives) {
      expect(Object.keys(derivative).sort()).toEqual([
        "byteSize",
        "format",
        "height",
        "storageKey",
        "width",
      ]);
      expect(derivative.byteSize).toBeGreaterThan(0);
      // 1200×800 is 3:2, so every derivative keeps that ratio.
      expect(derivative.height).toBe(Math.round((derivative.width * 800) / 1200));
      expect(derivative.storageKey).toBe(
        derivativeStorageKey({
          tenantId: tenantA,
          checksum,
          width: derivative.width,
          format: derivative.format,
        }),
      );
    }

    // Actually readable back out, and actually the format claimed.
    const storage = getStorage();
    for (const derivative of derivatives) {
      const stored = await storage.get(derivative.storageKey);
      expect(stored.length).toBe(derivative.byteSize);

      const decoded = await sharp(stored).metadata();
      // libvips reports AVIF as its container, HEIF, plus the codec.
      if (derivative.format === "avif") {
        expect(decoded.format).toBe("heif");
        expect(decoded.compression).toBe("av1");
      } else {
        expect(decoded.format).toBe(derivative.format);
      }
      expect(decoded.width).toBe(derivative.width);
      expect(decoded.height).toBe(derivative.height);
    }
  });

  it("rotates per EXIF orientation and strips the metadata that rotation came from", async () => {
    // 1000×500 pixels stored, tagged Orientation 6: a quarter turn, so
    // the image a human sees is 500×1000. The EXIF also carries the kind
    // of payload a phone attaches — publishing that on a product page
    // publishes the merchant's location.
    const jpeg = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: { r: 200, g: 90, b: 40 } },
    })
      .withMetadata({
        orientation: 6,
        exif: {
          IFD0: { Copyright: "MERCHANT-HOME-ADDRESS" },
          // IFD3 is the GPS directory — the one a phone fills in.
          IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 30/1" },
        },
      })
      .jpeg()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, {
      bytes: jpeg,
      mimeType: "image/jpeg",
      ext: "jpg",
    });

    // Precondition: the original really does carry what we expect to lose.
    const originalMeta = await sharp(jpeg).metadata();
    expect(originalMeta.orientation).toBe(6);
    expect(originalMeta.exif?.toString("latin1")).toContain("MERCHANT-HOME-ADDRESS");

    await processMedia({ tenantId: tenantA, mediaId: id });

    const row = await readMedia(id);
    // Upright dimensions, not stored ones. Recording 1000×500 here puts
    // the wrong width/height on every <img> and inverts the plan.
    expect(row.width).toBe(500);
    expect(row.height).toBe(1000);

    const derivatives = asDerivatives(row.derivatives);
    // 320 and 480 fit inside 500; 640 would not. Planning from the
    // unrotated 1000 would have produced 640 and 960 as well.
    expect([...new Set(derivatives.map((d) => d.width))].sort((a, b) => a - b)).toEqual([320, 480]);
    expect(derivatives).toHaveLength(6);

    const storage = getStorage();
    for (const derivative of derivatives) {
      const decoded = await sharp(await storage.get(derivative.storageKey)).metadata();

      // Portrait: without .rotate() this would be 320×160.
      expect(decoded.height).toBeGreaterThan(decoded.width!);
      expect(decoded.height).toBe(derivative.width * 2);

      expect(decoded.exif).toBeUndefined();
      expect(decoded.orientation).toBeUndefined();
    }

    // NOTE: this fixture is stored by the test, so it still carries its
    // EXIF. Real originals do not: the upload route strips them before
    // anything is written, because the ORIGINAL is what the storefront
    // links (ProductGrid `src`, PDP hero, JSON-LD `image`) and stripping
    // only the derivatives would publish the merchant's GPS anyway. That
    // contract is owned and tested by
    // apps/console/tests/media-upload.integration.test.ts.
  });

  it("still produces a derivative for an original smaller than every breakpoint", async () => {
    const tiny = await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .png()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, { bytes: tiny, mimeType: "image/png", ext: "png" });

    await processMedia({ tenantId: tenantA, mediaId: id });

    const row = await readMedia(id);
    expect(row.status).toBe("ready");

    const derivatives = asDerivatives(row.derivatives);
    // One per format — an empty derivatives array is an empty srcset,
    // and some browsers then fetch no image at all.
    expect(derivatives).toHaveLength(3);

    for (const derivative of derivatives) {
      // Recorded at its TRUE size, not at the 320 it was planned for:
      // a `320w` descriptor on a 100px file makes the browser pick it
      // for a 320px slot and render it blurry.
      expect(derivative.width).toBe(100);
      expect(derivative.height).toBe(60);

      const decoded = await sharp(await getStorage().get(derivative.storageKey)).metadata();
      expect(decoded.width).toBe(100);
    }
  });

  it("refuses a decompression bomb and records why", async () => {
    // 10^8 pixels from 66 bytes on disk.
    const bomb = bombPng(10_000, 10_000);
    expect(bomb.length).toBeLessThan(200);

    const { id } = await givenPendingMedia(tenantA, { bytes: bomb, mimeType: "image/png", ext: "png" });

    await expect(processMedia({ tenantId: tenantA, mediaId: id })).rejects.toThrow(
      /pixel limit/i,
    );

    const row = await readMedia(id);
    expect(row.status).toBe("failed");
    expect(row.processing_error).toMatch(/pixel limit/i);
    expect(asDerivatives(row.derivatives)).toHaveLength(0);
  });

  it("marks a row failed and rethrows when the original is missing from storage", async () => {
    const png = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, {
      bytes: png,
      mimeType: "image/png",
      ext: "png",
      store: false,
    });

    // Rethrowing is what makes BullMQ retry and eventually dead-letter.
    await expect(processMedia({ tenantId: tenantA, mediaId: id })).rejects.toThrow();

    const row = await readMedia(id);
    // Never left `pending`: a spinner nobody is alerted about is worse
    // than an error somebody can see.
    expect(row.status).toBe("failed");
    expect(row.processing_error).toBeTruthy();
  });

  it("cannot process another tenant's media", async () => {
    const png = await sharp({
      create: { width: 500, height: 500, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, { bytes: png, mimeType: "image/png", ext: "png" });

    // RLS returns zero rows rather than an error, so a job that mixed up
    // its tenant would silently do nothing — or, if the job filtered by
    // id alone, silently process it under the wrong tenant's prefix.
    await expect(processMedia({ tenantId: tenantB, mediaId: id })).rejects.toThrow(/not found/i);

    const row = await readMedia(id);
    expect(row.status).toBe("pending");
    expect(row.processing_error).toBeNull();
    expect(asDerivatives(row.derivatives)).toHaveLength(0);
  });

  it("adopts a checksum collision instead of stranding the row as failed", async () => {
    // Row A: ready, owns checksum X (insert directly with the checksum of
    // the fixture bytes). Row B: pending, checksum NULL, same bytes — the
    // backfill computes X and would collide.
    const bytes = await fixtureImage(); // reuse the suite's smallest valid fixture
    const checksum = sha256hex(bytes);  // same hash the worker computes
    const rowA = await givenReadyMedia(tenantA, { checksum, bytes });
    const rowB = await givenPendingMedia(tenantA, { checksum: null, bytes });

    await processMedia({ tenantId: tenantA, mediaId: rowB.id });

    const b = await adminRow(rowB.id);
    expect(b.status).toBe("ready");
    expect(b.checksum).toBeNull();          // NULLs are distinct under the unique index
    expect(asDerivatives(b.derivatives).length).toBeGreaterThan(0);
    expect(b.processing_error).toBeNull();
  });

  it("writes a merchant-readable failure reason, and the raw error only to the log", async () => {
    // Use slightly different dimensions from the existing bomb test to avoid storage_key collision
    const bomb = bombPng(10_001, 10_001);
    const { id } = await givenPendingMedia(tenantA, { bytes: bomb, mimeType: "image/png", ext: "png" });
    await expect(processMedia({ tenantId: tenantA, mediaId: id })).rejects.toThrow();
    const failed = await adminRow(id);
    expect(failed.status).toBe("failed");
    expect(failed.storage_key).toBeTruthy(); // Ensure the key exists before checking absence
    expect(failed.processing_error).toMatch(/pixel limit/i);       // still names the cause
    expect(failed.processing_error).not.toMatch(/VipsImage|sharp/); // no library internals
    expect(failed.processing_error).not.toContain(failed.storage_key!); // no internal keys
  });
});

describe("processMedia purges the storefront when the row goes ready", () => {
  /**
   * THE SEQUENCE THIS EXISTS FOR
   *
   *   upload → attach → save (the console purges; the storefront caches
   *   the `pending` placeholder) → this job finishes seconds later.
   *
   * Nothing else purges after that, so without this the placeholder card,
   * the hero-less PDP and the empty JSON-LD `image` / OG tags stay live
   * for the whole 300s TTL, with no way for the merchant to force it.
   */
  it("sends the tenant's tags, with the secret, once the row is ready", async () => {
    const png = await sharp({
      create: { width: 700, height: 700, channels: 3, background: { r: 30, g: 90, b: 30 } },
    })
      .png()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, { bytes: png, mimeType: "image/png", ext: "png" });

    await processMedia({ tenantId: tenantA, mediaId: id });

    expect(await readMedia(id)).toMatchObject({ status: "ready" });

    expect(purged).toHaveLength(1);
    expect(purged[0]!.secret).toBe(PURGE_SECRET);
    expect(purged[0]!.body.tenantId).toBe(tenantA);
    // Written out in full rather than taken from `catalogTags`: the
    // failure being guarded is the two sides disagreeing about the
    // string, and a test that asks the implementation what the string is
    // cannot see that. Tenant-wide only — a media row can hang off any
    // number of products and this job does not know which.
    expect(purged[0]!.body.tags).toEqual([
      `t:${tenantA}:catalog`,
      `t:${tenantA}:slugs`,
      `t:${tenantA}:categories`,
    ]);
  });

  it("does not purge for a job that failed", async () => {
    const png = await sharp({
      create: { width: 60, height: 60, channels: 3, background: { r: 4, g: 4, b: 4 } },
    })
      .png()
      .toBuffer();

    // The original is never stored, so the job throws where it reads it.
    const { id } = await givenPendingMedia(tenantA, {
      bytes: png,
      mimeType: "image/png",
      ext: "png",
      store: false,
    });

    await expect(processMedia({ tenantId: tenantA, mediaId: id })).rejects.toThrow();

    expect(await readMedia(id)).toMatchObject({ status: "failed" });
    // Nothing changed on the storefront's side of the row, and BullMQ
    // will retry — a purge per attempt would empty a correct cache five
    // times over for one broken image.
    expect(purged).toHaveLength(0);
  });

  it("does not fail the job when the purge does", async () => {
    const png = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 60, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();

    const { id } = await givenPendingMedia(tenantA, { bytes: png, mimeType: "image/png", ext: "png" });

    const origin = process.env.STOREFRONT_INTERNAL_ORIGIN;
    // Port 1 — privileged, nothing listens, refused immediately rather
    // than timing out.
    process.env.STOREFRONT_INTERNAL_ORIGIN = "http://127.0.0.1:1";
    try {
      // The derivatives are written and committed; the cache is stale for
      // at most the TTL, which is exactly the backstop the TTL is. Rule 2
      // of `catalog/purge.ts`. Throwing here would instead mark a `ready`
      // row `failed` and hand BullMQ a job it can never complete.
      const result = await processMedia({ tenantId: tenantA, mediaId: id });
      expect(result.derivatives).toBeGreaterThan(0);
    } finally {
      process.env.STOREFRONT_INTERNAL_ORIGIN = origin;
    }

    expect(await readMedia(id)).toMatchObject({ status: "ready" });
    expect(purged).toHaveLength(0);
  });
});
