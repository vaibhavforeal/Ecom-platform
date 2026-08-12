import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * OTP code generation and verification.
 *
 * Pure functions, no I/O — so the security-critical bits are trivially
 * testable without a database (see tests/otp.test.ts).
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300; // 5 minutes
export const OTP_MAX_ATTEMPTS = 5;

/**
 * `randomInt` is CSPRNG-backed and rejection-samples internally, so the
 * distribution is uniform. `Math.random()` here would be a real
 * vulnerability, not a style issue.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/**
 * Codes are stored as an HMAC keyed by a server-side pepper, never in
 * plaintext, so a database dump alone does not let an attacker complete
 * a login.
 *
 * HMAC-SHA256 rather than a slow KDF is the right call *here* — the
 * search space is only 10^6, but the code is single-use, expires in five
 * minutes, and is capped at five attempts, so an offline attack needs
 * the pepper (which is not in the database) and an online attack is
 * bounded by the rate limiter. Binding phone and purpose into the
 * message stops a code minted for one flow being replayed into another.
 */
export function hashOtpCode(input: {
  phoneE164: string;
  purpose: string;
  code: string;
  pepper: string;
}): string {
  if (!input.pepper || input.pepper.length < 32) {
    throw new Error("OTP_PEPPER must be at least 32 characters");
  }
  return createHmac("sha256", input.pepper)
    .update(`${input.phoneE164}:${input.purpose}:${input.code}`)
    .digest("hex");
}

/** Constant-time comparison — a fast `===` leaks the code byte by byte. */
export function verifyOtpHash(expectedHex: string, candidateHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(candidateHex, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * E.164 normalisation for Indian input.
 *
 * Merchants and their customers type "98765 43210", "098765-43210" and
 * "+91 98765 43210" interchangeably. Normalising at the edge means the
 * database holds exactly one representation, which is what makes the
 * unique index on users.phone_e164 meaningful.
 */
export function normalisePhone(raw: string, defaultCountry = "91"): string | null {
  const digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    const rest = digits.slice(1);
    return /^[1-9]\d{7,14}$/.test(rest) ? `+${rest}` : null;
  }

  let local = digits;
  if (local.startsWith("00")) local = local.slice(2);
  else if (local.startsWith("0")) local = local.slice(1);

  // Bare 10-digit Indian mobile: prepend the default country code.
  if (defaultCountry === "91" && /^[6-9]\d{9}$/.test(local)) return `+91${local}`;

  if (local.startsWith(defaultCountry) && /^[1-9]\d{7,14}$/.test(local)) return `+${local}`;

  return null;
}

/** Never log or display a full phone number. */
export function maskPhone(e164: string): string {
  return e164.length <= 4 ? "•".repeat(e164.length) : `${e164.slice(0, 3)}•••••${e164.slice(-2)}`;
}
