/**
 * Content addressing for uploads.
 *
 * The checksum is both the dedupe key and the storage key: merchants
 * re-upload the same photograph across a dozen products, and paying to
 * decode and re-encode 18 derivatives each time is money spent to
 * produce bytes that already exist.
 *
 * WebCrypto rather than `node:crypto` on purpose — `@platform/core/media`
 * must stay importable from a client component, and a `node:` specifier
 * anywhere in this barrel breaks the Next build with an error that names
 * `fs`, not this file.
 */
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Copied into a plain ArrayBuffer-backed view: `BufferSource` excludes
  // SharedArrayBuffer-backed arrays, and a Node `Buffer` is a view into
  // a shared pool whose type reflects that.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
