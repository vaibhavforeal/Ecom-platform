import { randomBytes, randomUUID } from "node:crypto";

import { closeRedis, credentialFingerprint, sealCredentials } from "@platform/core";
import {
  paymentCredentialsAad,
  paymentWebhookSecretAad,
} from "@platform/core/payments/server";
import { mockWebhookBody } from "@platform/integrations/payments";
import { closeConnections } from "@platform/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Storefront buyer routes (spec §7, lot B4): cookie lifecycle,
 * tenant-by-host isolation, the shared 422 envelope, availability with
 * the hold filter, the serviceability policy modes, and the guest
 * order-token gate.
 *
 * Route handlers are called directly as (Request) => Response functions
 * — tenant resolution reads the request's own headers (buyer-api.ts), so
 * no Next server is needed. The checkout POST and payments webhook rows
 * of the §9 matrix belong to lot B-INT and are declared as todos at the
 * bottom, next to the routes that will own them.
 */

const migratorUrl = process.env.DATABASE_URL_MIGRATOR;
if (!migratorUrl) throw new Error("DATABASE_URL_MIGRATOR must be set to run integration tests");

const admin = postgres(migratorUrl, { max: 2, onnotice: () => {} });

// SESSION_SECRET signs guest order tokens. The root .env supplies it in
// real runs; a fallback keeps the suite self-contained, restored on exit.
const hadSessionSecret = process.env.SESSION_SECRET !== undefined;
process.env.SESSION_SECRET ??= "integration-test-secret-0000000000000000000000000000000000000000";
// CREDENTIALS_MASTER_KEY seals the B-INT payment-account fixtures.
const savedMasterKey = process.env.CREDENTIALS_MASTER_KEY;
process.env.CREDENTIALS_MASTER_KEY ??= randomBytes(32).toString("base64");

const { GET: cartGET, POST: cartPOST } = await import("../src/app/api/cart/route");
const { POST: couponPOST, DELETE: couponDELETE } = await import(
  "../src/app/api/cart/coupon/route"
);
const { POST: serviceabilityPOST } = await import(
  "../src/app/api/checkout/serviceability/route"
);
const { POST: checkoutPOST } = await import("../src/app/api/checkout/route");
const { POST: webhookPOST } = await import("../src/app/api/payments/webhook/route");
const { signOrderToken, verifyOrderToken } = await import("../src/lib/order-token");

const run = randomUUID().slice(0, 8);
const HOST_A = `b4-a-${run}.test`;
const HOST_B = `b4-b-${run}.test`;

let planId: string;
let tenantA: string;
let tenantB: string;
let locationA: string;

/** Variant ids seeded in beforeAll. */
let plainVariant: string; // untracked — can never run out
let trackedVariant: string; // on_hand 2, no holds
let heldVariant: string; // on_hand 2, one ACTIVE hold of 1
let lapsedVariant: string; // on_hand 2, one EXPIRED hold of 2
let foreignVariant: string; // belongs to tenant B
let checkoutVariant: string; // on_hand 5, reserved for the B-INT flows

/** Webhook HMAC secret for tenant A's enabled mock account (B-INT rows). */
const WEBHOOK_SECRET_A = "storefront-int-webhook-secret";

/** Fixture tenant for the suspended-webhook case; cleaned in afterAll. */
let suspendedTenant: string | null = null;

type CartBody = {
  cart: {
    cartId: string;
    status: string;
    couponCode: string | null;
    couponPreview: { code: string; applicable: boolean; reason?: string } | null;
    subtotalPaise: number;
    lines: {
      variantId: string;
      quantity: number;
      unitPricePaise: number;
      lineTotalPaise: number;
      available: number | null;
    }[];
  } | null;
  requestId: string;
};

type ErrorBody = {
  error: { code: string; message: string; details?: { issues?: { path: string; message: string }[] } };
  requestId: string;
};

