import { CarrierError } from "@platform/core";
import type { ServiceabilityRequest, ShipmentRequest } from "@platform/core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  availableCarriers,
  carriersByKind,
  ekart,
  fake,
  getCarrier,
  resetFakeCarrier,
  shiprocket,
} from "../src/carriers/index";

const CREDS = { apiKey: "test" };

const PKG = {
  deadWeightGrams: 400,
  dimensions: { lengthMm: 300, widthMm: 200, heightMm: 100 },
  declaredValuePaise: 199_900,
  pieces: 1,
};

const SERVICEABILITY: ServiceabilityRequest = {
  fromPincode: "560001",
  toPincode: "110001",
  pkg: PKG,
  paymentMode: "cod",
  codAmountPaise: 199_900,
};

const ADDRESS = {
  name: "Test Customer",
  phoneE164: "+919876543210",
  line1: "1 Test Street",
  city: "New Delhi",
  state: "Delhi",
  pincode: "110001",
  country: "IN",
};

beforeEach(() => resetFakeCarrier());

describe("registry", () => {
  it("resolves every declared carrier", () => {
    for (const code of ["shiprocket", "ekart", "delhivery", "bluedart", "xpressbees"] as const) {
      expect(getCarrier(code).code).toBe(code);
    }
  });

  it("separates aggregators from direct carriers", () => {
    expect(carriersByKind("aggregator").map((c) => c.code)).toContain("shiprocket");
    expect(carriersByKind("direct").map((c) => c.code)).toContain("ekart");
    expect(carriersByKind("aggregator").map((c) => c.code)).not.toContain("ekart");
  });

  it("hides the in-memory test carrier in production", () => {
    // A production merchant selecting a carrier that silently swallows
    // parcels would be a very bad day.
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(availableCarriers().map((c) => c.code)).not.toContain("fake");
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("declares capabilities every carrier can be asked about", () => {
    for (const carrier of availableCarriers()) {
      expect(carrier.capabilities.volumetricDivisor).toBeGreaterThan(0);
      expect(carrier.capabilities.weightSlabGrams).toBeGreaterThan(0);
      expect(["aggregator", "direct"]).toContain(carrier.capabilities.kind);
      expect(carrier.setupNotes.length).toBeGreaterThan(20);
    }
  });
});

describe("unwired adapters", () => {
  it("fail loudly rather than pretending to succeed", async () => {
    // A stub that returned a fake AWB would mark an order shipped with
    // no parcel behind it — far worse than an error.
    await expect(ekart.createShipment({}, {} as ShipmentRequest)).rejects.toThrow(CarrierError);
    await expect(ekart.checkServiceability({}, SERVICEABILITY)).rejects.toThrow(/not wired up/i);
  });

  it("marks integration errors as non-retryable", async () => {
    await ekart.checkServiceability({}, SERVICEABILITY).catch((err: CarrierError) => {
      expect(err.retryable).toBe(false);
      expect(err.carrier).toBe("ekart");
    });
  });

  it("validates credential shape before any network call", async () => {
    const bad = await shiprocket.verifyCredentials({ nope: true });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/shape/i);

    const wellFormed = await shiprocket.verifyCredentials({
      email: "merchant@example.com",
      password: "secret",
    });
    // Shape is fine; live verification is what is still pending.
    expect(wellFormed.ok).toBe(false);
    expect(wellFormed.detail).toMatch(/pending/i);
  });
});

describe("fake carrier — reference implementation", () => {
  it("quotes surface and air, priced on billable weight", async () => {
    const quotes = await fake.checkServiceability(CREDS, SERVICEABILITY);
    expect(quotes).toHaveLength(2);

    // 30×20×10cm at divisor 5000 = 1.2kg volumetric, slabbed to 1.5kg —
    // well above the 400g dead weight.
    expect(quotes[0]!.billableWeightGrams).toBe(1500);
    expect(quotes.find((q) => q.serviceCode === "air")!.estimatedDays).toBeLessThan(
      quotes.find((q) => q.serviceCode === "surface")!.estimatedDays,
    );
  });

  it("returns no quotes for an unserviceable pincode", async () => {
    const quotes = await fake.checkServiceability(
      { ...CREDS, unserviceablePincodes: ["110001"] },
      SERVICEABILITY,
    );
    expect(quotes).toEqual([]);
  });

  it("books a shipment and starts its tracking history", async () => {
    const [quote] = await fake.checkServiceability(CREDS, SERVICEABILITY);
    const booked = await fake.createShipment(CREDS, {
      tenantId: "t1",
      orderId: "o1",
      idempotencyKey: "order-o1-attempt-1",
      quote: quote!,
      pickup: { ...ADDRESS, pincode: "560001", city: "Bengaluru", state: "Karnataka" },
      drop: ADDRESS,
      pkg: PKG,
      paymentMode: "cod",
      codAmountPaise: 199_900,
      items: [{ name: "Thing", sku: "SKU1", quantity: 1, unitPricePaise: 199_900 }],
    });

    expect(booked.awb).toMatch(/^FAKE\d{10}$/);
    const events = await fake.track(CREDS, booked.awb);
    expect(events[0]!.status).toBe("manifested");
  });

  it("is idempotent — a retried booking does not book twice", async () => {
    const [quote] = await fake.checkServiceability(CREDS, SERVICEABILITY);
    const req: ShipmentRequest = {
      tenantId: "t1",
      orderId: "o1",
      idempotencyKey: "order-o1-attempt-1",
      quote: quote!,
      pickup: ADDRESS,
      drop: ADDRESS,
      pkg: PKG,
      paymentMode: "prepaid",
      codAmountPaise: 0,
      items: [],
    };

    // The realistic scenario: the first call times out after the carrier
    // already created the shipment, and the worker retries. Booking
    // twice means two AWBs and two freight charges for one parcel.
    const first = await fake.createShipment(CREDS, req);
    const retry = await fake.createShipment(CREDS, req);
    expect(retry.awb).toBe(first.awb);
  });

  it("normalises webhook payloads into tracking events", async () => {
    const [quote] = await fake.checkServiceability(CREDS, SERVICEABILITY);
    const booked = await fake.createShipment(CREDS, {
      tenantId: "t1",
      orderId: "o1",
      idempotencyKey: "k",
      quote: quote!,
      pickup: ADDRESS,
      drop: ADDRESS,
      pkg: PKG,
      paymentMode: "prepaid",
      codAmountPaise: 0,
      items: [],
    });

    const events = await fake.parseWebhook(
      CREDS,
      {
        awb: booked.awb,
        status: "Undelivered - Customer Not Available",
        occurredAt: "2026-02-01T09:30:00Z",
        location: "New Delhi Hub",
      },
      {},
    );

    expect(events[0]!.status).toBe("delivery_failed");
    expect(events[0]!.ndrReason).toBe("customer_unavailable");
    // The carrier's own words are retained for support and for
    // improving the status map later.
    expect(events[0]!.rawStatus).toBe("Undelivered - Customer Not Available");
  });

  it("amends the COD amount before pickup", async () => {
    const [quote] = await fake.checkServiceability(CREDS, SERVICEABILITY);
    const booked = await fake.createShipment(CREDS, {
      tenantId: "t1",
      orderId: "o1",
      idempotencyKey: "k",
      quote: quote!,
      pickup: ADDRESS,
      drop: ADDRESS,
      pkg: PKG,
      paymentMode: "cod",
      codAmountPaise: 199_900,
      items: [],
    });

    // Applying a discount after booking must move the AWB amount too,
    // or the courier collects the wrong sum at the door.
    expect(fake.capabilities.amendCodAmount).toBe(true);
    await fake.updateCodAmount!(CREDS, booked.awb, 149_900);
  });
});
