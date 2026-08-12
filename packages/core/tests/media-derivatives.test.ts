import { describe, expect, it } from "vitest";

import { IMAGE_FORMATS, IMAGE_WIDTHS, planDerivatives } from "../src/media/derivatives";

/**
 * The plan decides what the storefront can offer. Two ways to get it
 * wrong, both invisible at runtime: planning widths above the original
 * (bandwidth spent to make an image blurrier) and planning nothing at
 * all for a small image (empty `srcset`, no image rendered anywhere).
 */

function widthsFor(original: { width: number; height: number }, format: string): number[] {
  return planDerivatives(original)
    .filter((d) => d.format === format)
    .map((d) => d.width);
}

describe("planDerivatives", () => {
  it("plans every format at every fitting width", () => {
    const plan = planDerivatives({ width: 4000, height: 3000 });

    expect(plan).toHaveLength(IMAGE_FORMATS.length * IMAGE_WIDTHS.length);
    for (const format of IMAGE_FORMATS) {
      expect(widthsFor({ width: 4000, height: 3000 }, format)).toEqual([...IMAGE_WIDTHS]);
    }
  });

  it("never plans a width above the original's intrinsic width", () => {
    expect(widthsFor({ width: 700, height: 500 }, "webp")).toEqual([320, 480, 640]);
    expect(widthsFor({ width: 700, height: 500 }, "avif")).toEqual([320, 480, 640]);
    expect(widthsFor({ width: 700, height: 500 }, "jpeg")).toEqual([320, 480, 640]);

    expect(planDerivatives({ width: 700, height: 500 }).every((d) => d.width <= 700)).toBe(true);
  });

  it("includes a width equal to the original but not the next one up", () => {
    // 640 exactly: an off-by-one in the filter shows up here as either a
    // missing 640 or a 960 that would be upscaled.
    expect(widthsFor({ width: 640, height: 640 }, "webp")).toEqual([320, 480, 640]);
    expect(widthsFor({ width: 639, height: 639 }, "webp")).toEqual([320, 480]);
  });

  it("still plans one derivative per format for a tiny original", () => {
    // A 100px logo fits none of the breakpoints. An empty plan means an
    // empty srcset, and some browsers then fetch nothing at all.
    const plan = planDerivatives({ width: 100, height: 60 });

    expect(plan).toHaveLength(IMAGE_FORMATS.length);
    expect(plan.map((d) => d.width)).toEqual([320, 320, 320]);
    expect(new Set(plan.map((d) => d.format))).toEqual(new Set(IMAGE_FORMATS));
  });

  it("plans the smallest width rather than nothing for a degenerate original", () => {
    // Defensive: a zero or NaN width from a corrupt header must not
    // produce an empty plan.
    expect(planDerivatives({ width: 0, height: 0 })).toHaveLength(IMAGE_FORMATS.length);
    expect(planDerivatives({ width: Number.NaN, height: 10 }).map((d) => d.width)).toEqual([
      320, 320, 320,
    ]);
  });

  it("offers avif, webp and jpeg — the picture element needs all three", () => {
    expect([...IMAGE_FORMATS]).toEqual(["avif", "webp", "jpeg"]);
  });

  it("keeps the breakpoint ladder the storefront's sizes hints assume", () => {
    expect([...IMAGE_WIDTHS]).toEqual([320, 480, 640, 960, 1280, 1920]);
  });
});
