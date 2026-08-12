/**
 * Upload validation.
 *
 * The declared `Content-Type` and the filename are attacker-controlled
 * strings. Neither is evidence of anything. Everything below decides
 * what a file IS from its own bytes, and the declared type is used only
 * to make the rejection message intelligible.
 *
 * Two things this prevents:
 *
 *  · Storing an HTML document under `image/png`. Serve that back from a
 *    media host on the merchant's own domain and it is stored XSS
 *    against that merchant's customers.
 *
 *  · Rejecting a perfectly good PNG because a phone named it `.jpg`.
 *    Merchants rename files constantly; the real type is what matters.
 */

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/**
 * 10 MB. Large enough for a DSLR JPEG, small enough that a hostile
 * upload cannot fill the disk or occupy a worker for minutes.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Extension used for the original's storage key, per sniffed type. */
const EXTENSION_BY_MIME: Record<AllowedImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export type UploadRejectionCode = "empty_file" | "file_too_large" | "unsupported_image_type";

export type UploadValidation =
  | {
      ok: true;
      /** The type the BYTES say it is — not the one the client declared. */
      mimeType: AllowedImageMimeType;
      ext: string;
      byteSize: number;
    }
  | {
      ok: false;
      code: UploadRejectionCode;
      message: string;
    };

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length; i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/**
 * AVIF is an ISOBMFF container, so the signature is a `ftyp` box rather
 * than a fixed prefix. The AV1 brand may be the major brand or merely
 * listed among the compatible brands (a `mif1`-major file with `avif`
 * compatible is still an AVIF), so both are checked — and HEIC, which
 * shares the container and which nothing decodes on the web, is
 * rejected because neither brand appears.
 */
const AVIF_BRANDS = new Set(["avif", "avis"]);

function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (ascii(bytes, 4, 4) !== "ftyp") return false;

  if (AVIF_BRANDS.has(ascii(bytes, 8, 4))) return true;

  // Compatible brands follow the 4-byte minor version at offset 12.
  const declaredBoxSize =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  const end = Math.min(bytes.length, declaredBoxSize > 0 ? declaredBoxSize : bytes.length, 512);

  for (let offset = 16; offset + 4 <= end; offset += 4) {
    if (AVIF_BRANDS.has(ascii(bytes, offset, 4))) return true;
  }
  return false;
}

function isWebp(bytes: Uint8Array): boolean {
  // RIFF container with a WEBP form type; the 4 bytes between are the
  // chunk length, which says nothing about the format.
  return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

/**
 * The real type of these bytes, or null if it is not an image we accept.
 *
 * Null is also the answer for an SVG, which is an allowlist decision
 * rather than an oversight: SVG is a script-bearing document format.
 */
export function sniffImageMimeType(bytes: Uint8Array): AllowedImageMimeType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  if (isAvif(bytes)) return "image/avif";
  return null;
}

/**
 * Decide whether an upload may be stored.
 *
 * `byteSize` is what the client claims; `bytes` is what it actually
 * sent. The cap is applied to both, so a lying Content-Length is
 * rejected on its own and a truncated body cannot smuggle past it.
 */
export function validateUpload(input: {
  mimeType: string;
  byteSize: number;
  bytes: Uint8Array;
}): UploadValidation {
  const { mimeType, byteSize, bytes } = input;

  if (bytes.length === 0) {
    return { ok: false, code: "empty_file", message: "The uploaded file is empty." };
  }

  const largest = Math.max(bytes.length, Number.isFinite(byteSize) ? byteSize : 0);
  if (largest > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "file_too_large",
      message: `Images must be ${MAX_UPLOAD_BYTES} bytes or smaller; got ${largest}.`,
    };
  }

  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed) {
    return {
      ok: false,
      code: "unsupported_image_type",
      message:
        `File content is not a supported image (declared "${mimeType}"). ` +
        `Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    mimeType: sniffed,
    ext: EXTENSION_BY_MIME[sniffed],
    byteSize: bytes.length,
  };
}
