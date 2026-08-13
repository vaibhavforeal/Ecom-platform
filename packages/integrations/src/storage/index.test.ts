import { afterEach, describe, expect, it, vi } from "vitest";

// Must reset the module cache between tests since getStorage() caches
afterEach(() => {
  vi.resetModules();
});

describe("getStorage", () => {
  it("defaults to local driver in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE_DRIVER", undefined);
    vi.stubEnv("MEDIA_LOCAL_ROOT", ".media-test");

    const { getStorage } = await import("./index");
    const storage = getStorage();

    expect(storage.driver).toBe("local");
  });

  it("throws in production when STORAGE_DRIVER is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_DRIVER", undefined);

    const { getStorage } = await import("./index");

    expect(() => getStorage()).toThrow("STORAGE_DRIVER is required in production");
  });

  it("creates local driver when explicitly requested", async () => {
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("MEDIA_LOCAL_ROOT", ".media-test");

    const { getStorage } = await import("./index");
    const storage = getStorage();

    expect(storage.driver).toBe("local");
  });

  it("creates S3 driver when requested with valid config", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_ENDPOINT", "https://s3.example.com");
    vi.stubEnv("STORAGE_REGION", "us-east-1");
    vi.stubEnv("STORAGE_BUCKET", "test-bucket");
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "test-secret");

    const { getStorage } = await import("./index");
    const storage = getStorage();

    expect(storage.driver).toBe("s3");
  });

  it("throws when S3 driver requested with missing config", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_ENDPOINT", "https://s3.example.com");
    vi.stubEnv("STORAGE_REGION", undefined);
    vi.stubEnv("STORAGE_BUCKET", undefined);
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", undefined);
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", undefined);

    const { getStorage } = await import("./index");

    expect(() => getStorage()).toThrow("S3 driver requires");
  });

  it("throws for unknown driver", async () => {
    vi.stubEnv("STORAGE_DRIVER", "unknown");

    const { getStorage } = await import("./index");

    expect(() => getStorage()).toThrow('Unknown STORAGE_DRIVER: "unknown"');
  });

  it("caches the storage instance", async () => {
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("MEDIA_LOCAL_ROOT", ".media-test");

    const { getStorage } = await import("./index");

    const first = getStorage();
    const second = getStorage();

    expect(first).toBe(second);
  });

  it("passes publicUrlBase to S3 driver", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_ENDPOINT", "https://s3.example.com");
    vi.stubEnv("STORAGE_REGION", "us-east-1");
    vi.stubEnv("STORAGE_BUCKET", "test-bucket");
    vi.stubEnv("STORAGE_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("STORAGE_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("STORAGE_PUBLIC_URL_BASE", "https://cdn.example.com");

    const { getStorage } = await import("./index");
    const storage = getStorage();

    expect(storage.publicUrl("tenant/file.jpg")).toBe("https://cdn.example.com/tenant/file.jpg");
  });

  it("treats a blank STORAGE_DRIVER as unset in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("STORAGE_DRIVER", "");
    const { getStorage } = await import("./index");
    expect(() => getStorage()).not.toThrow(); // falls back to the local driver
  });

  it("treats a blank STORAGE_DRIVER as unset in production — refuses to default", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STORAGE_DRIVER", "");
    const { getStorage } = await import("./index");
    expect(() => getStorage()).toThrow("STORAGE_DRIVER is required in production");
  });
});
