import { randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeConnections, withTenant } from "@platform/db";
import { EnvelopeError } from "@platform/core";
import {
  createRefundIntent,
  getEnabledAccount,
  getPaymentAccountView,
  recordWebhookEvent,
  unsealGatewayCredentials,
  unsealWebhookSecret,
  upsertPaymentAccount,
} from "@platform/core/payments/server";

/**
 * payment_accounts + the envelope discipline against real Postgres:
 * TWO separately sealed blobs per account (D7), AAD bound to
 * (tenant_id, provider_code) so cross-tenant and cross-blob unseals fail
 * at the cipher; fingerprint-only reads; the one-enabled partial unique;
 * webhook-event dedupe by constraint; insert-once refund intents (D6).
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

let tenantA: string;
let tenantB: string;
let userA: string;

const createdTenants = new Set<string>();
const createdUsers = new Set<string>();
const createdPlans = new Set<string>();

let savedMasterKey: string | undefined;

const KEY_SECRET = "rzp_secret_plain_A9x";
const WEBHOOK_SECRET = "whsec_plain_B7q";

function writeCtx(tenantId: string) {
  return { tenantId, actorUserId: userA, ip: null, userAgent: null, requestId: "payacct-test" };
}

async function makeTenant(): Promise<string> {
  const slug = "pay-" + randomUUID().slice(0, 12);
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"pay-" + randomUUID().slice(0, 8)}, 'Payment accounts test plan')
    RETURNING id`;
  createdPlans.add(plan!.id);
  const [tenant] = await admin<{ id: string }[]>`
    INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
    VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${plan!.id}, 'active')
    RETURNING id`;
  createdTenants.add(tenant!.id);
  return tenant!.id;
}

async function upsertMock(tenantId: string, overrides: Record<string, unknown> = {}) {
  return upsertPaymentAccount(writeCtx(tenantId), {
    providerCode: "mock",
    publicKeyId: "rzp_test_pubkey01",
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    isEnabled: true,
    ...overrides,
  });
}

beforeAll(async () => {
  // The envelope needs a master key; integration runs load the root .env,
  // but the suite must not depend on it. Restored in afterAll BEFORE the
  // pools close (the worker-suite lesson).
  savedMasterKey = process.env.CREDENTIALS_MASTER_KEY;
  if (!savedMasterKey) {
    process.env.CREDENTIALS_MASTER_KEY = randomBytes(32).toString("base64");
  }

  tenantA = await makeTenant();
  tenantB = await makeTenant();

  userA = randomUUID();
  createdUsers.add(userA);
  const phone = "+9198" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  await admin`INSERT INTO users (id, phone_e164, name) VALUES (${userA}, ${phone}, 'Pay accounts test')`;
});

afterAll(async () => {
  if (savedMasterKey === undefined) {
    delete process.env.CREDENTIALS_MASTER_KEY;
  } else {
    process.env.CREDENTIALS_MASTER_KEY = savedMasterKey;
  }
  for (const id of createdTenants) await admin`DELETE FROM tenants WHERE id = ${id}`;
  for (const id of createdUsers) await admin`DELETE FROM users WHERE id = ${id}`;
  for (const id of createdPlans) await admin`DELETE FROM plans WHERE id = ${id}`;
  await admin.end();
  await closeConnections();
});

describe("payment accounts — sealing (D7)", () => {
  it("seals TWO distinct blobs, stores no plaintext, and both roundtrip through their own unseal", async () => {
    await upsertMock(tenantA);

    const [row] = await admin<
      { sealed_credentials: string; sealed_webhook_secret: string }[]
    >`SELECT sealed_credentials, sealed_webhook_secret FROM payment_accounts
      WHERE tenant_id = ${tenantA} AND provider_code = 'mock'`;
    expect(row).toBeDefined();
    // Two envelopes, not one reused.
    expect(row!.sealed_credentials).not.toBe(row!.sealed_webhook_secret);
    // Neither blob leaks its plaintext.
    expect(row!.sealed_credentials).not.toContain(KEY_SECRET);
    expect(row!.sealed_webhook_secret).not.toContain(WEBHOOK_SECRET);

    const account = await withTenant(tenantA, (tx) => getEnabledAccount(tx, tenantA));
    expect(account).not.toBeNull();
    const creds = await unsealGatewayCredentials(tenantA, account!);
    expect(creds).toEqual({ keyId: "rzp_test_pubkey01", keySecret: KEY_SECRET });
    const webhookSecret = await unsealWebhookSecret(tenantA, account!);
    expect(webhookSecret).toBe(WEBHOOK_SECRET);
  });

  it("refuses to unseal one blob through the other helper — the AAD split is cryptographic", async () => {
    const account = await withTenant(tenantA, (tx) => getEnabledAccount(tx, tenantA));
    expect(account).not.toBeNull();

    // The webhook helper handed the API-key blob: authentication fails.
    await expect(
      unsealWebhookSecret(tenantA, {
        providerCode: account!.providerCode,
        sealedWebhookSecret: account!.sealedCredentials,
      }),
    ).rejects.toBeInstanceOf(EnvelopeError);

    // And vice versa: the credentials helper never opens the webhook blob.
    await expect(
      unsealGatewayCredentials(tenantA, {
        providerCode: account!.providerCode,
        sealedCredentials: account!.sealedWebhookSecret,
      }),
    ).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("fails to unseal a blob copied across tenants — AAD binds (tenant_id, provider_code)", async () => {
    const account = await withTenant(tenantA, (tx) => getEnabledAccount(tx, tenantA));
    expect(account).not.toBeNull();

    // Same blob, same provider, wrong tenant in the AAD: refused.
    await expect(unsealGatewayCredentials(tenantB, account!)).rejects.toBeInstanceOf(EnvelopeError);
    await expect(unsealWebhookSecret(tenantB, account!)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("returns fingerprint-only views — the secrets appear nowhere, and rotate the fingerprint", async () => {
    const before = await getPaymentAccountView(tenantA);
    expect(before).not.toBeNull();
    const serialized = JSON.stringify(before);
    expect(serialized).not.toContain(KEY_SECRET);
    expect(serialized).not.toContain(WEBHOOK_SECRET);
    expect(serialized).not.toContain("sealed");
    expect(before!.credentialFingerprint).toMatch(/^••/);
    expect(before!.publicKeyId).toBe("rzp_test_pubkey01");

    // Re-saving (even the same secret) reseals with a fresh envelope, so
    // the fingerprint moves — the console's change-detection signal.
    const updated = await upsertMock(tenantA, { keySecret: "rzp_secret_rotated_C3z" });
    expect(updated.credentialFingerprint).not.toBe(before!.credentialFingerprint);
    expect(JSON.stringify(updated)).not.toContain("rzp_secret_rotated_C3z");
  });

  it("keeps at most ONE enabled gateway per tenant: enabling another disables the first", async () => {
    await upsertMock(tenantA); // mock enabled (from earlier tests / idempotent)
    await upsertPaymentAccount(writeCtx(tenantA), {
      providerCode: "razorpay",
      publicKeyId: "rzp_live_pubkey02",
      keySecret: "rzp_live_secret02",
      webhookSecret: "whsec_live_02",
      isEnabled: true,
    });

    const enabledRows = await admin<{ provider_code: string }[]>`
      SELECT provider_code FROM payment_accounts
      WHERE tenant_id = ${tenantA} AND is_enabled`;
    expect(enabledRows.length).toBe(1);
    expect(enabledRows[0]!.provider_code).toBe("razorpay");

    const account = await withTenant(tenantA, (tx) => getEnabledAccount(tx, tenantA));
    expect(account!.providerCode).toBe("razorpay");
  });
});

describe("webhook events + refund intents — constraint-resolved idempotency", () => {
  it("dedupes webhook events on (tenant, provider, gateway_event_id): the replay reports duplicate", async () => {
    const eventId = `evt_test_${randomUUID()}`;
    const first = await recordWebhookEvent(
      { tenantId: tenantA },
      {
        providerCode: "mock",
        gatewayEventId: eventId,
        eventType: "payment.captured",
        rawPayload: { event: "payment.captured", marker: "first-delivery" },
      },
    );
    expect(first.duplicate).toBe(false);

    const replay = await recordWebhookEvent(
      { tenantId: tenantA },
      {
        providerCode: "mock",
        gatewayEventId: eventId,
        eventType: "payment.captured",
        rawPayload: { event: "payment.captured", marker: "redelivery" },
      },
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.webhookEventId).toBe(first.webhookEventId);

    // The constraint is per provider — the same id under another provider
    // is a different event.
    const otherProvider = await recordWebhookEvent(
      { tenantId: tenantA },
      {
        providerCode: "razorpay",
        gatewayEventId: eventId,
        eventType: "payment.captured",
        rawPayload: {},
      },
    );
    expect(otherProvider.duplicate).toBe(false);

    // Exactly one row survived for (tenant, mock, eventId), the FIRST one.
    const rows = await admin<{ raw_payload: { marker?: string } }[]>`
      SELECT raw_payload FROM payment_webhook_events
      WHERE tenant_id = ${tenantA} AND provider_code = 'mock' AND gateway_event_id = ${eventId}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.raw_payload.marker).toBe("first-delivery");
  });

  it("inserts a refund intent ONCE per payment (D6): the second call replays without aborting the tx", async () => {
    const orderId = randomUUID();
    const paymentId = randomUUID();

    // Both calls INSIDE one transaction: a raised 23505 would abort it,
    // so this also proves the mapping is deliverable in-tx.
    const [first, second] = await withTenant(tenantA, async (tx) => {
      const a = await createRefundIntent(tx, tenantA, {
        orderId,
        paymentId,
        amountPaise: 129900,
        reason: "merchant_cancelled",
        createdByUserId: userA,
      });
      const b = await createRefundIntent(tx, tenantA, {
        orderId,
        paymentId,
        amountPaise: 129900,
        reason: "merchant_cancelled",
      });
      return [a, b];
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.refundId).toBe(first.refundId);

    // And a later transaction replays the same winner.
    const third = await withTenant(tenantA, (tx) =>
      createRefundIntent(tx, tenantA, {
        orderId,
        paymentId,
        amountPaise: 129900,
        reason: "stock_shortfall",
      }),
    );
    expect(third.created).toBe(false);
    expect(third.refundId).toBe(first.refundId);

    const rows = await admin<{ status: string; reason: string }[]>`
      SELECT status, reason FROM refunds WHERE tenant_id = ${tenantA} AND payment_id = ${paymentId}`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("pending");
    // The winner's reason stands; the replay never overwrites.
    expect(rows[0]!.reason).toBe("merchant_cancelled");
  });
});
