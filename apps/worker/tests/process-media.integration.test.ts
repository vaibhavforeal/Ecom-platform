import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeConnections } from "@platform/db";
import { derivativeStorageKey, mediaStorageKey, sha256 } from "@platform/core/media";
import type { MediaDerivative } from "@platform/core/media";
import { getStorage } from "@platform/integrations/storage";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
};

let tenantA: string;
let tenantB: string;

async function readMedia(id: string): Promise<MediaRow> {
  const rows = await admin<MediaRow[]>`
    SELECT status, width, height, checksum, derivatives, processing_error
    FROM media WHERE id = ${id}`;
  const row = rows[0];
  if (!row) throw new Error(`media ${id} vanished`);
  return row;
}

/** Stores the bytes and inserts the `pending` row the upload endpoint would. */
async function givenPendingMedia(
  tenantId: string,
  bytes: Buffer,
  opts: { mimeType: string; ext: string; store?: boolean },
): Promise<{ id: string; checksum: string; storageKey: string }> {
  const checksum = await sha256(bytes);
  const storageKey = mediaStorageKey({ tenantId, checksum, ext: opts.ext });

  if (opts.store !== false) {
    await getStorage().put(storageKey, bytes, { contentType: opts.mimeType });
  }

  const id = randomUUID();
  await admin`
    INSERT INTO media (id, tenant_id, storage_key, mime_type, byte_size, checksum, status)
    VALUES (${id}, ${tenantId}, ${storageKey}, ${opts.mimeType}, ${bytes.length},
            ${checksum}, 'pending')`;

  return { id, checksum, storageKey };
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

beforeAll(async () => {
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

afterAll(async () => {
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

    const { id, checksum } = await givenPendingMedia(tenantA, png, {
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

    const { id } = await givenPendingMedia(tenantA, jpeg, {
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

    const { id } = await givenPendingMedia(tenantA, tiny, { mimeType: "image/png", ext: "png" });

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

    const { id } = await givenPendingMedia(tenantA, bomb, { mimeType: "image/png", ext: "png" });

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

    const { id } = await givenPendingMedia(tenantA, png, {
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

    const { id } = await givenPendingMedia(tenantA, png, { mimeType: "image/png", ext: "png" });

    // RLS returns zero rows rather than an error, so a job that mixed up
    // its tenant would silently do nothing — or, if the job filtered by
    // id alone, silently process it under the wrong tenant's prefix.
    await expect(processMedia({ tenantId: tenantB, mediaId: id })).rejects.toThrow(/not found/i);

    const row = await readMedia(id);
    expect(row.status).toBe("pending");
    expect(row.processing_error).toBeNull();
    expect(asDerivatives(row.derivatives)).toHaveLength(0);
  });
});
