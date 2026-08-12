/**
 * Multi-carrier logistics domain model.
 *
 * The platform must speak to many providers — aggregators like
 * Shiprocket and Shipmozo, and direct carriers like Ekart, Delhivery,
 * Blue Dart and XpressBees — without any of them leaking into order,
 * checkout or console code.
 *
 * Two things make that work, and both live in this file:
 *
 *   1. A NORMALISED vocabulary. Every carrier invents its own status
 *      codes, NDR reasons and weight rules. Translation happens once,
 *      at the adapter boundary, never in business logic.
 *
 *   2. Declared CAPABILITIES. Carriers differ in what they can do —
 *      COD, reverse pickup, QC on return, multi-piece. Asking a carrier
 *      what it supports beats hardcoding `if (carrier === 'delhivery')`.
 */

// ─────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────

/**
 * Aggregators resell many carriers behind one API and do their own
 * carrier assignment; direct carriers do not. The distinction is
 * architectural, not cosmetic: with an aggregator our rate shopping
 * competes with theirs, and the AWB's actual carrier is only known
 * after booking.
 */
export type CarrierKind = "aggregator" | "direct";

// Carrier identity is defined once, in the schema package, so the DB
// CHECK constraint and the adapter registry can never drift apart.
import type { CarrierCode } from "@platform/db";

export { CARRIER_CODES } from "@platform/db";
export type { CarrierCode };

export type Pincode = string;

// ─────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────

export type CarrierCapabilities = {
  kind: CarrierKind;
  cod: boolean;
  prepaid: boolean;
  reversePickup: boolean;
  /** Quality check at doorstep on returns — apparel and electronics need it. */
  qcOnReturn: boolean;
  multiPiece: boolean;
  insurance: boolean;
  /** Can the AWB's COD amount be amended after booking, before pickup? */
  amendCodAmount: boolean;
  sameDay: boolean;
  /** Divisor for volumetric weight in cm³/kg. Commonly 5000; some use 4000. */
  volumetricDivisor: number;
  /** Carriers bill in slabs, not grams. 500 = half-kilo slabs. */
  weightSlabGrams: number;
  /** Does the carrier push webhooks, or must we poll? */
  webhooks: boolean;
};

// ─────────────────────────────────────────────────────────────
// Normalised shipment status
// ─────────────────────────────────────────────────────────────

/**
 * One vocabulary for every carrier. Ordered by progression so that
 * out-of-order events can be rejected — see `isStatusRegression`.
 */
