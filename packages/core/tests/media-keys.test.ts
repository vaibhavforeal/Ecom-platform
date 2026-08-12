import { describe, expect, it } from "vitest";
import { derivativeStorageKey, mediaStorageKey } from "../src/media/keys";

describe("mediaStorageKey", () => {
  it("generates tenant-prefixed keys for originals", () => {
    expect(
      mediaStorageKey({
        tenantId: "acme",
        checksum: "abc123def456",
        ext: "jpg",
      }),
    ).toBe("acme/originals/abc123def456.jpg");
  });

  it("accepts all allowed extensions", () => {
    const allowed = ["jpg", "jpeg", "png", "webp", "avif", "gif"];

    for (const ext of allowed) {
      expect(() =>
        mediaStorageKey({
          tenantId: "test",
          checksum: "check",
          ext,
        }),
      ).not.toThrow();
    }
  });

  it("accepts extensions case-insensitively", () => {
    expect(() =>
      mediaStorageKey({
        tenantId: "test",
        checksum: "check",
        ext: "JPG",
      }),
    ).not.toThrow();

    expect(() =>
      mediaStorageKey({
        tenantId: "test",
        checksum: "check",
        ext: "WebP",
      }),
    ).not.toThrow();
  });

  it("rejects disallowed extensions", () => {
    expect(() =>
      mediaStorageKey({
        tenantId: "acme",
        checksum: "abc",
        ext: "exe",
      }),
    ).toThrow('Extension "exe" not allowed');

    expect(() =>
      mediaStorageKey({
        tenantId: "acme",
        checksum: "abc",
        ext: "svg",
      }),
    ).toThrow('Extension "svg" not allowed');
  });
});

describe("derivativeStorageKey", () => {
  it("generates tenant-prefixed keys for derivatives", () => {
    expect(
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc123def456",
        width: 800,
        format: "webp",
      }),
    ).toBe("acme/d/abc123def456/800.webp");
  });

  it("accepts all allowed formats", () => {
    const allowed = ["jpg", "jpeg", "png", "webp", "avif"];

    for (const format of allowed) {
      expect(() =>
        derivativeStorageKey({
          tenantId: "test",
          checksum: "check",
          width: 800,
          format,
        }),
      ).not.toThrow();
    }
  });

  it("accepts formats case-insensitively", () => {
    expect(() =>
      derivativeStorageKey({
        tenantId: "test",
        checksum: "check",
        width: 800,
        format: "WEBP",
      }),
    ).not.toThrow();
  });

  it("rejects disallowed formats", () => {
    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 800,
        format: "gif",
      }),
    ).toThrow('Format "gif" not allowed');

    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 800,
        format: "svg",
      }),
    ).toThrow('Format "svg" not allowed');
  });

  it("rejects invalid widths", () => {
    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 0,
        format: "webp",
      }),
    ).toThrow("Width 0 out of range");

    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: -100,
        format: "webp",
      }),
    ).toThrow("Width -100 out of range");

    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 6000,
        format: "webp",
      }),
    ).toThrow("Width 6000 out of range");
  });

  it("accepts valid width range", () => {
    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 1,
        format: "webp",
      }),
    ).not.toThrow();

    expect(() =>
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 5000,
        format: "webp",
      }),
    ).not.toThrow();
  });
});
