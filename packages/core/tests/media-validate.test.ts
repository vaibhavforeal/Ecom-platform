import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  sniffImageMimeType,
  validateUpload,
} from "../src/media/validate";

/**
 * Every case here is a lie the client can tell. The declared MIME type
 * and the filename are attacker-controlled; only the bytes are evidence.
 */

const png = (...tail: number[]) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);

const jpeg = (...tail: number[]) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...tail]);

const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));

const webp = () =>
  new Uint8Array([...ascii("RIFF"), 0x1a, 0x00, 0x00, 0x00, ...ascii("WEBPVP8 ")]);

/** ISOBMFF `ftyp` box: [size][ftyp][major][minor][compatible…]. */
const isobmff = (major: string, compatible: string[] = []) => {
  const body = [...ascii("ftyp"), ...ascii(major), 0, 0, 0, 0, ...compatible.flatMap(ascii)];
  const size = body.length + 4;
  return new Uint8Array([(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...body]);
};

describe("sniffImageMimeType", () => {
  it("identifies each allowed format from its magic bytes", () => {
    expect(sniffImageMimeType(png())).toBe("image/png");
    expect(sniffImageMimeType(jpeg())).toBe("image/jpeg");
    expect(sniffImageMimeType(webp())).toBe("image/webp");
    expect(sniffImageMimeType(isobmff("avif"))).toBe("image/avif");
  });

  it("accepts an AVIF whose major brand is mif1 but lists avif as compatible", () => {
    // Real encoders emit these; rejecting them would reject valid AVIFs.
    expect(sniffImageMimeType(isobmff("mif1", ["avif", "miaf"]))).toBe("image/avif");
    expect(sniffImageMimeType(isobmff("avis"))).toBe("image/avif");
  });

  it("rejects HEIC, which shares AVIF's container but nothing decodes it on the web", () => {
    expect(sniffImageMimeType(isobmff("heic", ["mif1", "heic"]))).toBeNull();
  });

  it("rejects SVG — it is a script-bearing document, not a raster image", () => {
    expect(sniffImageMimeType(new Uint8Array(ascii('<svg xmlns="http://www.w3.org/2000/svg">')))).toBeNull();
  });

  it("rejects a RIFF container that is not WebP", () => {
    const wav = new Uint8Array([...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVEfmt ")]);
    expect(sniffImageMimeType(wav)).toBeNull();
  });

  it("rejects truncated files that only share a prefix", () => {
    expect(sniffImageMimeType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array(ascii("RIFF")))).toBeNull();
  });
});

describe("validateUpload", () => {
  it("accepts every allowed type and reports the sniffed type and extension", () => {
    expect(validateUpload({ mimeType: "image/png", byteSize: 8, bytes: png() })).toEqual({
      ok: true,
      mimeType: "image/png",
      ext: "png",
      byteSize: 8,
    });

    expect(validateUpload({ mimeType: "image/jpeg", byteSize: 4, bytes: jpeg() })).toMatchObject({
      ok: true,
      mimeType: "image/jpeg",
      ext: "jpg",
    });

    expect(validateUpload({ mimeType: "image/webp", byteSize: 12, bytes: webp() })).toMatchObject({
      ok: true,
      mimeType: "image/webp",
      ext: "webp",
    });

    expect(
      validateUpload({ mimeType: "image/avif", byteSize: 16, bytes: isobmff("avif") }),
    ).toMatchObject({ ok: true, mimeType: "image/avif", ext: "avif" });
  });

  it("accepts a PNG that a phone renamed .jpg, on its REAL type", () => {
    // The extension and the declared type both say JPEG. The bytes say
    // PNG, and the bytes win — otherwise merchants cannot upload their
    // own files, which they rename constantly.
    const result = validateUpload({ mimeType: "image/jpeg", byteSize: 8, bytes: png() });

    expect(result).toMatchObject({ ok: true, mimeType: "image/png", ext: "png" });
  });

  it("rejects an HTML document declared as image/png", () => {
    // Stored under a merchant's own media host, this is stored XSS
    // against that merchant's customers.
    const html = new Uint8Array(ascii("<!DOCTYPE html><script>alert(1)</script>"));
    const result = validateUpload({ mimeType: "image/png", byteSize: html.length, bytes: html });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unsupported_image_type");
    expect(result.message).toContain("image/png");
  });

  it("rejects a file over the 10 MB cap", () => {
    const oversize = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    oversize.set(png(), 0);

    const result = validateUpload({
      mimeType: "image/png",
      byteSize: oversize.length,
      bytes: oversize,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("file_too_large");
  });

  it("accepts a file exactly at the cap", () => {
    const atCap = new Uint8Array(MAX_UPLOAD_BYTES);
    atCap.set(png(), 0);

    expect(
      validateUpload({ mimeType: "image/png", byteSize: atCap.length, bytes: atCap }),
    ).toMatchObject({ ok: true, byteSize: MAX_UPLOAD_BYTES });
  });

  it("rejects an oversize DECLARED size even when the body is small", () => {
    const result = validateUpload({
      mimeType: "image/png",
      byteSize: MAX_UPLOAD_BYTES + 1,
      bytes: png(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("file_too_large");
  });

  it("rejects an empty file", () => {
    const result = validateUpload({
      mimeType: "image/png",
      byteSize: 0,
      bytes: new Uint8Array(0),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("empty_file");
  });

  it("reports the real byte length, not the declared one", () => {
    const result = validateUpload({ mimeType: "image/png", byteSize: 999, bytes: png(1, 2, 3) });

    expect(result).toMatchObject({ ok: true, byteSize: 11 });
  });

  it("allowlists exactly the four formats the pipeline can encode", () => {
    expect([...ALLOWED_IMAGE_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/avif",
    ]);
  });
});
