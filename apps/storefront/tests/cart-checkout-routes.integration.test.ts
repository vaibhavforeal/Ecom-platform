import { randomUUID } from "node:crypto";

import { closeRedis } from "@platform/core";
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

const { GET: cartGET, POST: cartPOST } = await import("../src/app/api/cart/route");
const { POST: couponPOST, DELETE: couponDELETE } = await import(
  "../src/app/api/cart/coupon/route"
);
const { POST: serviceabilityPOST } = await import(
  "../src/app/api/checkout/serviceability/route"
);
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
  init: { method?: string; cookie?: string; json?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "x-forwarded-host": host };
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
});

afterAll(async () => {
  // Restore env mutations BEFORE closing pools (worker-suite lesson).
  if (!hadSessionSecret) delete process.env.SESSION_SECRET;
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
 * §9 matrix rows owned by lot B-INT — they exercise routes B4 does not
 * own (POST /api/checkout, POST /api/payments/webhook). Declared here so
 * the suite's scope is auditable against the matrix.
 */
describe.todo("B-INT: POST /api/checkout — pincode_state_mismatch (D3) with allowed states in details");
describe.todo("B-INT: POST /api/payments/webhook — 401 on bad HMAC, nothing stored");
describe.todo("B-INT: POST /api/payments/webhook — duplicate gateway event id replays 200, one confirmation");
describe.todo("B-INT: fee_paise / fee_tax_paise from the webhook payload land on the payment row (D17)");
