import { describe, expect, it } from "vitest";
import { createS3Driver } from "./s3";

describe("S3 storage driver", () => {
  const mockConfig = {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "test-bucket",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
  };

  it("creates driver with correct configuration", () => {
    const driver = createS3Driver(mockConfig);

    expect(driver.driver).toBe("s3");
  });

  it("constructs public URLs when publicUrlBase is provided", () => {
    const driver = createS3Driver({
      ...mockConfig,
      publicUrlBase: "https://cdn.example.com",
    });

    expect(driver.publicUrl("tenant/originals/abc123.jpg")).toBe(
      "https://cdn.example.com/tenant/originals/abc123.jpg",
    );
  });

  it("handles publicUrlBase with trailing slash", () => {
    const driver = createS3Driver({
      ...mockConfig,
      publicUrlBase: "https://cdn.example.com/",
    });

    expect(driver.publicUrl("tenant/originals/abc123.jpg")).toBe(
      "https://cdn.example.com/tenant/originals/abc123.jpg",
    );
  });

  it("returns null for publicUrl when publicUrlBase is not provided", () => {
    const driver = createS3Driver(mockConfig);

    expect(driver.publicUrl("tenant/originals/abc123.jpg")).toBe(null);
  });

  it("reports correct driver name", () => {
    const driver = createS3Driver(mockConfig);
    expect(driver.driver).toBe("s3");
  });
});
