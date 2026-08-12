import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EnvelopeError,
  carrierAccountAad,
  credentialFingerprint,
  openCredentials,
  sealCredentials,
} from "../src/crypto/envelope";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

const original = process.env.CREDENTIALS_MASTER_KEY;
beforeAll(() => {
  process.env.CREDENTIALS_MASTER_KEY = KEY_A;
});
afterAll(() => {
  process.env.CREDENTIALS_MASTER_KEY = original;
});

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const CREDS = { apiToken: "dlv_live_abc123", clientName: "acme", pickupLocationName: "WH1" };

describe("envelope encryption", () => {
  it("round-trips a credential object", () => {
    const aad = carrierAccountAad(TENANT_A, "delhivery");
    expect(openCredentials(sealCredentials(CREDS, aad), aad)).toEqual(CREDS);
  });

  it("never leaks the plaintext into the sealed blob", () => {
    const sealed = sealCredentials(CREDS, carrierAccountAad(TENANT_A, "delhivery"));
    expect(sealed).not.toContain("dlv_live_abc123");
    expect(sealed).not.toContain("acme");
  });

  it("produces a different blob every time for the same input", () => {
    // Per-record data keys plus random IVs. Identical ciphertexts would
    // let an attacker tell which merchants share a credential.
    const aad = carrierAccountAad(TENANT_A, "delhivery");
    expect(sealCredentials(CREDS, aad)).not.toBe(sealCredentials(CREDS, aad));
  });

  it("refuses a credential moved to another tenant", () => {
    // The attack this prevents: someone with write access copies
    // tenant A's carrier row onto tenant B and books on A's account.
    const sealed = sealCredentials(CREDS, carrierAccountAad(TENANT_A, "delhivery"));
    expect(() =>
      openCredentials(sealed, carrierAccountAad(TENANT_B, "delhivery")),
    ).toThrow(EnvelopeError);
  });

  it("refuses a credential moved to another carrier", () => {
    const sealed = sealCredentials(CREDS, carrierAccountAad(TENANT_A, "delhivery"));
    expect(() => openCredentials(sealed, carrierAccountAad(TENANT_A, "ekart"))).toThrow(
      EnvelopeError,
    );
  });

  it("detects tampering with the ciphertext", () => {
    const aad = carrierAccountAad(TENANT_A, "delhivery");
    const sealed = sealCredentials(CREDS, aad);
    const parts = sealed.split(".");
    const ct = parts[6]!;
    parts[6] = ct.slice(0, -2) + (ct.endsWith("AA") ? "BB" : "AA");
    expect(() => openCredentials(parts.join("."), aad)).toThrow(EnvelopeError);
  });

  it("is useless without the master key", () => {
    const aad = carrierAccountAad(TENANT_A, "delhivery");
    const sealed = sealCredentials(CREDS, aad);

    process.env.CREDENTIALS_MASTER_KEY = KEY_B;
    try {
      // This is the whole point: a stolen database dump yields nothing.
      expect(() => openCredentials(sealed, aad)).toThrow(EnvelopeError);
    } finally {
      process.env.CREDENTIALS_MASTER_KEY = KEY_A;
    }
  });

  it("rejects a malformed envelope rather than guessing", () => {
    const aad = carrierAccountAad(TENANT_A, "delhivery");
    for (const bad of ["", "garbage", "v9.a.b.c.d.e.f", "v1.only.three"]) {
      expect(() => openCredentials(bad, aad)).toThrow(EnvelopeError);
    }
  });

  it("rejects a master key of the wrong length with actionable guidance", () => {
    process.env.CREDENTIALS_MASTER_KEY = Buffer.from("too short").toString("base64");
    try {
      expect(() => sealCredentials(CREDS, "x")).toThrow(/openssl rand -base64 32/);
    } finally {
      process.env.CREDENTIALS_MASTER_KEY = KEY_A;
    }
  });

  it("fingerprints without revealing anything", () => {
    const sealed = sealCredentials(CREDS, carrierAccountAad(TENANT_A, "delhivery"));
    const fp = credentialFingerprint(sealed);
    expect(fp.startsWith("••")).toBe(true);
    expect(fp.length).toBeLessThan(12);
    expect(CREDS.apiToken).not.toContain(fp.slice(2));
  });
});
