import { describe, expect, it } from "vitest";

import {
  INVOICE_NUMBER_PAD,
  amountInWords,
  docTypeFor,
  formatInvoiceNumber,
} from "../src/invoices/index";

describe("formatInvoiceNumber", () => {
  it("renders '{prefix}/{FY}/{padded number}'", () => {
    expect(formatInvoiceNumber("INV", "2026-27", 42)).toBe("INV/2026-27/0042");
  });

  it("pads the first number of a series", () => {
    expect(INVOICE_NUMBER_PAD).toBe(4);
    expect(formatInvoiceNumber("ACME", "2026-27", 1)).toBe("ACME/2026-27/0001");
  });

  it("never truncates a number wider than the pad", () => {
    expect(formatInvoiceNumber("INV", "2026-27", 9_999)).toBe("INV/2026-27/9999");
    expect(formatInvoiceNumber("INV", "2026-27", 123_456)).toBe("INV/2026-27/123456");
  });

  it("passes the prefix through verbatim (frozen at issue)", () => {
    expect(formatInvoiceNumber("BOS", "2025-26", 7)).toBe("BOS/2025-26/0007");
  });

  it("refuses a negative or fractional number", () => {
    expect(() => formatInvoiceNumber("INV", "2026-27", -1)).toThrow(/non-negative integer/);
    expect(() => formatInvoiceNumber("INV", "2026-27", 1.5)).toThrow(/non-negative integer/);
  });
});

describe("docTypeFor (re-exported through the invoices barrel)", () => {
  it("regular → tax_invoice; everyone else → bill_of_supply", () => {
    expect(docTypeFor("regular")).toBe("tax_invoice");
    expect(docTypeFor("unregistered")).toBe("bill_of_supply");
    expect(docTypeFor("composition")).toBe("bill_of_supply");
  });
});

describe("amountInWords (Indian numbering)", () => {
  it("zero", () => {
    expect(amountInWords(0)).toBe("Zero Rupees Only");
  });

  it("rupees and paise", () => {
    // 15,239 paise = ₹152.39 — the D20 tax pin, read back as words.
    expect(amountInWords(15_239)).toBe(
      "One Hundred Fifty-Two Rupees and Thirty-Nine Paise Only",
    );
  });

  it("whole rupees omit the paise clause", () => {
    expect(amountInWords(10_000)).toBe("One Hundred Rupees Only");
  });

  it("uses singular units for exactly one rupee / one paisa", () => {
    expect(amountInWords(100)).toBe("One Rupee Only");
    expect(amountInWords(1)).toBe("One Paisa Only");
    expect(amountInWords(101)).toBe("One Rupee and One Paisa Only");
  });

  it("paise-only amounts omit the rupees clause", () => {
    expect(amountInWords(5)).toBe("Five Paise Only");
    expect(amountInWords(99)).toBe("Ninety-Nine Paise Only");
  });

  it("tens and teens", () => {
    expect(amountInWords(1_100)).toBe("Eleven Rupees Only");
    expect(amountInWords(9_000)).toBe("Ninety Rupees Only");
    expect(amountInWords(2_100)).toBe("Twenty-One Rupees Only");
    expect(amountInWords(1_900)).toBe("Nineteen Rupees Only");
  });

  it("lakh grouping", () => {
    // ₹12,34,567 = 123,456,700 paise.
    expect(amountInWords(123_456_700)).toBe(
      "Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven Rupees Only",
    );
    expect(amountInWords(10_000_000)).toBe("One Lakh Rupees Only");
  });

  it("crore grouping", () => {
    // 12,345,678,900 paise = ₹12,34,56,789.
    expect(amountInWords(12_345_678_900)).toBe(
      "Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine Rupees Only",
    );
    expect(amountInWords(1_000_000_000)).toBe("One Crore Rupees Only");
  });

  it("recurses above 100 crore", () => {
    // 250,000,000,000 paise = ₹2,50,00,00,000 (₹250 crore).
    expect(amountInWords(250_000_000_000)).toBe("Two Hundred Fifty Crore Rupees Only");
  });

  it("skips empty groups", () => {
    // ₹1,00,001 — lakh and units, no thousand, no hundred.
    expect(amountInWords(10_000_100)).toBe("One Lakh One Rupees Only");
    // ₹5,00,00,050.05
    expect(amountInWords(5_000_005_005)).toBe(
      "Five Crore Fifty Rupees and Five Paise Only",
    );
  });

  it("refuses negative or fractional paise", () => {
    expect(() => amountInWords(-1)).toThrow(/non-negative integer/);
    expect(() => amountInWords(0.5)).toThrow(/non-negative integer/);
  });
});
