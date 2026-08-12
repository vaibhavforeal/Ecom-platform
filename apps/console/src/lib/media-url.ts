/**
 * Image URLs for console previews.
 *
 * The same convention the storefront uses: media rows store an
 * object-storage KEY, never a URL, because the public base changes
 * between local development, staging and production and a URL baked into
 * a row is a row that breaks the day the CDN hostname changes.
 *
 * With `MEDIA_PUBLIC_BASE_URL` unset these come out site-relative, and
 * nothing local serves `/media` — so thumbnails in development are
 * broken images. That is deliberate rather than a gap: every gallery in
 * the console shows the storage key and the processing status in text
 * beside the picture, so the UI is usable without one.
 */
export function mediaUrl(storageKey: string): string {
  const base = (process.env.MEDIA_PUBLIC_BASE_URL ?? "/media").replace(/\/+$/, "");
  return `${base}/${storageKey.replace(/^\/+/, "")}`;
}