export const SHIPMENT_STATUSES = [
  "created",
  "manifested",
  "pickup_scheduled",
  "pickup_failed",
  "picked_up",
  "in_transit",
  "reached_destination_hub",
  "out_for_delivery",
  "delivery_failed", // NDR — an attempt happened and failed
  "delivered",
  "rto_initiated",
  "rto_in_transit",
  "rto_delivered",
  "cancelled",
  "lost",
  "damaged",
  "on_hold",
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Nothing follows these. Reaching one closes the shipment. */
export const TERMINAL_STATUSES: ReadonlySet<ShipmentStatus> = new Set([
  "delivered",
  "rto_delivered",
  "cancelled",
  "lost",
]);

/**
 * Monotonic rank used to reject stale events.
 *
 * Carriers deliver webhooks out of order routinely — a retried
 * "in_transit" from an hour ago can land after "delivered". Without a
 * rank, that flips a completed order back to in-transit, re-triggers
 * customer notifications, and corrupts the fulfilment funnel.
 *
 * Exceptions (`delivery_failed`, `on_hold`, RTO) are handled in
 * `isStatusRegression` rather than by rank, because they are legitimate
 * backward moves.
 */
export const STATUS_RANK: Record<ShipmentStatus, number> = {
  created: 0,
  manifested: 10,
  pickup_scheduled: 20,
  pickup_failed: 25,
  picked_up: 30,
  in_transit: 40,
  reached_destination_hub: 50,
  out_for_delivery: 60,
  delivery_failed: 65,
  delivered: 100,
  rto_initiated: 70,
  rto_in_transit: 80,
  rto_delivered: 100,
  on_hold: 45,
  damaged: 90,
  cancelled: 100,
  lost: 100,
};

// ─────────────────────────────────────────────────────────────
// NDR — non-delivery reasons
// ─────────────────────────────────────────────────────────────

/**
 * Why a delivery attempt failed. Normalised because NDR handling is
 * where Indian D2C margin is won or lost: the reason decides whether we
 * auto-reattempt, ask the customer to confirm, or cut losses to RTO.
 */
export const NDR_REASONS = [
  "customer_unavailable",
  "customer_refused",
  "address_incorrect",
  "address_incomplete",
  "cod_amount_unavailable",
  "customer_requested_reschedule",
  "out_of_delivery_area",
  "consignee_shifted",
  "premises_closed",
  "payment_mode_dispute",
  "future_delivery_requested",
  "carrier_operational", // vehicle breakdown, strike, weather
  "other",
] as const;

export type NdrReason = (typeof NDR_REASONS)[number];

/** Reasons a reattempt can plausibly fix without customer input. */
export const AUTO_REATTEMPTABLE: ReadonlySet<NdrReason> = new Set([
  "customer_unavailable",
  "premises_closed",
  "carrier_operational",
  "future_delivery_requested",
]);

/** Reasons that need the customer to act before another attempt is worth paying for. */
export const NEEDS_CUSTOMER_ACTION: ReadonlySet<NdrReason> = new Set([
  "address_incorrect",
  "address_incomplete",
  "cod_amount_unavailable",
  "consignee_shifted",
  "payment_mode_dispute",
]);

// ─────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────

export type Dimensions = { lengthMm: number; widthMm: number; heightMm: number };

export type PackageSpec = {
  deadWeightGrams: number;
  dimensions: Dimensions;
  /** Declared value in paise — drives insurance and carrier liability. */
  declaredValuePaise: number;
  pieces: number;
};

export type ServiceabilityRequest = {
  fromPincode: Pincode;
  toPincode: Pincode;
  pkg: PackageSpec;
  paymentMode: "prepaid" | "cod";
  codAmountPaise: number;
};

/**
 * A bookable option. Aggregators return several (one per underlying
 * carrier); direct carriers usually return one per service level.
 */
export type ServiceabilityQuote = {
  carrier: CarrierCode;
  /** For aggregators, the underlying carrier they would assign. */
  subCarrier?: string;
  serviceCode: string; // 'surface' | 'air' | 'express' | vendor-specific
  serviceLabel: string;
  freightPaise: number;
  codFeePaise: number;
  totalPaise: number;
  /** Billable weight after volumetric and slab rounding. */
  billableWeightGrams: number;
  estimatedDays: number;
  /** Carrier's own promise date, when supplied. */
  promisedBy?: Date;
  codSupported: boolean;
  /** 0–1 historical success on this lane. Populated from our own data. */
  performanceScore?: number;
};

export type ShipmentRequest = {
  tenantId: string;
  orderId: string;
  /** Idempotency key. Booking twice means paying twice. */
  idempotencyKey: string;
  quote: ServiceabilityQuote;
  pickup: Address;
  drop: Address;
  pkg: PackageSpec;
  paymentMode: "prepaid" | "cod";
  codAmountPaise: number;
  /** Required on the label for GST-registered consignors. */
  sellerGstin?: string;
  invoiceNumber?: string;
  items: ShipmentItem[];
};

export type ShipmentItem = {
  name: string;
  sku: string;
  quantity: number;
  unitPricePaise: number;
  hsnCode?: string;
};

export type Address = {
  name: string;
  phoneE164: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: Pincode;
  country: string; // ISO-3166 alpha-2
  email?: string;
};

export type BookedShipment = {
  carrier: CarrierCode;
  subCarrier?: string;
  awb: string;
  /** Carrier's own shipment id, needed for later calls. */
  carrierShipmentId: string;
  labelUrl?: string;
  manifestUrl?: string;
  expectedPickupAt?: Date;
  billableWeightGrams: number;
  chargedPaise: number;
};

export type TrackingEvent = {
  awb: string;
  status: ShipmentStatus;
  ndrReason?: NdrReason;
  /** Untranslated carrier text — kept for support and for improving maps. */
  rawStatus: string;
  rawDescription?: string;
  location?: string;
  occurredAt: Date;
  /** Dedupe key: carriers resend the same event freely. */
  signature: string;
};

/**
 * Carriers re-weigh at their hub and bill the difference. Unchallenged
 * discrepancies are one of the largest silent cost leaks in Indian
 * e-commerce, so they are modelled, not absorbed.
 */
export type WeightDispute = {
  awb: string;
  declaredWeightGrams: number;
  carrierWeightGrams: number;
  differencePaise: number;
  carrierImageUrls: string[];
  raisedAt: Date;
};

// ─────────────────────────────────────────────────────────────
// The adapter contract
// ─────────────────────────────────────────────────────────────

export class CarrierError extends Error {
  readonly carrier: CarrierCode;
  readonly retryable: boolean;
  readonly carrierCode?: string;

  constructor(opts: {
    carrier: CarrierCode;
    message: string;
    retryable: boolean;
    carrierCode?: string;
  }) {
    super(`[${opts.carrier}] ${opts.message}`);
    this.name = "CarrierError";
    this.carrier = opts.carrier;
    this.retryable = opts.retryable;
    this.carrierCode = opts.carrierCode;
  }
}

export class CarrierNotConfiguredError extends CarrierError {
  constructor(carrier: CarrierCode, detail: string) {
    super({ carrier, message: detail, retryable: false });
    this.name = "CarrierNotConfiguredError";
  }
}

/**
 * Every carrier integration implements exactly this.
 *
 * Adding a provider must never require touching order, checkout or
 * console code — which is also what lets a Phase B merchant arrive with
 * their own existing courier account and keep using it.
 */
export interface CarrierAdapter {
  readonly code: CarrierCode;
  readonly displayName: string;
  readonly capabilities: CarrierCapabilities;

  /** Verify stored credentials without booking anything. */
  verifyCredentials(creds: unknown): Promise<{ ok: boolean; detail?: string }>;

  checkServiceability(
    creds: unknown,
    req: ServiceabilityRequest,
  ): Promise<ServiceabilityQuote[]>;

  createShipment(creds: unknown, req: ShipmentRequest): Promise<BookedShipment>;

  cancelShipment(creds: unknown, awb: string): Promise<void>;

  schedulePickup(
    creds: unknown,
    awbs: string[],
    pickupDate: Date,
  ): Promise<{ pickupId: string }>;

  track(creds: unknown, awb: string): Promise<TrackingEvent[]>;

  /** Amend the COD amount before pickup. Throws if unsupported. */
  updateCodAmount?(creds: unknown, awb: string, amountPaise: number): Promise<void>;

  createReturn?(creds: unknown, req: ShipmentRequest): Promise<BookedShipment>;

  /**
   * Verify and parse an inbound webhook. Signature verification lives
   * here because each carrier signs differently — and a tracking
   * webhook that is not verified is an unauthenticated write path into
   * order state.
   */
  parseWebhook(
    creds: unknown,
    raw: unknown,
    headers: Record<string, string | undefined>,
  ): Promise<TrackingEvent[]>;
}
