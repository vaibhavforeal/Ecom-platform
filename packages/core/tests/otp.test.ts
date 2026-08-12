import { describe, expect, it } from "vitest";

import {
  OTP_LENGTH,
  generateOtpCode,
  hashOtpCode,
  maskPhone,
  normalisePhone,
  verifyOtpHash,
} from "../src/identity/otp";

const PEPPER = "test_pepper_at_least_32_characters_long_xxxx";

describe("generateOtpCode", () => {
  it("always produces a zero-padded code of the configured length", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
    }
  });

  it("produces codes across the full range including leading zeros", () => {
    // A naive randomInt(100000, 999999) silently drops every code with a
    // leading zero, cutting the keyspace by 10%. This asserts we don't.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(generateOtpCode());
    expect(seen.size).toBeGreaterThan(15_000);
    expect([...seen].some((c) => c.startsWith("0"))).toBe(true);
  });
});

describe("hashOtpCode", () => {
  it("refuses a weak pepper", () => {
    expect(() =>
      hashOtpCode({ phoneE164: "+919876543210", purpose: "console_login", code: "123456", pepper: "short" }),
    ).toThrow(/at least 32/);
  });

  it("binds the hash to phone, purpose and code", () => {
    const base = { phoneE164: "+919876543210", purpose: "console_login", code: "123456", pepper: PEPPER };
    const h = hashOtpCode(base);

    // A code minted for one phone/purpose must not verify for another,
    // or a code sent to a customer could be replayed into console login.
    expect(hashOtpCode({ ...base, phoneE164: "+919876543211" })).not.toBe(h);
    expect(hashOtpCode({ ...base, purpose: "customer_login" })).not.toBe(h);
    expect(hashOtpCode({ ...base, code: "123457" })).not.toBe(h);
    expect(hashOtpCode({ ...base, pepper: PEPPER.replace("x", "y") })).not.toBe(h);
  });

  it("is deterministic for identical input", () => {
    const input = { phoneE164: "+919876543210", purpose: "console_login", code: "000000", pepper: PEPPER };
    expect(hashOtpCode(input)).toBe(hashOtpCode(input));
  });
});

describe("verifyOtpHash", () => {
  const h = (code: string) =>
    hashOtpCode({ phoneE164: "+919876543210", purpose: "console_login", code, pepper: PEPPER });

  it("accepts a matching hash", () => {
    expect(verifyOtpHash(h("123456"), h("123456"))).toBe(true);
  });

  it("rejects a mismatch", () => {
    expect(verifyOtpHash(h("123456"), h("654321"))).toBe(false);
  });

  it("rejects empty and malformed input rather than throwing", () => {
    // timingSafeEqual throws on length mismatch; the guard must catch
    // that so a malformed request is a failed login, not a 500.
    expect(verifyOtpHash("", "")).toBe(false);
    expect(verifyOtpHash(h("123456"), "")).toBe(false);
    expect(verifyOtpHash(h("123456"), "zz")).toBe(false);
  });
});

describe("normalisePhone", () => {
  it("normalises the ways Indian users actually type their number", () => {
    const expected = "+919876543210";
    for (const input of [
      "9876543210",
      "09876543210",
      "+919876543210",
      "+91 98765 43210",
      "919876543210",
      "0091 9876543210",
      "98765-43210",
      " 9876543210 ",
    ]) {
      expect(normalisePhone(input), `failed for ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it("rejects invalid numbers", () => {
    for (const bad of ["", "12345", "abcdefghij", "+", "0000000000", "5876543210", "+0123456789"]) {
      expect(normalisePhone(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it("accepts international numbers unchanged", () => {
    expect(normalisePhone("+14155552671")).toBe("+14155552671");
    expect(normalisePhone("+442071838750")).toBe("+442071838750");
  });
});

describe("maskPhone", () => {
  it("never reveals the middle digits", () => {
    const masked = maskPhone("+919876543210");
    expect(masked).toBe("+91•••••10");
    expect(masked).not.toContain("9876543");
  });
});
