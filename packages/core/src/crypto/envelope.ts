import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for tenant-held third-party credentials.
 *
 * Carrier API keys, gateway secrets and messaging tokens are not our
 * secrets to lose — they belong to merchants, and a leaked
 * `carrier_accounts` table would let an attacker book shipments, cancel
 * pickups and read every customer address across every tenant.
 *
 * Scheme, per record:
 *   1. Generate a fresh random 256-bit DATA key.
 *   2. Encrypt the plaintext with it (AES-256-GCM).
 *   3. Encrypt the data key with the MASTER key (AES-256-GCM).
 *   4. Store the wrapped data key alongside the ciphertext.
 *
 * The master key lives in the process environment / secret store and
 * never in the database, so a database dump alone yields nothing. Per
 * record data keys mean rotating the master key rewraps a small key
 * blob rather than re-encrypting every secret, and a single compromised
 * data key exposes exactly one credential.
 *
 * GCM is chosen over CBC because it authenticates: tampering with
 * ciphertext fails loudly at decrypt rather than silently producing
 * garbage that some HTTP client then sends to a carrier.
 */

const VERSION = "v1";
const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

function masterKey(): Buffer {
  const raw = process.env.CREDENTIALS_MASTER_KEY;
  if (!raw) throw new EnvelopeError("CREDENTIALS_MASTER_KEY is not set");

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new EnvelopeError(
      `CREDENTIALS_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

function encryptWith(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypts a credential object. The returned string is opaque and safe
 * to store in a TEXT column.
 *
 * `aad` binds the ciphertext to its context (tenant + carrier), so a
 * row copied from one tenant to another fails to decrypt. Without it,
 * an attacker with write access could move tenant A's carrier
 * credentials onto tenant B's row and use them.
 */
export function sealCredentials(plaintext: unknown, aad: string): string {
  const dataKey = randomBytes(KEY_BYTES);
  const body = Buffer.from(JSON.stringify(plaintext), "utf8");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, dataKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();

  const wrapped = encryptWith(masterKey(), dataKey);
  dataKey.fill(0); // do not leave the key sitting in the heap

  return [
    VERSION,
    wrapped.iv.toString("base64url"),
    wrapped.tag.toString("base64url"),
    wrapped.ct.toString("base64url"),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

export function openCredentials<T = unknown>(sealed: string, aad: string): T {
  const parts = sealed.split(".");
  if (parts.length !== 7 || parts[0] !== VERSION) {
    throw new EnvelopeError("Malformed or unsupported credential envelope");
  }

  const [, wIv, wTag, wCt, iv, tag, ct] = parts as [
    string, string, string, string, string, string, string,
  ];

  let dataKey: Buffer;
  try {
    dataKey = decryptWith(
      masterKey(),
      Buffer.from(wIv, "base64url"),
      Buffer.from(wTag, "base64url"),
      Buffer.from(wCt, "base64url"),
    );
  } catch {
    // Deliberately generic: distinguishing "wrong master key" from
    // "tampered blob" is useful to an attacker and to nobody else.
    throw new EnvelopeError("Unable to unwrap credential key");
  }

  try {
    const decipher = createDecipheriv(ALGO, dataKey, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(out.toString("utf8")) as T;
  } catch {
    throw new EnvelopeError("Credential failed authentication — wrong context or tampered");
  } finally {
    dataKey.fill(0);
  }
}

/** Canonical AAD for a carrier account. Changing this breaks old rows. */
export function carrierAccountAad(tenantId: string, carrierCode: string): string {
  return `carrier_account:${tenantId}:${carrierCode}`;
}

/**
 * Fingerprint for display and change-detection. Lets the console show
 * "key ending ••4f2a" and lets us detect a re-paste of the same key
 * without ever decrypting or logging the secret.
 */
export function credentialFingerprint(sealed: string): string {
  const tail = sealed.slice(-8);
  return `••${tail}`;
}

/** Constant-time compare for webhook signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