function req(
  host: string,
  path: string,
  init: { method?: string; cookie?: string; json?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-host": host, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /cart_id=([^;]+)/.exec(setCookie);
  expect(match, `expected a cart_id cookie in: ${setCookie}`).not.toBeNull();
  return `cart_id=${match![1]}`;
}

async function seedVariant(
  tenantId: string,
  title: string,
  opts: { tracks: boolean; onHand?: number; locationId?: string },
): Promise<string> {
  const productId = randomUUID();
  await admin`
    INSERT INTO products (id, tenant_id, title, status, published_at)
    VALUES (${productId}, ${tenantId}, ${title}, 'active', now())`;
  const variantId = randomUUID();
  await admin`
    INSERT INTO product_variants
      (id, tenant_id, product_id, sku, price_paise, weight_grams, tracks_inventory)
    VALUES (${variantId}, ${tenantId}, ${productId}, ${title + "-" + run}, 49900, 100, ${opts.tracks})`;
  if (opts.tracks && opts.locationId) {
    await admin`
      INSERT INTO stock_levels (tenant_id, variant_id, location_id, on_hand)
      VALUES (${tenantId}, ${variantId}, ${opts.locationId}, ${opts.onHand ?? 0})`;
  }
  return variantId;
}

beforeAll(async () => {
  const [plan] = await admin<{ id: string }[]>`
    INSERT INTO plans (id, code, name)
    VALUES (${randomUUID()}, ${"b4-" + run}, 'B4 routes test plan')
    RETURNING id`;
  planId = plan!.id;

  const mkTenant = async (slug: string, hostname: string): Promise<string> => {
    const [tenant] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${planId}, 'active')
      RETURNING id`;
    await admin`
      INSERT INTO domains (id, tenant_id, hostname, is_primary, verified_at)
      VALUES (${randomUUID()}, ${tenant!.id}, ${hostname}, true, now())`;
    return tenant!.id;
  };

  tenantA = await mkTenant(`b4a-${run}`, HOST_A);
  tenantB = await mkTenant(`b4b-${run}`, HOST_B);

  const [loc] = await admin<{ id: string }[]>`
    INSERT INTO locations (id, tenant_id, name, is_default)
    VALUES (${randomUUID()}, ${tenantA}, 'Default', true)
    RETURNING id`;
  locationA = loc!.id;

  plainVariant = await seedVariant(tenantA, "B4 Plain", { tracks: false });
  trackedVariant = await seedVariant(tenantA, "B4 Tracked", {
    tracks: true,
    onHand: 2,
    locationId: locationA,
  });
  heldVariant = await seedVariant(tenantA, "B4 Held", {
    tracks: true,
    onHand: 2,
    locationId: locationA,
  });
  lapsedVariant = await seedVariant(tenantA, "B4 Lapsed", {
    tracks: true,
    onHand: 2,
    locationId: locationA,
  });
  foreignVariant = await seedVariant(tenantB, "B4 Foreign", { tracks: false });

  // One ACTIVE hold on heldVariant, one EXPIRED hold on lapsedVariant —
  // the expires_at > now() read-side filter is the assertion target.
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${heldVariant}, ${locationA}, 1,
            'checkout', ${randomUUID()}, now() + interval '15 minutes')`;
  await admin`
    INSERT INTO stock_reservations
      (id, tenant_id, variant_id, location_id, quantity, reference_type, reference_id, expires_at)
    VALUES (${randomUUID()}, ${tenantA}, ${lapsedVariant}, ${locationA}, 2,
            'checkout', ${randomUUID()}, now() - interval '1 minute')`;

  // B-INT fixtures: stock for the full checkout flows and tenant A's
  // enabled mock gateway account (two sealed blobs, D7).
  checkoutVariant = await seedVariant(tenantA, "B4 Checkout", {
    tracks: true,
    onHand: 5,
    locationId: locationA,
  });
  const sealedCredentials = sealCredentials(
    { keyId: "mock_pub_sf", keySecret: "mock_secret_sf" },
    paymentCredentialsAad(tenantA, "mock"),
  );
  const sealedWebhookSecret = sealCredentials(
    { webhookSecret: WEBHOOK_SECRET_A },
    paymentWebhookSecretAad(tenantA, "mock"),
  );
  await admin`
    INSERT INTO payment_accounts
      (id, tenant_id, provider_code, label, public_key_id,
       sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
    VALUES (${randomUUID()}, ${tenantA}, 'mock', 'Default', 'mock_pub_sf',
            ${sealedCredentials}, ${sealedWebhookSecret},
            ${credentialFingerprint(sealedCredentials)}, true)`;
});

afterAll(async () => {
  // Restore env mutations BEFORE closing pools (worker-suite lesson).
  if (!hadSessionSecret) delete process.env.SESSION_SECRET;
  if (savedMasterKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
  else process.env.CREDENTIALS_MASTER_KEY = savedMasterKey;
  if (suspendedTenant) await admin`DELETE FROM tenants WHERE id = ${suspendedTenant}`;
  await admin`DELETE FROM tenants WHERE id IN (${tenantA}, ${tenantB})`;
  await admin`DELETE FROM plans WHERE id = ${planId}`;
  await admin.end({ timeout: 5 });
  await closeRedis();
  await closeConnections();
});

describe("cart routes: cookie lifecycle", () => {
  it("POST /api/cart mints a cart, sets an httpOnly SameSite=Lax cookie, and prices live", async () => {
    const res = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 2 },
    }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/cart_id=[0-9a-f-]{36}/i);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).toContain("path=/");

    const body = (await res.json()) as CartBody;
    expect(body.cart).not.toBeNull();
    expect(body.cart!.lines).toHaveLength(1);
    expect(body.cart!.lines[0]).toMatchObject({
      variantId: plainVariant,
      quantity: 2,
      unitPricePaise: 49900,
      lineTotalPaise: 99800,
      available: null, // untracked — cannot run out
    });
    expect(body.cart!.subtotalPaise).toBe(99800);
  });

  it("GET /api/cart with the cookie returns the SAME cart; without one, none", async () => {
    const create = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 1 },
    }));
    const cookie = cookieFrom(create);
    const created = ((await create.json()) as CartBody).cart!.cartId;

    const read = await cartGET(req(HOST_A, "/api/cart", { cookie }));
    expect(read.status).toBe(200);
    expect(((await read.json()) as CartBody).cart!.cartId).toBe(created);

    const bare = await cartGET(req(HOST_A, "/api/cart"));
    expect(((await bare.json()) as CartBody).cart).toBeNull();
  });

  it("a repeat POST replaces the quantity; quantity 0 removes the line", async () => {
    const create = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 3 },
    }));
    const cookie = cookieFrom(create);

    const update = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      cookie,
      json: { variantId: plainVariant, quantity: 5 },
    }));
    const updated = (await update.json()) as CartBody;
    expect(updated.cart!.lines).toHaveLength(1); // replaced, not appended
    expect(updated.cart!.lines[0]!.quantity).toBe(5);

    const remove = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      cookie,
      json: { variantId: plainVariant, quantity: 0 },
    }));
    expect(((await remove.json()) as CartBody).cart!.lines).toHaveLength(0);
  });
});

