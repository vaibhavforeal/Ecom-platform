/**
 * Storage key generation.
 *
 * Keys are tenant-prefixed — makes a per-tenant bulk delete a prefix
 * operation and makes a leaked key obviously cross-tenant.
 *
 * Extension and format are validated against an allowlist: these end up
 * in a filesystem path (local driver) and in Content-Type headers.
 */

const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "avif", "gif"]);
const ALLOWED_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "avif"]);

/**
 * Generate a storage key for an original uploaded image.
 *
 * @example
 * mediaStorageKey({
 *   tenantId: "acme",
 *   checksum: "abc123",
 *   ext: "jpg"
 * })
 * // => "acme/originals/abc123.jpg"
 */
export function mediaStorageKey(input: {
  tenantId: string;
  checksum: string;
  ext: string;
}): string {
  const { tenantId, checksum, ext } = input;
  const normalizedExt = ext.toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(normalizedExt)) {
    throw new Error(
      `Extension "${ext}" not allowed. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
    );
  }

  return `${tenantId}/originals/${checksum}.${normalizedExt}`;
}

/**
 * Generate a storage key for a processed derivative (resize/format).
 *
 * @example
 * derivativeStorageKey({
 *   tenantId: "acme",
 *   checksum: "abc123",
 *   width: 800,
 *   format: "webp"
 * })
 * // => "acme/d/abc123/800.webp"
 */
export function derivativeStorageKey(input: {
  tenantId: string;
  checksum: string;
  width: number;
  format: string;
}): string {
  const { tenantId, checksum, width, format } = input;
  const normalizedFormat = format.toLowerCase();

  if (!ALLOWED_FORMATS.has(normalizedFormat)) {
    throw new Error(
      `Format "${format}" not allowed. Allowed: ${Array.from(ALLOWED_FORMATS).join(", ")}`,
    );
  }

  if (width <= 0 || width > 5000) {
    throw new Error(`Width ${width} out of range (1-5000)`);
  }

  return `${tenantId}/d/${checksum}/${width}.${normalizedFormat}`;
}
