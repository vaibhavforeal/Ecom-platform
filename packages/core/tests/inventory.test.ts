import { describe, expect, it } from "vitest";

import { isLowStock } from "../src/inventory/index";

describe("isLowStock", () => {
  it("returns false when threshold is null", () => {
    expect(isLowStock(0, null)).toBe(false);
    expect(isLowStock(10, null)).toBe(false);
    expect(isLowStock(100, null)).toBe(false);
  });

  it("returns true when onHand equals threshold", () => {
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(0, 0)).toBe(true);
    expect(isLowStock(10, 10)).toBe(true);
  });

  it("returns true when onHand is below threshold", () => {
    expect(isLowStock(0, 5)).toBe(true);
    expect(isLowStock(3, 10)).toBe(true);
    expect(isLowStock(1, 2)).toBe(true);
  });

  it("returns false when onHand is above threshold", () => {
    expect(isLowStock(6, 5)).toBe(false);
    expect(isLowStock(100, 10)).toBe(false);
    expect(isLowStock(3, 2)).toBe(false);
  });
});