describe("cart routes: tenant-by-host isolation", () => {
  it("a cart cookie replayed against another tenant's host matches zero rows", async () => {
    const create = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 1 },
    }));
    const cookie = cookieFrom(create);
    const cartIdA = ((await create.json()) as CartBody).cart!.cartId;

    // Read on tenant B's host: RLS makes the cart invisible, not an error.
    const readB = await cartGET(req(HOST_B, "/api/cart", { cookie }));
    expect(readB.status).toBe(200);
    expect(((await readB.json()) as CartBody).cart).toBeNull();

    // Write on tenant B's host: a FRESH tenant-B cart is minted rather
    // than writing into tenant A's.
    const writeB = await cartPOST(req(HOST_B, "/api/cart", {
      method: "POST",
      cookie,
      json: { variantId: foreignVariant, quantity: 1 },
    }));
    expect(writeB.status).toBe(200);
    expect(((await writeB.json()) as CartBody).cart!.cartId).not.toBe(cartIdA);
  });

  it("a foreign tenant's variant id against this host is a 404, never a write (FK ≠ tenancy)", async () => {
    const res = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: foreignVariant, quantity: 1 },
    }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });

  it("an unknown host is a 404 envelope, never a default tenant", async () => {
    const res = await cartGET(req(`nobody-${run}.test`, "/api/cart"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });
});

