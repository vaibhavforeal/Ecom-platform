import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDriver } from "./local";

describe("Local storage driver", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves objects", async () => {
    const driver = createLocalDriver(tmpDir);
    const key = "tenant/originals/test.jpg";
    const body = Buffer.from("test image data");

    const stored = await driver.put(key, body, { contentType: "image/jpeg" });

    expect(stored.key).toBe(key);
    expect(stored.byteSize).toBe(body.length);
    expect(stored.contentType).toBe("image/jpeg");

    const retrieved = await driver.get(key);
    expect(retrieved.toString()).toBe("test image data");
  });

  it("creates directories as needed", async () => {
    const driver = createLocalDriver(tmpDir);
    const key = "tenant/deep/nested/path/file.png";
    const body = Buffer.from("nested");

    await driver.put(key, body, { contentType: "image/png" });

    const retrieved = await driver.get(key);
    expect(retrieved.toString()).toBe("nested");
  });

  it("overwrites existing files", async () => {
    const driver = createLocalDriver(tmpDir);
    const key = "tenant/file.jpg";

    await driver.put(key, Buffer.from("first"), { contentType: "image/jpeg" });
    await driver.put(key, Buffer.from("second"), { contentType: "image/jpeg" });

    const retrieved = await driver.get(key);
    expect(retrieved.toString()).toBe("second");
  });

  it("deletes objects", async () => {
    const driver = createLocalDriver(tmpDir);
    const key = "tenant/file.jpg";

    await driver.put(key, Buffer.from("data"), { contentType: "image/jpeg" });
    expect(await driver.exists(key)).toBe(true);

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
  });

  it("deleting non-existent file is idempotent", async () => {
    const driver = createLocalDriver(tmpDir);

    await expect(driver.delete("tenant/nonexistent.jpg")).resolves.not.toThrow();
  });

  it("checks existence correctly", async () => {
    const driver = createLocalDriver(tmpDir);
    const key = "tenant/file.jpg";

    expect(await driver.exists(key)).toBe(false);

    await driver.put(key, Buffer.from("data"), { contentType: "image/jpeg" });
    expect(await driver.exists(key)).toBe(true);

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
  });

  it("throws when getting non-existent file", async () => {
    const driver = createLocalDriver(tmpDir);

    await expect(driver.get("tenant/nonexistent.jpg")).rejects.toThrow("not found");
  });

  it("returns null for publicUrl (local driver serves nothing publicly)", () => {
    const driver = createLocalDriver(tmpDir);
    expect(driver.publicUrl("tenant/file.jpg")).toBe(null);
  });

  describe("path traversal protection", () => {
    it("rejects ../ sequences that escape the root", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(
        driver.put("../../etc/passwd", Buffer.from("evil"), { contentType: "text/plain" }),
      ).rejects.toThrow("attempts to escape the storage root");
    });

    it("rejects keys starting with ../", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(
        driver.put("../outside.txt", Buffer.from("evil"), { contentType: "text/plain" }),
      ).rejects.toThrow("attempts to escape the storage root");
    });

    it("rejects absolute paths", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(
        driver.put("/etc/passwd", Buffer.from("evil"), { contentType: "text/plain" }),
      ).rejects.toThrow("resolves to an absolute path");
    });

    it("rejects keys with ../ in the middle that escape", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(
        driver.put("tenant/../../../etc/passwd", Buffer.from("evil"), {
          contentType: "text/plain",
        }),
      ).rejects.toThrow("attempts to escape");
    });

    it("allows normal keys with slashes", async () => {
      const driver = createLocalDriver(tmpDir);
      const key = "tenant/originals/abc123.jpg";

      await expect(
        driver.put(key, Buffer.from("ok"), { contentType: "image/jpeg" }),
      ).resolves.not.toThrow();
    });

    it("rejects traversal attempts on get", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(driver.get("../../etc/passwd")).rejects.toThrow(
        "attempts to escape the storage root",
      );
    });

    it("rejects traversal attempts on delete", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(driver.delete("../../etc/passwd")).rejects.toThrow(
        "attempts to escape the storage root",
      );
    });

    it("rejects traversal attempts on exists", async () => {
      const driver = createLocalDriver(tmpDir);

      await expect(driver.exists("../../etc/passwd")).rejects.toThrow(
        "attempts to escape the storage root",
      );
    });

    it("allows keys with . in filenames (not directory traversal)", async () => {
      const driver = createLocalDriver(tmpDir);
      const key = "tenant/file.name.with.dots.jpg";

      await expect(
        driver.put(key, Buffer.from("ok"), { contentType: "image/jpeg" }),
      ).resolves.not.toThrow();

      const retrieved = await driver.get(key);
      expect(retrieved.toString()).toBe("ok");
    });
  });

  it("reports correct driver name", () => {
    const driver = createLocalDriver(tmpDir);
    expect(driver.driver).toBe("local");
  });
});
