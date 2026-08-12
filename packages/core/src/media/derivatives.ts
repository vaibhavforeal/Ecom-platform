/**
 * What the pipeline renders, and at which sizes.
 *
 * This module is the single source of truth for the breakpoint ladder
 * and the derivative record shape. The storefront's `srcset` builder
 * re-exports from here rather than keeping its own copy: a derivative
 * row whose shape drifts from what the renderer expects produces no
 * images and no error, which is the worst failure mode available.
 */

/** Widths the pipeline generates, ascending. */
export const IMAGE_WIDTHS = [320, 480, 640, 960, 1280, 1920] as const;

/**
 * Output formats, best-first.
 *
 * AVIF is smallest and WebP is the fallback; JPEG exists because a
 * `<picture>` still needs an `<img>` that every client can decode.
 */
export const IMAGE_FORMATS = ["avif", "webp", "jpeg"] as const;

export type ImageFormat = (typeof IMAGE_FORMATS)[number];

/** One entry of a media row's `derivatives` jsonb array. */
export type MediaDerivative = {
  format: ImageFormat;
  width: number;
  height: number;
  storageKey: string;
  byteSize: number;
};

/** One unit of work for the processing job: render `format` at `width`. */
export type DerivativePlanEntry = {
  format: ImageFormat;
  width: number;
};

/**
 * Which widths to render for an original of this intrinsic width.
 *
 * Two rules, both load-bearing:
 *
 *  1. Never upscale. Rendering a 400px photo at 1920 spends bandwidth
 *     and storage to make it blurrier than the original.
 *
 *  2. A tiny original still gets one derivative. An empty `srcset` is
 *     not "fall back to the original" — some browsers fetch nothing at
 *     all, so a 100px logo would render as a blank box. The single
 *     entry is capped by `withoutEnlargement` at render time, so the
 *     recorded width is the true output width, not the target.
 */
function targetWidths(originalWidth: number): number[] {
  const smallest = IMAGE_WIDTHS[0];
  if (!Number.isFinite(originalWidth) || originalWidth <= 0) return [smallest];

  const fitting = IMAGE_WIDTHS.filter((w) => w <= originalWidth);
  return fitting.length > 0 ? [...fitting] : [smallest];
}

/** The full render plan for one original: every format at every width. */
export function planDerivatives(original: { width: number; height: number }): DerivativePlanEntry[] {
  const widths = targetWidths(original.width);
  return IMAGE_FORMATS.flatMap((format) => widths.map((width) => ({ format, width })));
}