describe("cart routes: 422 envelopes and availability", () => {
  it("zod refusals use the shared envelope with details.issues[{path,message}]", async () => {
    const badVariant = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: "not-a-uuid", quantity: 1 },
    }));
    expect(badVariant.status).toBe(422);
    const body1 = (await badVariant.json()) as ErrorBody;
    expect(body1.error.code).toBe("invalid_payload");
    expect(body1.error.details?.issues?.[0]?.path).toBe("variantId");
    expect(body1.requestId).toBeTruthy();

    const badQuantity = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 101 },
    }));
    expect(badQuantity.status).toBe(422);
    expect(((await badQuantity.json()) as ErrorBody).error.details?.issues?.[0]?.path).toBe(
      "quantity",
    );
  });

  it("requests beyond available stock refuse insufficient_stock (422)", async () => {
    const res = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: trackedVariant, quantity: 3 }, // on_hand 2
    }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("insufficient_stock");

    const ok = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: trackedVariant, quantity: 2 },
    }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as CartBody).cart!.lines[0]!.available).toBe(2);
  });

  it("an ACTIVE hold subtracts from availability; an EXPIRED one does not", async () => {
    // on_hand 2, active hold 1 → available 1.
    const refused = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: heldVariant, quantity: 2 },
    }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as ErrorBody).error.code).toBe("insufficient_stock");

    const allowed = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: heldVariant, quantity: 1 },
    }));
    expect(allowed.status).toBe(200);

    // on_hand 2, expired hold 2 → still available 2 (read-side expiry —
    // no sweeper needed for correctness).
    const lapsed = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: lapsedVariant, quantity: 2 },
    }));
    expect(lapsed.status).toBe(200);
    expect(((await lapsed.json()) as CartBody).cart!.lines.at(-1)!.available).toBe(2);
  });
});

describe("coupon routes", () => {
  it("POST stores the UPPERCASED code with a read-only preview; DELETE clears it", async () => {
    const create = await cartPOST(req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: plainVariant, quantity: 1 },
    }));
    const cookie = cookieFrom(create);

    const set = await couponPOST(req(HOST_A, "/api/cart/coupon", {
      method: "POST",
      cookie,
      json: { code: "welcome10" },
    }));
    expect(set.status).toBe(200);
    const withCoupon = (await set.json()) as CartBody;
    expect(withCoupon.cart!.couponCode).toBe("WELCOME10");
    // No promotions row exists — evaluation only, honest refusal, and
    // decisively NOT a claim on anything.
    expect(withCoupon.cart!.couponPreview).toMatchObject({
      code: "WELCOME10",
      applicable: false,
    });

    const clear = await couponDELETE(req(HOST_A, "/api/cart/coupon", {
      method: "DELETE",
      cookie,
    }));
    expect(clear.status).toBe(200);
    const cleared = (await clear.json()) as CartBody;
    expect(cleared.cart!.couponCode).toBeNull();
    expect(cleared.cart!.couponPreview).toBeNull();
  });

  it("a coupon POST without a cart cookie is a 404", async () => {
    const res = await couponPOST(req(HOST_A, "/api/cart/coupon", {
      method: "POST",
      json: { code: "WELCOME10" },
    }));
    expect(res.status).toBe(404);
  });
});

