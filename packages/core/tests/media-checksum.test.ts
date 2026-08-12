import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256 } from "../src/media/checksum";

/**
 * The checksum is the dedupe key AND the storage key namespace. A
 * mis-encoded digest would collide files that differ, which means one
 * merchant's product page showing another upload's photograph.
 */

describe("sha256", () => {
  it("matches the published vectors", () => {
    // Wrong hex encoding (missing zero-padding, wrong endianness) still
    // produces a plausible-looking string, so this pins actual values.
    return Promise.all([
      expect(sha256(new Uint8Array(0))).resolves.toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
      expect(sha256(new Uint8Array([0x61, 0x62, 0x63]))).resolves.toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ),
    ]);
  });

  it("agrees with node:crypto over random bytes", async () => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) % 256;

    expect(await sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("zero-pads every byte to two hex characters", async () => {
    // A byte below 0x10 rendered without padding shortens the digest and
    // makes distinct inputs share a key.
    const digest = await sha256(new Uint8Array([0]));

    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes inputs that differ in one bit", async () => {
    const a = await sha256(new Uint8Array([1, 2, 3, 4]));
    const b = await sha256(new Uint8Array([1, 2, 3, 5]));

    expect(a).not.toBe(b);
  });

  it("hashes only the view, not the whole backing buffer", async () => {
    // Buffer.subarray shares memory with its parent. Hashing the parent
    // by accident would give every slice of an upload the same digest.
    const backing = new Uint8Array([9, 9, 0x61, 0x62, 0x63, 9, 9]);
    const view = backing.subarray(2, 5);

    expect(await sha256(view)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
