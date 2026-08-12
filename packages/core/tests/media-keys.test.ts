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
    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "jpg" }),
    ).toBe("test/originals/check.jpg");

    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "jpeg" }),
    ).toBe("test/originals/check.jpeg");

    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "png" }),
    ).toBe("test/originals/check.png");

    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "webp" }),
    ).toBe("test/originals/check.webp");

    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "avif" }),
    ).toBe("test/originals/check.avif");

    expect(
      mediaStorageKey({ tenantId: "test", checksum: "check", ext: "gif" }),
    ).toBe("test/originals/check.gif");
  });

  it("accepts extensions case-insensitively and normalizes to lowercase", () => {
    expect(
      mediaStorageKey({
        tenantId: "test",
        checksum: "check",
        ext: "JPG",
      }),
    ).toBe("test/originals/check.jpg");

    expect(
      mediaStorageKey({
        tenantId: "test",
        checksum: "check",
        ext: "WebP",
      }),
    ).toBe("test/originals/check.webp");
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
    expect(
      derivativeStorageKey({ tenantId: "test", checksum: "check", width: 800, format: "jpg" }),
    ).toBe("test/d/check/800.jpg");

    expect(
      derivativeStorageKey({ tenantId: "test", checksum: "check", width: 800, format: "jpeg" }),
    ).toBe("test/d/check/800.jpeg");

    expect(
      derivativeStorageKey({ tenantId: "test", checksum: "check", width: 800, format: "png" }),
    ).toBe("test/d/check/800.png");

    expect(
      derivativeStorageKey({ tenantId: "test", checksum: "check", width: 800, format: "webp" }),
    ).toBe("test/d/check/800.webp");

    expect(
      derivativeStorageKey({ tenantId: "test", checksum: "check", width: 800, format: "avif" }),
    ).toBe("test/d/check/800.avif");
  });

  it("accepts formats case-insensitively and normalizes to lowercase", () => {
    expect(
      derivativeStorageKey({
        tenantId: "test",
        checksum: "check",
        width: 800,
        format: "WEBP",
      }),
    ).toBe("test/d/check/800.webp");

    expect(
      derivativeStorageKey({
        tenantId: "test",
        checksum: "check",
        width: 800,
        format: "PNG",
      }),
    ).toBe("test/d/check/800.png");
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
    expect(
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 1,
        format: "webp",
      }),
    ).toBe("acme/d/abc/1.webp");

    expect(
      derivativeStorageKey({
        tenantId: "acme",
        checksum: "abc",
        width: 5000,
        format: "webp",
      }),
    ).toBe("acme/d/abc/5000.webp");
  });
});