describe("serviceability route (§1.10 policy from store_settings)", () => {
  it("default policy (no setting) serves every pincode: {mode:'all'}", async () => {
    const res = await serviceabilityPOST(req(HOST_A, "/api/checkout/serviceability", {
      method: "POST",
      json: { pincode: "110001" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ serviceable: true, mode: "all" });
  });

  it("list policy serves matching prefixes and refuses the rest as pincode_unserviceable", async () => {
    await admin`
      INSERT INTO store_settings (tenant_id, key, value)
      VALUES (${tenantB}, 'shipping.pincode_policy',
              ${'{"mode":"list","allowedPrefixes":["11","560"]}'}::text::jsonb)`;
    try {
      const inside = await serviceabilityPOST(req(HOST_B, "/api/checkout/serviceability", {
        method: "POST",
        json: { pincode: "110001" },
      }));
      expect(await inside.json()).toMatchObject({ serviceable: true, mode: "list" });

      const outside = await serviceabilityPOST(req(HOST_B, "/api/checkout/serviceability", {
        method: "POST",
        json: { pincode: "400001" },
      }));
      expect(outside.status).toBe(200);
      expect(await outside.json()).toMatchObject({
        serviceable: false,
        mode: "list",
        reason: "pincode_unserviceable",
      });
    } finally {
      await admin`
        DELETE FROM store_settings
        WHERE tenant_id = ${tenantB} AND key = 'shipping.pincode_policy'`;
    }
  });

  it("carrier policy refuses with a typed 422 not_supported_yet (no live transport in Phase 2)", async () => {
    await admin`
      INSERT INTO store_settings (tenant_id, key, value)
      VALUES (${tenantB}, 'shipping.pincode_policy', ${'{"mode":"carrier"}'}::text::jsonb)`;
    try {
      const res = await serviceabilityPOST(req(HOST_B, "/api/checkout/serviceability", {
        method: "POST",
        json: { pincode: "110001" },
      }));
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorBody).error.code).toBe("not_supported_yet");
    } finally {
      await admin`
        DELETE FROM store_settings
        WHERE tenant_id = ${tenantB} AND key = 'shipping.pincode_policy'`;
    }
  });

  it("a malformed pincode is the shared 422 invalid_payload envelope", async () => {
    const res = await serviceabilityPOST(req(HOST_A, "/api/checkout/serviceability", {
      method: "POST",
      json: { pincode: "01100" },
    }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_payload");
    expect(body.error.details?.issues?.[0]?.path).toBe("pincode");
  });
});

describe("guest order token gate (spec §7)", () => {
  it("verifies its own signature, refuses tampered and cross-order tokens", () => {
    const orderId = randomUUID();
    const token = signOrderToken(orderId);

    expect(verifyOrderToken(orderId, token)).toBe(true);

    // Tampered: flip one character (base64url-safely).
    const tampered = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(verifyOrderToken(orderId, tampered)).toBe(false);

    // A valid token authorises exactly ONE order id.
    expect(verifyOrderToken(randomUUID(), token)).toBe(false);

    // Absent/empty/short never pass (length gate before timingSafeEqual).
    expect(verifyOrderToken(orderId, undefined)).toBe(false);
    expect(verifyOrderToken(orderId, "")).toBe(false);
    expect(verifyOrderToken(orderId, "short")).toBe(false);
  });
});

/**
 * §9 matrix rows owned by lot B-INT: the routes B4 does not own
 * (POST /api/checkout, POST /api/payments/webhook), driven end to end
 * over the same (Request) => Response shape as the rest of the suite.
 */

function checkoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: randomUUID(),
    buyerName: "Storefront Buyer",
    phone: "+919876500001",
    email: null,
    shippingAddress: {
      line1: "5 Route Test Road",
      line2: null,
      city: "New Delhi",
      stateCode: "07",
      pincode: "110001",
    },
    buyerGstin: null,
    couponCode: null,
    paymentMode: "prepaid",
    ...overrides,
  };
}

/** Cart with one checkoutVariant unit; returns the cookie to check out with. */
async function cartForCheckout(): Promise<string> {
  const res = await cartPOST(
    req(HOST_A, "/api/cart", {
      method: "POST",
      json: { variantId: checkoutVariant, quantity: 1 },
    }),
  );
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

function webhookReq(
  host: string,
  rawBody: string,
  headers: Record<string, string>,
): Request {
  return new Request(`http://${host}/api/payments/webhook`, {
    method: "POST",
    headers: { "x-forwarded-host": host, "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

describe("B-INT: POST /api/checkout — pincode_state_mismatch (D3)", () => {
  it("refuses a state outside the pincode's prefix set with the allowed states in details", async () => {
    const cookie = await cartForCheckout();
    const body = checkoutBody({
      shippingAddress: {
        line1: "5 Route Test Road",
        line2: null,
        city: "Mismatch City",
        stateCode: "29", // Karnataka against a Delhi pincode
        pincode: "110001",
      },
    });
    const res = await checkoutPOST(req(HOST_A, "/api/checkout", { method: "POST", cookie, json: body }));
    expect(res.status).toBe(422);
    const payload = (await res.json()) as ErrorBody & {
      error: { details?: { allowedStates?: string[] } };
    };
    expect(payload.error.code).toBe("pincode_state_mismatch");
    expect(payload.error.details?.allowedStates).toContain("07");
    // Nothing was written for the refused key.
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM orders
      WHERE tenant_id = ${tenantA} AND idempotency_key = ${body.idempotencyKey as string}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("B-INT: POST /api/payments/webhook — 401 on bad HMAC, nothing stored", () => {
  it("refuses a tampered signature before any body use and stores no evidence row", async () => {
    const eventId = "evt_mock_bad_" + randomUUID();
    const { rawBody } = mockWebhookBody(WEBHOOK_SECRET_A, {
      type: "payment.captured",
      eventId,
      gatewayOrderId: "order_mock_whatever",
      amountPaise: 49900,
    });

    const wrongSig = await webhookPOST(
      webhookReq(HOST_A, rawBody, {
        "x-razorpay-signature": "0".repeat(64),
        "x-razorpay-event-id": eventId,
      }),
    );
    expect(wrongSig.status).toBe(401);

    const missingSig = await webhookPOST(webhookReq(HOST_A, rawBody, {}));
    expect(missingSig.status).toBe(401);

    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_webhook_events
      WHERE tenant_id = ${tenantA} AND gateway_event_id = ${eventId}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("B-INT: POST /api/payments/webhook — capture, duplicate replay, settlement (D17)", () => {
  let orderId: string;
  let gatewayOrderId: string;
  let amountPaise: number;
  let eventId: string;

  beforeAll(async () => {
    // The full buyer path: cart → checkout (prepaid, gateway hand-off).
    const cookie = await cartForCheckout();
    const res = await checkoutPOST(
      req(HOST_A, "/api/checkout", { method: "POST", cookie, json: checkoutBody() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orderId: string;
      status: string;
      gatewayOrderId: string;
      amountPaise: number;
      orderToken: string;
    };
    expect(body.status).toBe("payment_required");
    orderId = body.orderId;
    gatewayOrderId = body.gatewayOrderId;
    amountPaise = body.amountPaise;
    // The guest token from the response verifies against the lib.
    expect(verifyOrderToken(orderId, body.orderToken)).toBe(true);

    // A correctly-HMAC'd capture, delivered TWICE with the same event id.
    eventId = "evt_mock_dup_" + randomUUID();
    const { rawBody, signature } = mockWebhookBody(WEBHOOK_SECRET_A, {
      type: "payment.captured",
      eventId,
      gatewayOrderId,
      amountPaise,
      method: "upi",
      feePaise: 590,
      feeTaxPaise: 90,
    });
    const headers = { "x-razorpay-signature": signature, "x-razorpay-event-id": eventId };
    const first = await webhookPOST(webhookReq(HOST_A, rawBody, headers));
    expect(first.status).toBe(200);
    const second = await webhookPOST(webhookReq(HOST_A, rawBody, headers));
    expect(second.status).toBe(200);
  });

  it("a duplicate gateway event id replays 200 with ONE confirmation", async () => {
    const [order] = await admin<Record<string, unknown>[]>`
      SELECT status, amount_paid_paise, payment_status FROM orders WHERE id = ${orderId}`;
    expect(order!.status).toBe("confirmed");
    expect(order!.payment_status).toBe("paid");
    expect(Number(order!.amount_paid_paise)).toBe(amountPaise); // once, not twice

    const evidence = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_webhook_events
      WHERE tenant_id = ${tenantA} AND gateway_event_id = ${eventId}`;
    expect(evidence[0]!.n).toBe(1);
    const invoices = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoices WHERE tenant_id = ${tenantA} AND order_id = ${orderId}`;
    expect(invoices[0]!.n).toBe(1);
    const sales = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM stock_movements
      WHERE tenant_id = ${tenantA} AND reason = 'sale'
        AND reference_type = 'checkout' AND reference_id = ${orderId}`;
    expect(sales[0]!.n).toBe(1);
  });

  it("fee_paise / fee_tax_paise from the webhook payload land on the payment row (D17)", async () => {
    const [payment] = await admin<Record<string, unknown>[]>`
      SELECT status, method, fee_paise, fee_tax_paise, gateway_payment_id
      FROM payments WHERE tenant_id = ${tenantA} AND order_id = ${orderId}`;
    expect(payment!.status).toBe("captured");
    expect(payment!.method).toBe("upi");
    expect(Number(payment!.fee_paise)).toBe(590);
    expect(Number(payment!.fee_tax_paise)).toBe(90);
    expect(payment!.gateway_payment_id).toBeTruthy();
  });
});

describe("B-INT: POST /api/payments/webhook — suspended tenant still records evidence", () => {
  it("verifies and stores a delivery for a suspended tenant while buyer routes stay 404", async () => {
    // A webhook is the record-and-refund channel for money the gateway
    // ALREADY captured — suspension must not drop capture evidence. The
    // buyer doors, by contrast, must keep refusing.
    const hostC = `b4-c-${run}.test`;
    const slug = `b4c-${run}`;
    const secret = "storefront-int-webhook-suspended";

    const [tenant] = await admin<{ id: string }[]>`
      INSERT INTO tenants (id, slug, legal_name, display_name, plan_id, status)
      VALUES (${randomUUID()}, ${slug}, ${slug}, ${slug}, ${planId}, 'suspended')
      RETURNING id`;
    suspendedTenant = tenant!.id;
    await admin`
      INSERT INTO domains (id, tenant_id, hostname, is_primary, verified_at)
      VALUES (${randomUUID()}, ${suspendedTenant}, ${hostC}, true, now())`;
    const sealedCredentials = sealCredentials(
      { keyId: "mock_pub_sus", keySecret: "mock_secret_sus" },
      paymentCredentialsAad(suspendedTenant, "mock"),
    );
    const sealedWebhookSecret = sealCredentials(
      { webhookSecret: secret },
      paymentWebhookSecretAad(suspendedTenant, "mock"),
    );
    await admin`
      INSERT INTO payment_accounts
        (id, tenant_id, provider_code, label, public_key_id,
         sealed_credentials, sealed_webhook_secret, credential_fingerprint, is_enabled)
      VALUES (${randomUUID()}, ${suspendedTenant}, 'mock', 'Default', 'mock_pub_sus',
              ${sealedCredentials}, ${sealedWebhookSecret},
              ${credentialFingerprint(sealedCredentials)}, true)`;

    // Buyer door: suspended reads as absent (unchanged behaviour).
    const buyer = await cartGET(req(hostC, "/api/cart"));
    expect(buyer.status).toBe(404);

    // Webhook door: HMAC-verified, evidence row stored, 200 — even with
    // no matching order (test events record with a null order id).
    const eventId = "evt_mock_susp_" + randomUUID();
    const { rawBody, signature } = mockWebhookBody(secret, {
      type: "payment.captured",
      eventId,
      gatewayOrderId: "order_mock_suspended_none",
      amountPaise: 49900,
    });
    const res = await webhookPOST(
      webhookReq(hostC, rawBody, {
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": eventId,
      }),
    );
    expect(res.status).toBe(200);

    const evidence = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_webhook_events
      WHERE tenant_id = ${suspendedTenant} AND gateway_event_id = ${eventId}`;
    expect(evidence[0]!.n).toBe(1);

    // A bad signature on the suspended host is still a 401, nothing stored.
    const badId = "evt_mock_susp_bad_" + randomUUID();
    const bad = await webhookPOST(
      webhookReq(hostC, rawBody, {
        "x-razorpay-signature": "0".repeat(64),
        "x-razorpay-event-id": badId,
      }),
    );
    expect(bad.status).toBe(401);
  });
});

describe("checkout rate limit (unauthenticated door)", () => {
  it("the 6th rapid checkout-start from one client IP is a 429 with Retry-After", async () => {
    // Unique per-run IP: the (tenant, ip) bucket must not inherit state
    // from earlier runs inside the same 60s window.
    const rand = () => Math.floor(Math.random() * 256);
    const client = `10.${rand()}.${rand()}.${rand()}`;
    // Two hops: the FIRST is the bucket key; the appended proxy hop must
    // not split the bucket.
    const xff = { "x-forwarded-for": `${client}, 198.51.100.7` };

    // No cart cookie on purpose: the limiter sits BEFORE body/cookie/DB
    // work, so these consume the bucket and fail cheaply as 404s.
    const shoot = () =>
      checkoutPOST(
        req(HOST_A, "/api/checkout", { method: "POST", json: checkoutBody(), headers: xff }),
      );

    for (let i = 1; i <= 5; i += 1) {
      const res = await shoot();
      expect(res.status, `request ${i} of 5 must not be rate limited`).toBe(404);
    }

    const sixth = await shoot();
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as ErrorBody;
    expect(body.error.code).toBe("rate_limited");
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);

    // A different client IP against the same tenant is its own bucket —
    // the limit throttles a client, not the store.
    const other = await checkoutPOST(
      req(HOST_A, "/api/checkout", {
        method: "POST",
        json: checkoutBody(),
        headers: { "x-forwarded-for": `10.${rand()}.${rand()}.${rand()}` },
      }),
    );
    expect(other.status).toBe(404);
  });
});
