import { createHmac } from "node:crypto";

import { Queue } from "bullmq";

import {
  and,
  asc,
  carts,
  cartLines,
  couponRedemptions,
  desc,
  eq,
  inArray,
  isNull,
  orderCounters,
  orderEvents,
  orderLines,
  orders,
  payments,
  productCategories,
  products,
  productVariants,
  promotions,
  sql,
  storeSettings,
  tenants,
  withPlatform,
  withTenant,
} from "@platform/db";
import type {
  CheckoutPaymentMode,
  OrderStatus,
  PaymentProviderCode,
  TaxRegistrationType,
  Tx,
} from "@platform/db";

import { recordAudit } from "../audit/index";
import type { WriteContext } from "../catalog/writes";
import { catalogPurgeTags } from "../catalog/cache-tags";
import { purgeStorefrontCache } from "../catalog/purge";
import type { BuyerContext } from "../cart/index";
import { AppError } from "../errors";
import {
  ConsumeShortfallError,
  InsufficientAvailabilityError,
  StockHeldError,
  consumeStockWithin,
  getAvailability,
  holdStock,
  releaseStock,
  restockWithin,
} from "../inventory/server";
import type { HoldLineInput } from "../inventory/index";
import { INVOICE_PREFIX_KEY } from "../invoices/index";
import type { InvoiceBuyer, InvoiceDocLine, InvoiceSeller } from "../invoices/index";
import { createInvoice } from "../invoices/server";
import type { OrderEventName } from "../orders/index";
import { enqueueOrderEvent, transitionOrder } from "../orders/server";
import type { OrderActorContext, OrderEventDescriptor } from "../orders/server";
import { PAYMENT_SETTINGS_KEYS, computeAdvanceSplit } from "../payments/index";
import type { AdvancePolicy, GatewayEvent, PaymentGatewayAdapter } from "../payments/index";
import {
  createRefundIntent,
  getEnabledAccount,
  insertPayment,
  markPaymentCaptured,
  markPaymentFailed,
  markRefundProcessed,
  unsealGatewayCredentials,
} from "../payments/server";
import type { EnabledPaymentAccount } from "../payments/server";
import { applyDiscountToLines, evaluatePromotion } from "../promotions/index";
import type { PromotionData } from "../promotions/index";
import {
  claimRedemption,
  countPendingClaims,
  countRedemptions,
  loadActivePromotionForUpdate,
} from "../promotions/server";
import { markFirstOrder, upsertCustomerByPhone } from "../customers/server";
import { QUEUE_NAMES, defaultJobOptions } from "../queues";
import { redis } from "../redis";
import { SHIPPING_SETTINGS_KEYS, computeShippingFeePaise, statesForPincode } from "../serviceability/index";
import { checkServiceability } from "../serviceability/server";
import { computeLineTaxes, docTypeFor } from "../tax/index";
import type { TaxableLine } from "../tax/index";
import { checkoutPayloadSchema, computeCheckoutFingerprint } from "./index";
import type { CheckoutPayload, CheckoutStartResponse } from "./index";

/**
 * Checkout orchestration — SERVER barrel. S0 SCHEMA SPINE: signatures
 * FROZEN; bodies implemented by lot B-INT.
 *
 * This is the ONLY module allowed to import multiple `/server` barrels
 * (cart, orders, payments, promotions, invoices, customers, inventory).
 * Transaction boundaries are pinned in PHASE2_COMMERCE_DESIGN.md §4;
 * the imperative traps: handle BOTH `insufficient_stock` and
 * `stock_held` from consumeStockWithin identically (D2a); consume from
 * ORDER lines, never hold rows; invoice allocation only inside the
 * confirming tx (COD counts, D5); enqueue + purge AFTER commit,
 * fail-soft.
 */

/** pending_payment TTL written onto the order (§4.2). */
const CHECKOUT_EXPIRY_MINUTES = 25;
/** The delayed expire job fires after the TTL plus slack (§4.2.7, ≈30 min). */
const EXPIRE_JOB_SLACK_MS = 5 * 60_000;

// ─────────────────────────────────────────────────────────────────────
// Gateway adapter seam (D4). @platform/integrations depends on this
// package, so core cannot import the registry — the storefront checkout
// route (and tests) inject it at module load. Only startCheckout's
// prepaid branch needs it; webhooks arrive pre-verified and refunds run
// from the worker, which imports the registry directly.
// ─────────────────────────────────────────────────────────────────────

export type GatewayAdapterResolver = (code: PaymentProviderCode) => PaymentGatewayAdapter;

let gatewayAdapterResolver: GatewayAdapterResolver | null = null;

/** Additive B-INT export — not part of the frozen S0 surface. */
export function setGatewayAdapterResolver(resolver: GatewayAdapterResolver): void {
  gatewayAdapterResolver = resolver;
}

function resolveAdapter(code: PaymentProviderCode): PaymentGatewayAdapter {
  if (!gatewayAdapterResolver) {
    throw new AppError({
      code: "gateway_unavailable",
      message:
        "No gateway adapter resolver injected — the checkout route must call setGatewayAdapterResolver at module load",
      status: 500,
      publicMessage: "Online payment is not available right now. Please try again.",
    });
  }
  return gatewayAdapterResolver(code);
}

// ─────────────────────────────────────────────────────────────────────
// Guest order token. SAME derivation as apps/storefront/src/lib/
// order-token.ts (context "order-status", HMAC-SHA256 under
// SESSION_SECRET, base64url): core cannot import app code, so the
// derivation is duplicated VERBATIM — change both or neither.
// ─────────────────────────────────────────────────────────────────────

const ORDER_TOKEN_CONTEXT = "order-status";

function signOrderToken(orderId: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET must be set to sign order tokens");
  return createHmac("sha256", secret)
    .update(`${ORDER_TOKEN_CONTEXT}:${orderId}`)
    .digest("base64url");
}

// ─────────────────────────────────────────────────────────────────────
// Queues (lazy — never at module scope; the orders/server lesson).
// ─────────────────────────────────────────────────────────────────────

type ExpireJobPayload = { tenantId: string; orderId: string };
type RefundJobPayload = { tenantId: string; refundId: string };

let ordersQueue: Queue<ExpireJobPayload> | undefined;
let paymentsQueue: Queue<RefundJobPayload> | undefined;

function getOrdersQueue(): Queue<ExpireJobPayload> {
  ordersQueue ??= new Queue<ExpireJobPayload>(QUEUE_NAMES.orders, {
    connection: redis(),
    defaultJobOptions,
  });
  return ordersQueue;
}

function getPaymentsQueue(): Queue<RefundJobPayload> {
  paymentsQueue ??= new Queue<RefundJobPayload>(QUEUE_NAMES.payments, {
    connection: redis(),
    defaultJobOptions,
  });
  return paymentsQueue;
}

function logSoftFailure(what: string, tenantId: string, err: unknown): void {
  console.error(
    JSON.stringify({ level: "error", message: `${what} enqueue failed`, tenantId, error: String(err) }),
  );
}

/**
 * Delayed per-order expiry (D10 precision driver). Fail-soft: the
 * scheduled sweep is the backstop. jobId carries the expiry instant so a
 * replay that EXTENDS expires_at enqueues a fresh job instead of being
 * deduped against the stale one.
 */
async function enqueueExpireJob(tenantId: string, orderId: string, expiresAt: Date): Promise<void> {
  try {
    const delay = Math.max(expiresAt.getTime() - Date.now(), 0) + EXPIRE_JOB_SLACK_MS;
    await getOrdersQueue().add(
      "checkout.expire",
      { tenantId, orderId },
      // BullMQ rejects custom job ids containing ":" — separators are "-".
      { delay, jobId: `checkout-expire-${orderId}-${expiresAt.getTime()}` },
    );
  } catch (err) {
    logSoftFailure("checkout.expire", tenantId, err);
  }
}

/** Outbound refund work rides the payments queue (never a web request). Fail-soft. */
async function enqueueRefundJob(tenantId: string, refundId: string): Promise<void> {
  try {
    await getPaymentsQueue().add(
      "payments.refund",
      { tenantId, refundId },
      { jobId: `refund-${refundId}` },
    );
  } catch (err) {
    logSoftFailure("payments.refund", tenantId, err);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────

function refuse(
  code: string,
  status: number,
  message: string,
  publicMessage: string,
  details?: unknown,
): never {
  throw new AppError({ code, message, status, publicMessage, details });
}

/** Walks err.cause chains for the root Postgres error code / text. */
function pgError(err: unknown): { code?: string; text: string } {
  let code: string | undefined;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (!code && typeof c === "string") code = c;
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return { code, text: parts.join(" ⇐ ") };
}

/** order_events row WITHOUT a status transition (payment.*, promotion.*, order.refunded). */
async function insertOrderEvent(
  tx: Tx,
  actor: OrderActorContext,
  orderId: string,
  name: OrderEventName,
  data?: Record<string, unknown>,
): Promise<OrderEventDescriptor> {
  const [row] = await tx
    .insert(orderEvents)
    .values({
      tenantId: actor.tenantId,
      orderId,
      event: name,
      fromStatus: null,
      toStatus: null,
      actorType: actor.actorType,
      actorUserId: actor.actorUserId ?? null,
      data: data ?? null,
      requestId: actor.requestId ?? null,
    })
    .returning({ id: orderEvents.id, createdAt: orderEvents.createdAt });
  return {
    orderEventId: row!.id,
    tenantId: actor.tenantId,
    orderId,
    event: name,
    occurredAt: row!.createdAt.toISOString(),
    requestId: actor.requestId ?? null,
    ...(data === undefined ? {} : { data }),
  };
}

type SellerIdentity = {
  legalName: string;
  gstin: string | null;
  originStateCode: string | null;
  taxRegistrationType: TaxRegistrationType;
};

/** Control-plane read — tenants carries the tax identity (§6.1 TaxContext). */
async function loadSellerIdentity(tenantId: string): Promise<SellerIdentity> {
  const [row] = await withPlatform((tx) =>
    tx
      .select({
        legalName: tenants.legalName,
        gstin: tenants.gstin,
        originStateCode: tenants.originStateCode,
        taxRegistrationType: tenants.taxRegistrationType,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  );
  if (!row) throw new Error(`Tenant ${tenantId} not found while loading seller identity`);
  return row;
}

/** store_settings key for the seller address block on invoices (§8). */
const SELLER_ADDRESS_KEY = "invoicing.seller_address";

type CheckoutSettings = {
  advancePolicy: AdvancePolicy;
  flatFeePaise: number;
  freeAbovePaise: number | null;
  invoicePrefix: string | null;
  sellerAddress: string;
};

async function readCheckoutSettings(tenantId: string): Promise<CheckoutSettings> {
  const keys = [
    PAYMENT_SETTINGS_KEYS.codEnabled,
    PAYMENT_SETTINGS_KEYS.advanceBps,
    PAYMENT_SETTINGS_KEYS.minAdvancePaise,
    SHIPPING_SETTINGS_KEYS.flatFeePaise,
    SHIPPING_SETTINGS_KEYS.freeAbovePaise,
    INVOICE_PREFIX_KEY,
    SELLER_ADDRESS_KEY,
  ];
  const values = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ key: storeSettings.key, value: storeSettings.value })
      .from(storeSettings)
      .where(and(eq(storeSettings.tenantId, tenantId), inArray(storeSettings.key, keys)));
    return new Map<string, unknown>(rows.map((r) => [r.key, r.value]));
  });

  const intOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

  return {
    advancePolicy: {
      // COD defaults ON: a fresh store with no gateway must be able to
      // sell (D5 is the zero-gateway checkout); merchants opt OUT by
      // setting payments.cod_enabled = false.
      codEnabled: values.get(PAYMENT_SETTINGS_KEYS.codEnabled) !== false,
      advanceBps: intOrNull(values.get(PAYMENT_SETTINGS_KEYS.advanceBps)),
      minAdvancePaise: intOrNull(values.get(PAYMENT_SETTINGS_KEYS.minAdvancePaise)) ?? 0,
    },
    flatFeePaise: intOrNull(values.get(SHIPPING_SETTINGS_KEYS.flatFeePaise)) ?? 0,
    freeAbovePaise: intOrNull(values.get(SHIPPING_SETTINGS_KEYS.freeAbovePaise)),
    invoicePrefix:
      typeof values.get(INVOICE_PREFIX_KEY) === "string" &&
      (values.get(INVOICE_PREFIX_KEY) as string).trim()
        ? (values.get(INVOICE_PREFIX_KEY) as string).trim()
        : null,
    sellerAddress:
      typeof values.get(SELLER_ADDRESS_KEY) === "string"
        ? (values.get(SELLER_ADDRESS_KEY) as string)
        : "",
  };
}

/** The normalized, trusted form of the checkout payload. */
type CleanCheckout = {
  idempotencyKey: string;
  buyerName: string;
  phone: string;
  email: string | null;
  line1: string;
  line2: string | null;
  city: string;
  stateCode: string;
  pincode: string;
  buyerGstin: string | null;
  couponCode: string | null;
  paymentMode: CheckoutPaymentMode;
};

function normalizePayload(payload: CheckoutPayload): CleanCheckout {
  const parsed = checkoutPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    refuse(
      "invalid_payload",
      422,
      `Checkout payload invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      "Some fields need attention.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "body",
          message: issue.message,
        })),
      },
    );
  }
  const p = parsed.data;
  return {
    idempotencyKey: p.idempotencyKey,
    buyerName: p.buyerName,
    phone: p.phone,
    email: p.email?.trim() || null,
    line1: p.shippingAddress.line1,
    line2: p.shippingAddress.line2?.trim() || null,
    city: p.shippingAddress.city,
    stateCode: p.shippingAddress.stateCode.trim().toUpperCase(),
    pincode: p.shippingAddress.pincode,
    buyerGstin: p.buyerGstin?.trim() || null,
    couponCode: p.couponCode?.trim().toUpperCase() || null,
    paymentMode: p.paymentMode,
  };
}

type OrderRow = {
  id: string;
  cartId: string | null;
  customerId: string | null;
  orderNumber: number;
  status: OrderStatus;
  paymentMode: CheckoutPaymentMode;
  paymentStatus: string;
  buyerName: string;
  buyerPhoneE164: string;
  buyerEmail: string | null;
  buyerGstin: string | null;
  shippingAddress: unknown;
  placeOfSupply: string;
  promotionId: string | null;
  couponCodeSnapshot: string | null;
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  totalPaise: number;
  amountPaidPaise: number;
  codDuePaise: number;
  checkoutFingerprint: string | null;
  gatewayOrderRef: string | null;
  expiresAt: Date | null;
};

const ORDER_COLUMNS = {
  id: orders.id,
  cartId: orders.cartId,
  customerId: orders.customerId,
  orderNumber: orders.orderNumber,
  status: orders.status,
  paymentMode: orders.paymentMode,
  paymentStatus: orders.paymentStatus,
  buyerName: orders.buyerName,
  buyerPhoneE164: orders.buyerPhoneE164,
  buyerEmail: orders.buyerEmail,
  buyerGstin: orders.buyerGstin,
  shippingAddress: orders.shippingAddress,
  placeOfSupply: orders.placeOfSupply,
  promotionId: orders.promotionId,
  couponCodeSnapshot: orders.couponCodeSnapshot,
  subtotalPaise: orders.subtotalPaise,
  discountPaise: orders.discountPaise,
  shippingPaise: orders.shippingPaise,
  taxPaise: orders.taxPaise,
  totalPaise: orders.totalPaise,
  amountPaidPaise: orders.amountPaidPaise,
  codDuePaise: orders.codDuePaise,
  checkoutFingerprint: orders.checkoutFingerprint,
  gatewayOrderRef: orders.gatewayOrderRef,
  expiresAt: orders.expiresAt,
} as const;

async function lockOrder(tx: Tx, tenantId: string, orderId: string): Promise<OrderRow | null> {
  const [row] = await tx
    .select(ORDER_COLUMNS)
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

type OrderLineRow = {
  id: string;
  kind: "item" | "shipping";
  variantId: string | null;
  titleSnapshot: string;
  skuSnapshot: string;
  hsnSnapshot: string | null;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  position: number;
};

async function loadOrderLines(tx: Tx, tenantId: string, orderId: string): Promise<OrderLineRow[]> {
  return tx
    .select({
      id: orderLines.id,
      kind: orderLines.kind,
      variantId: orderLines.variantId,
      titleSnapshot: orderLines.titleSnapshot,
      skuSnapshot: orderLines.skuSnapshot,
      hsnSnapshot: orderLines.hsnSnapshot,
      quantity: orderLines.quantity,
      unitPricePaise: orderLines.unitPricePaise,
      discountPaise: orderLines.discountPaise,
      taxablePaise: orderLines.taxablePaise,
      taxRateBps: orderLines.taxRateBps,
      cgstPaise: orderLines.cgstPaise,
      sgstPaise: orderLines.sgstPaise,
      igstPaise: orderLines.igstPaise,
      taxPaise: orderLines.taxPaise,
      totalPaise: orderLines.totalPaise,
      position: orderLines.position,
    })
    .from(orderLines)
    .where(and(eq(orderLines.tenantId, tenantId), eq(orderLines.orderId, orderId)))
    .orderBy(asc(orderLines.position), asc(orderLines.id));
}

/** Consumable hold lines from ORDER lines — the order is the authority (D2a). */
function holdLinesOf(lines: OrderLineRow[]): HoldLineInput[] {
  return lines
    .filter((l) => l.kind === "item" && l.variantId !== null)
    .map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));
}

function parseOrderAddress(raw: unknown): {
  line1: string;
  line2: string | null;
  city: string;
  stateCode: string;
  pincode: string;
} {
  const a = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    line1: str(a.line1),
    line2: typeof a.line2 === "string" ? a.line2 : null,
    city: str(a.city),
    stateCode: str(a.state_code),
    pincode: str(a.pincode),
  };
}

// ─────────────────────────────────────────────────────────────────────
// §4.2 — startCheckout
// ─────────────────────────────────────────────────────────────────────

/**
 * §4.2: idempotency fast path (fingerprint replay / 422
 * idempotency_key_reuse) → serviceability + pincode/state cross-check →
 * TX-A order creation (snapshot, order_number, coupon FOR UPDATE
 * advisory, customer upsert, order.placed) → holdStock (own TX, existing
 * entry point) → COD confirm or gateway hand-off (the D4 written
 * deviation: createGatewayOrder is synchronous in the request) → delayed
 * checkout.expire enqueue.
 */
export async function startCheckout(
  ctx: BuyerContext,
  cartId: string,
  payload: CheckoutPayload,
): Promise<CheckoutStartResponse> {
  const clean = normalizePayload(payload);

  // D3: never trust the typed state for the CGST/SGST-vs-IGST fork.
  // Unknown prefix → [] → fail-open on the cross-check only.
  const allowedStates = statesForPincode(clean.pincode);
  if (allowedStates.length > 0 && !allowedStates.includes(clean.stateCode)) {
    refuse(
      "pincode_state_mismatch",
      422,
      `Pincode ${clean.pincode} is not in state ${clean.stateCode} (allowed: ${allowedStates.join(",")})`,
      "That pincode does not match the selected state. Please check both.",
      {
        allowedStates,
        issues: [{ path: "shippingAddress.stateCode", message: "State does not match the pincode." }],
      },
    );
  }

  const settings = await readCheckoutSettings(ctx.tenantId);
  // Cheap mode refusals before anything is written (§4.2.1):
  // computeAdvanceSplit throws the typed 422s for disabled COD /
  // unconfigured advance; the amounts are recomputed with the real total
  // inside TX-A.
  if (clean.paymentMode !== "prepaid") {
    computeAdvanceSplit(0, settings.advancePolicy, clean.paymentMode);
  }

  // Idempotency fast path (D1a).
  const existing = await withTenant(ctx.tenantId, async (tx) => {
    const [row] = await tx
      .select(ORDER_COLUMNS)
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.idempotencyKey, clean.idempotencyKey)))
      .limit(1);
    return row ?? null;
  });
  if (existing) return replayCheckout(ctx, existing, clean);

  // Serviceability (non-tx read; §4.2.3).
  const service = await checkServiceability(ctx, {
    pincode: clean.pincode,
    paymentMode: clean.paymentMode,
  });
  if (!service.serviceable) {
    refuse(
      "pincode_unserviceable",
      422,
      `Pincode ${clean.pincode} refused by the ${service.mode} policy`,
      "Delivery is not available to this pincode.",
      { issues: [{ path: "shippingAddress.pincode", message: "Delivery is not available here." }] },
    );
  }

  // Gateway modes need an enabled account before an order is created —
  // failing after would strand a pending order until expiry. (Known
  // narrow consequence: a 100%-off prepaid checkout on a store with no
  // gateway is refused here rather than confirmed; pick COD instead.)
  let account: EnabledPaymentAccount | null = null;
  if (clean.paymentMode !== "cod") {
    account = await withTenant(ctx.tenantId, (tx) => getEnabledAccount(tx, ctx.tenantId));
    if (!account) {
      refuse(
        "payments_not_configured",
        422,
        "No enabled payment account for a gateway checkout",
        "Online payment is not available on this store yet.",
        { issues: [{ path: "paymentMode", message: "Online payment is not available." }] },
      );
    }
  }

  const seller = await loadSellerIdentity(ctx.tenantId);

  // [TX-A] — order creation.
  let created: Awaited<ReturnType<typeof createOrderTx>>;
  try {
    created = await createOrderTx(ctx, cartId, clean, seller, settings);
  } catch (err) {
    if (err instanceof AppError && err.code === "cart_not_active") {
      // A concurrent same-key POST can convert the cart between our
      // fast-path miss and the cart lock — if OUR order exists now,
      // this is a replay, not a refusal.
      const winner = await withTenant(ctx.tenantId, async (tx) => {
        const [row] = await tx
          .select(ORDER_COLUMNS)
          .from(orders)
          .where(
            and(eq(orders.tenantId, ctx.tenantId), eq(orders.idempotencyKey, clean.idempotencyKey)),
          )
          .limit(1);
        return row ?? null;
      });
      if (winner) return replayCheckout(ctx, winner, clean);
      throw err;
    }
    const pg = pgError(err);
    if (pg.code === "23505" && pg.text.includes("orders_idem_key")) {
      // Concurrent double-POST: replay the winner (§4.2.4).
      const winner = await withTenant(ctx.tenantId, async (tx) => {
        const [row] = await tx
          .select(ORDER_COLUMNS)
          .from(orders)
          .where(
            and(eq(orders.tenantId, ctx.tenantId), eq(orders.idempotencyKey, clean.idempotencyKey)),
          )
          .limit(1);
        return row ?? null;
      });
      if (winner) return replayCheckout(ctx, winner, clean);
    }
    if (pg.code === "23505" && pg.text.includes("orders_tenant_cart_pending_key")) {
      // The belt: another pending order (different key) already claims
      // this cart.
      refuse(
        "concurrent_modification",
        409,
        "Another pending order already claims this cart",
        "This cart is already being checked out. Please retry in a moment.",
      );
    }
    throw err;
  }

  await enqueueOrderEvent(created.placedEvent);

  // [TX-B] — holds, through the existing entry point, its own tx.
  try {
    await holdStock(
      { tenantId: ctx.tenantId, requestId: ctx.requestId ?? null },
      { reference: { type: "checkout", id: created.orderId }, lines: created.holdLines },
    );
  } catch (err) {
    if (err instanceof InsufficientAvailabilityError) {
      // [TX-C] — cancel; the cancelled row leaves the cart-pending index
      // so the buyer's retry on the SAME cart mints a fresh order (D1a).
      await cancelPendingOrder(ctx, created.orderId, "hold_failed", {
        name: "order.hold_failed",
        data: { failedLines: err.failedLines },
      });
      throw err;
    }
    throw err;
  }

  // §4.2.6 — branch on mode. Zero-total orders confirm through the same
  // door with the gateway skipped entirely (D5).
  if (clean.paymentMode === "cod" || created.totalPaise === 0) {
    await confirmCodOrder(ctx, created.orderId);
    return { orderId: created.orderId, orderToken: signOrderToken(created.orderId), status: "confirmed" };
  }

  // Expiry BEFORE the gateway call: a gateway failure must still leave
  // the pending order reaped (D10).
  await enqueueExpireJob(ctx.tenantId, created.orderId, created.expiresAt);

  return startGatewayPayment(ctx, {
    orderId: created.orderId,
    account: account!,
    amountPaise: created.advancePaise,
  });
}

type CreatedOrder = {
  orderId: string;
  orderNumber: number;
  totalPaise: number;
  advancePaise: number;
  codDuePaise: number;
  holdLines: HoldLineInput[];
  placedEvent: OrderEventDescriptor;
  expiresAt: Date;
};

async function createOrderTx(
  ctx: BuyerContext,
  cartId: string,
  clean: CleanCheckout,
  seller: SellerIdentity,
  settings: CheckoutSettings,
): Promise<CreatedOrder> {
  return withTenant(ctx.tenantId, async (tx) => {
    // Cart FOR UPDATE — serializes double-submits on the same cart ahead
    // of the belt index.
    const [cart] = await tx
      .select({ id: carts.id, status: carts.status, currency: carts.currency })
      .from(carts)
      .where(and(eq(carts.tenantId, ctx.tenantId), eq(carts.id, cartId)))
      .limit(1)
      .for("update");
    if (!cart) {
      refuse("not_found", 404, `Cart ${cartId} not found in this tenant`, "That cart does not exist.");
    }
    if (cart.status !== "active") {
      refuse(
        "cart_not_active",
        422,
        `Cart ${cartId} is ${cart.status}`,
        "This cart has already been checked out. If your payment is pending, finish it from the payment page.",
      );
    }

    // The LAST live read (visibility SELECT — FK ≠ tenancy): everything
    // after this renders from the snapshot.
    const rows = await tx
      .select({
        variantId: cartLines.variantId,
        quantity: cartLines.quantity,
        productId: productVariants.productId,
        sku: productVariants.sku,
        options: productVariants.options,
        pricePaise: productVariants.pricePaise,
        title: products.title,
        hsnCode: products.hsnCode,
        taxRateBps: products.taxRateBps,
      })
      .from(cartLines)
      .innerJoin(productVariants, eq(productVariants.id, cartLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(cartLines.tenantId, ctx.tenantId),
          eq(cartLines.cartId, cart.id),
          eq(productVariants.tenantId, ctx.tenantId),
          eq(productVariants.isActive, true),
          isNull(productVariants.deletedAt),
          eq(products.tenantId, ctx.tenantId),
          eq(products.status, "active"),
          isNull(products.deletedAt),
        ),
      )
      .orderBy(asc(cartLines.createdAt), asc(cartLines.id));
    if (rows.length === 0) {
      refuse("cart_empty", 422, `Cart ${cartId} has no purchasable lines`, "Your cart is empty.");
    }

    const customer = await upsertCustomerByPhone(tx, ctx.tenantId, {
      phoneE164: clean.phone,
      name: clean.buyerName,
      email: clean.email,
    });

    const subtotalPaise = rows.reduce((sum, r) => sum + r.pricePaise * r.quantity, 0);
    const shippingBasePaise = computeShippingFeePaise(subtotalPaise, {
      flatFeePaise: settings.flatFeePaise,
      freeAbovePaise: settings.freeAbovePaise,
    });

    // Coupon: FOR UPDATE load serializes BOTH the advisory count here and
    // the confirm-time slot computation (D8).
    let promotion: PromotionData | null = null;
    let discountPaise = 0;
    let lineDiscounts: number[] = rows.map(() => 0);
    let shippingPaise = shippingBasePaise;
    if (clean.couponCode) {
      promotion = await loadActivePromotionForUpdate(tx, ctx.tenantId, clean.couponCode);
      if (!promotion) {
        refuse(
          "coupon_invalid",
          422,
          `Coupon ${clean.couponCode} absent or inactive`,
          "That coupon code is not valid.",
          { issues: [{ path: "couponCode", message: "That coupon code is not valid." }] },
        );
      }

      const productIds = [...new Set(rows.map((r) => r.productId))];
      const categoryRows = await tx
        .select({ productId: productCategories.productId, categoryId: productCategories.categoryId })
        .from(productCategories)
        .where(
          and(
            eq(productCategories.tenantId, ctx.tenantId),
            inArray(productCategories.productId, productIds),
          ),
        );
      const categoriesByProduct = new Map<string, string[]>();
      for (const row of categoryRows) {
        const list = categoriesByProduct.get(row.productId) ?? [];
        list.push(row.categoryId);
        categoriesByProduct.set(row.productId, list);
      }

      const evaluation = evaluatePromotion(
        promotion,
        {
          lines: rows.map((r) => ({
            variantId: r.variantId,
            productId: r.productId,
            categoryIds: categoriesByProduct.get(r.productId) ?? [],
            quantity: r.quantity,
            unitPricePaise: r.pricePaise,
          })),
          subtotalPaise,
          shippingPaise: shippingBasePaise,
          channel: "web",
        },
        { id: customer.customerId, isFirstOrder: customer.firstOrderAt === null },
        new Date(),
      );
      if (!evaluation.applicable) {
        refuse(
          "coupon_not_applicable",
          422,
          `Coupon ${clean.couponCode} not applicable: ${evaluation.reason}`,
          "That coupon does not apply to this order.",
          {
            reason: evaluation.reason,
            issues: [{ path: "couponCode", message: "This coupon does not apply to this order." }],
          },
        );
      }

      // Advisory caps under the promotion lock (D8): redemption rows plus
      // pending claims (pending_payment orders, read-side expiry filter).
      if (promotion.usageLimitTotal !== null) {
        const used = await countRedemptions(tx, ctx.tenantId, promotion.id);
        const pending = await countPendingClaims(tx, ctx.tenantId, promotion.id);
        if (used + pending >= promotion.usageLimitTotal) {
          refuse(
            "coupon_exhausted",
            422,
            `Coupon ${promotion.code} at total limit (${used} used + ${pending} pending)`,
            "That coupon has been fully redeemed.",
            { issues: [{ path: "couponCode", message: "This coupon has been fully redeemed." }] },
          );
        }
      }
      if (promotion.usageLimitPerCustomer !== null) {
        const [usedByCustomer] = await tx
          .select({ n: sql<number>`count(*)::int`.as("n") })
          .from(couponRedemptions)
          .where(
            and(
              eq(couponRedemptions.tenantId, ctx.tenantId),
              eq(couponRedemptions.promotionId, promotion.id),
              eq(couponRedemptions.customerId, customer.customerId),
            ),
          );
        const [pendingByCustomer] = await tx
          .select({ n: sql<number>`count(*)::int`.as("n") })
          .from(orders)
          .where(
            and(
              eq(orders.tenantId, ctx.tenantId),
              eq(orders.promotionId, promotion.id),
              eq(orders.customerId, customer.customerId),
              eq(orders.status, "pending_payment"),
              sql`${orders.expiresAt} > now()`,
            ),
          );
        if ((usedByCustomer?.n ?? 0) + (pendingByCustomer?.n ?? 0) >= promotion.usageLimitPerCustomer) {
          refuse(
            "coupon_exhausted",
            422,
            `Coupon ${promotion.code} at per-customer limit for ${customer.customerId}`,
            "You have already used this coupon the maximum number of times.",
            { issues: [{ path: "couponCode", message: "You have already used this coupon." }] },
          );
        }
      }

      const applied = applyDiscountToLines(
        rows.map((r) => ({ lineTotalPaise: r.pricePaise * r.quantity })),
        evaluation.discount,
        shippingBasePaise,
      );
      discountPaise = evaluation.discount.discountPaise;
      lineDiscounts = applied.lineDiscountsPaise;
      shippingPaise = applied.shippingPaise;
    }

    // GST — discounts BEFORE tax, per-line HALF_UP then sum (§6.1). The
    // shipping line is taxed at the highest-value item line's rate
    // (principal-supply proxy; flagged for a CA in the design).
    const itemTaxable = rows.map((r, i) => r.pricePaise * r.quantity - (lineDiscounts[i] ?? 0));
    let shippingRateBps = 0;
    let highestValue = -1;
    rows.forEach((r, i) => {
      const value = itemTaxable[i]!;
      if (value > highestValue) {
        highestValue = value;
        shippingRateBps = r.taxRateBps ?? 0;
      }
    });
    const taxInput: TaxableLine[] = rows.map((r, i) => ({
      lineId: `item-${i}`,
      taxablePaise: itemTaxable[i]!,
      taxRateBps: r.taxRateBps ?? 0,
    }));
    if (shippingPaise > 0) {
      taxInput.push({ lineId: "shipping", taxablePaise: shippingPaise, taxRateBps: shippingRateBps });
    }
    const taxes = computeLineTaxes(taxInput, {
      sellerStateCode: seller.originStateCode ?? "",
      placeOfSupplyStateCode: clean.stateCode,
      registrationType: seller.taxRegistrationType,
      inclusive: true,
    });
    const taxByLineId = new Map(taxes.map((t) => [t.lineId, t]));
    const taxTotalPaise = taxes.reduce((sum, t) => sum + t.taxPaise, 0);

    const totalPaise = subtotalPaise - discountPaise + shippingPaise;
    const { advancePaise, codDuePaise } = computeAdvanceSplit(
      totalPaise,
      settings.advancePolicy,
      clean.paymentMode,
    );

    // Order number: get-or-create the counter, UPDATE .. RETURNING.
    await tx.insert(orderCounters).values({ tenantId: ctx.tenantId }).onConflictDoNothing();
    const [counter] = await tx
      .update(orderCounters)
      .set({ nextNumber: sql`${orderCounters.nextNumber} + 1` })
      .where(eq(orderCounters.tenantId, ctx.tenantId))
      .returning({ nextNumber: orderCounters.nextNumber });
    if (!counter) {
      throw new Error("order_counters missing after upsert — is the transaction missing tenant context?");
    }
    const orderNumber = counter.nextNumber - 1;

    const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60_000);
    const fingerprint = computeCheckoutFingerprint({
      lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity })),
      pincode: clean.pincode,
      stateCode: clean.stateCode,
      paymentMode: clean.paymentMode,
      couponCode: clean.couponCode,
      buyerPhone: clean.phone,
    });

    const [order] = await tx
      .insert(orders)
      .values({
        tenantId: ctx.tenantId,
        orderNumber,
        channel: "web",
        status: "pending_payment",
        paymentStatus: "pending",
        cartId: cart.id,
        customerId: customer.customerId,
        idempotencyKey: clean.idempotencyKey,
        checkoutFingerprint: fingerprint,
        buyerName: clean.buyerName,
        buyerPhoneE164: clean.phone,
        buyerEmail: clean.email,
        shippingAddress: {
          line1: clean.line1,
          line2: clean.line2,
          city: clean.city,
          state_code: clean.stateCode,
          pincode: clean.pincode,
        },
        placeOfSupply: clean.stateCode,
        buyerGstin: clean.buyerGstin,
        currency: cart.currency,
        paymentMode: clean.paymentMode,
        subtotalPaise,
        discountPaise,
        shippingPaise,
        taxPaise: taxTotalPaise,
        totalPaise,
        codDuePaise,
        promotionId: promotion?.id ?? null,
        couponCodeSnapshot: promotion?.code ?? null,
        expiresAt,
      })
      .returning({ id: orders.id });
    const orderId = order!.id;

    // Snapshot lines (blueprint line 365): items then the shipping line.
    const lineValues: (typeof orderLines.$inferInsert)[] = rows.map((r, i) => {
      const tax = taxByLineId.get(`item-${i}`)!;
      const gross = itemTaxable[i]!;
      const optionText = Object.values((r.options ?? {}) as Record<string, string>)
        .filter(Boolean)
        .join(" / ");
      return {
        tenantId: ctx.tenantId,
        orderId,
        kind: "item",
        variantId: r.variantId,
        titleSnapshot: optionText ? `${r.title} (${optionText})` : r.title,
        skuSnapshot: r.sku,
        hsnSnapshot: r.hsnCode,
        quantity: r.quantity,
        unitPricePaise: r.pricePaise,
        discountPaise: lineDiscounts[i] ?? 0,
        taxablePaise: tax.taxableExclusivePaise,
        taxRateBps: r.taxRateBps ?? 0,
        cgstPaise: tax.cgstPaise,
        sgstPaise: tax.sgstPaise,
        igstPaise: tax.igstPaise,
        taxPaise: tax.taxPaise,
        totalPaise: gross,
        position: i,
      };
    });
    if (shippingPaise > 0) {
      const tax = taxByLineId.get("shipping")!;
      lineValues.push({
        tenantId: ctx.tenantId,
        orderId,
        kind: "shipping",
        variantId: null,
        titleSnapshot: "Shipping",
        skuSnapshot: "",
        hsnSnapshot: null,
        quantity: 1,
        unitPricePaise: shippingPaise,
        discountPaise: 0,
        taxablePaise: tax.taxableExclusivePaise,
        taxRateBps: shippingRateBps,
        cgstPaise: tax.cgstPaise,
        sgstPaise: tax.sgstPaise,
        igstPaise: tax.igstPaise,
        taxPaise: tax.taxPaise,
        totalPaise: shippingPaise,
        position: rows.length,
      });
    }
    await tx.insert(orderLines).values(lineValues);

    // order.placed — the creation event (no from-status; not a transition).
    const [placedRow] = await tx
      .insert(orderEvents)
      .values({
        tenantId: ctx.tenantId,
        orderId,
        event: "order.placed",
        fromStatus: null,
        toStatus: "pending_payment",
        actorType: "customer",
        data: { orderNumber, paymentMode: clean.paymentMode, totalPaise },
        requestId: ctx.requestId ?? null,
      })
      .returning({ id: orderEvents.id, createdAt: orderEvents.createdAt });

    await tx
      .update(carts)
      .set({ status: "converted", updatedAt: new Date() })
      .where(and(eq(carts.tenantId, ctx.tenantId), eq(carts.id, cart.id)));

    return {
      orderId,
      orderNumber,
      totalPaise,
      advancePaise,
      codDuePaise,
      holdLines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity })),
      placedEvent: {
        orderEventId: placedRow!.id,
        tenantId: ctx.tenantId,
        orderId,
        event: "order.placed",
        occurredAt: placedRow!.createdAt.toISOString(),
        requestId: ctx.requestId ?? null,
        data: { orderNumber, paymentMode: clean.paymentMode, totalPaise },
      },
      expiresAt,
    };
  });
}

/**
 * [TX-C]-shaped cancel of a still-pending order (hold failure, coupon
 * exhaustion at COD confirm). Reverts the cart to `active` so the
 * buyer's retry on the same cart works (D1a), releases any surviving
 * holds (bookkeeping), enqueues the event after commit.
 */
async function cancelPendingOrder(
  ctx: BuyerContext,
  orderId: string,
  reason: string,
  event: { name: OrderEventName; data?: Record<string, unknown> },
): Promise<void> {
  const descriptor = await withTenant(ctx.tenantId, async (tx) => {
    const order = await lockOrder(tx, ctx.tenantId, orderId);
    if (!order || order.status !== "pending_payment") return null;
    const d = await transitionOrder(
      tx,
      { tenantId: ctx.tenantId, actorType: "system", requestId: ctx.requestId ?? null },
      { id: order.id, status: order.status },
      "cancelled",
      event,
    );
    await tx
      .update(orders)
      .set({ cancelReason: reason, updatedAt: new Date() })
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)));
    if (order.cartId) {
      await tx
        .update(carts)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(carts.tenantId, ctx.tenantId),
            eq(carts.id, order.cartId),
            eq(carts.status, "converted"),
          ),
        );
    }
    return d;
  });
  if (descriptor) await enqueueOrderEvent(descriptor);
  try {
    await releaseStock({ tenantId: ctx.tenantId, requestId: ctx.requestId ?? null }, {
      type: "checkout",
      id: orderId,
    });
  } catch (err) {
    logSoftFailure("hold release", ctx.tenantId, err);
  }
}

/** §4.2 payment-start: the ONE synchronous vendor call (written deviation D4) + [TX-D]. */
async function startGatewayPayment(
  ctx: BuyerContext,
  args: { orderId: string; account: EnabledPaymentAccount; amountPaise: number },
): Promise<CheckoutStartResponse> {
  const adapter = resolveAdapter(args.account.providerCode);
  const creds = await unsealGatewayCredentials(ctx.tenantId, args.account);
  const { gatewayOrderId } = await adapter.createGatewayOrder(creds, {
    amountPaise: args.amountPaise,
    currency: "INR",
    // The order id is the receipt: stable across retries, so a gateway
    // that dedupes receipts (and the mock, which hashes them) returns
    // the same gateway order for a replayed payment-start.
    receipt: args.orderId,
  });

  await withTenant(ctx.tenantId, async (tx) => {
    // Reuse an existing attempt row (a replayed payment-start against a
    // deduping gateway returns the same gateway order id).
    const existing = await findPaymentByGatewayOrder(tx, ctx.tenantId, args.orderId, gatewayOrderId);
    if (!existing) {
      await insertPayment(tx, ctx.tenantId, {
        orderId: args.orderId,
        paymentAccountId: args.account.id,
        providerCode: args.account.providerCode,
        amountPaise: args.amountPaise,
        gatewayOrderId,
      });
    }
    await tx
      .update(orders)
      .set({
        gatewayOrderRef: gatewayOrderId,
        paymentProvider: args.account.providerCode,
        updatedAt: new Date(),
      })
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, args.orderId)));
  });

  return {
    orderId: args.orderId,
    orderToken: signOrderToken(args.orderId),
    status: "payment_required",
    gatewayOrderId,
    publicKeyId: args.account.publicKeyId,
    amountPaise: args.amountPaise,
  };
}

/**
 * D1a replay: the stored fingerprint decides between "same request —
 * return the winner" and 422 `idempotency_key_reuse`. The order's OWN
 * item lines feed the fingerprint (they are the cart lines the original
 * request snapshotted, and they can no longer change).
 */
async function replayCheckout(
  ctx: BuyerContext,
  order: OrderRow,
  clean: CleanCheckout,
): Promise<CheckoutStartResponse> {
  const lines = await withTenant(ctx.tenantId, (tx) => loadOrderLines(tx, ctx.tenantId, order.id));
  const fingerprint = computeCheckoutFingerprint({
    lines: holdLinesOf(lines),
    pincode: clean.pincode,
    stateCode: clean.stateCode,
    paymentMode: clean.paymentMode,
    couponCode: clean.couponCode,
    buyerPhone: clean.phone,
  });
  if (fingerprint !== order.checkoutFingerprint) {
    refuse(
      "idempotency_key_reuse",
      422,
      `Idempotency key ${clean.idempotencyKey} reused with a different fingerprint`,
      "This checkout was already started with different details. Refresh and try again.",
    );
  }

  if (order.status === "cancelled") {
    refuse(
      "checkout_cancelled",
      422,
      `Order ${order.id} was cancelled; the same idempotency key cannot revive it`,
      "This checkout could not be completed. Please try again.",
    );
  }
  if (order.status === "abandoned") {
    refuse(
      "checkout_expired",
      422,
      `Order ${order.id} expired; the same idempotency key cannot revive it`,
      "This checkout expired. Please start again.",
    );
  }
  if (order.status !== "pending_payment") {
    // confirmed or further along the ladder — the original outcome.
    return { orderId: order.id, orderToken: signOrderToken(order.id), status: "confirmed" };
  }

  // Still pending: refresh the hold (replace semantics) and the TTL.
  const holdLines = holdLinesOf(lines);
  try {
    await holdStock(
      { tenantId: ctx.tenantId, requestId: ctx.requestId ?? null },
      { reference: { type: "checkout", id: order.id }, lines: holdLines },
    );
  } catch (err) {
    if (err instanceof InsufficientAvailabilityError) {
      await cancelPendingOrder(ctx, order.id, "hold_failed", {
        name: "order.hold_failed",
        data: { failedLines: err.failedLines },
      });
      throw err;
    }
    throw err;
  }
  const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60_000);
  await withTenant(ctx.tenantId, (tx) =>
    tx
      .update(orders)
      .set({ expiresAt, updatedAt: new Date() })
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id))),
  );
  await enqueueExpireJob(ctx.tenantId, order.id, expiresAt);

  // A pending COD/zero-total order means a confirm crashed mid-flight —
  // finish it through the same door.
  if (order.paymentMode === "cod" || order.totalPaise === 0) {
    try {
      await confirmCodOrder(ctx, order.id);
    } catch (err) {
      // A concurrent replay may have confirmed it first; anything else
      // (including a cancel that won the race) surfaces unchanged.
      const now = await withTenant(ctx.tenantId, async (tx) => {
        const [row] = await tx
          .select({ status: orders.status })
          .from(orders)
          .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id)))
          .limit(1);
        return row?.status ?? null;
      });
      if (now !== "confirmed") throw err;
    }
    return { orderId: order.id, orderToken: signOrderToken(order.id), status: "confirmed" };
  }

  const account = await withTenant(ctx.tenantId, (tx) => getEnabledAccount(tx, ctx.tenantId));
  if (!account) {
    refuse(
      "payments_not_configured",
      422,
      "No enabled payment account on replay",
      "Online payment is not available on this store yet.",
    );
  }
  const advancePaise = order.totalPaise - order.codDuePaise;
  if (!order.gatewayOrderRef) {
    // Crash between TX-A and payment-start — run payment-start now.
    return startGatewayPayment(ctx, { orderId: order.id, account, amountPaise: advancePaise });
  }
  return {
    orderId: order.id,
    orderToken: signOrderToken(order.id),
    status: "payment_required",
    gatewayOrderId: order.gatewayOrderRef,
    publicKeyId: account.publicKeyId,
    amountPaise: advancePaise,
  };
}

// ─────────────────────────────────────────────────────────────────────
// The ONE confirmation door (D5): COD-at-placement and the webhook money
// tx run the same steps d–j of §4.4 inside the CALLER's transaction.
// ─────────────────────────────────────────────────────────────────────

type ConfirmOutcome = {
  confirmedEvent: OrderEventDescriptor;
  overredeemedEvent: OrderEventDescriptor | null;
  productIds: string[];
};

async function confirmOrderCore(
  tx: Tx,
  actor: OrderActorContext,
  args: {
    order: OrderRow;
    lines: OrderLineRow[];
    seller: SellerIdentity;
    settings: CheckoutSettings;
    /** 'refuse' at COD placement; 'overredeem' when money was captured (§4.4.h). */
    onCouponExhausted: "refuse" | "overredeem";
  },
): Promise<ConfirmOutcome> {
  const { order, lines, seller, settings } = args;

  // (g) — consume from ORDER lines, never hold rows (D2a). Throws
  // ConsumeShortfallError | StockHeldError; the caller maps both to the
  // same cancel+refund path.
  const holdLines = holdLinesOf(lines);
  let productIds: string[] = [];
  if (holdLines.length > 0) {
    const consumed = await consumeStockWithin(
      tx,
      { tenantId: actor.tenantId, requestId: actor.requestId ?? null },
      { reference: { type: "checkout", id: order.id }, lines: holdLines },
    );
    productIds = consumed.productIds;
  }

  // (f) — the table-checked transition with the D21 belt.
  const confirmedEvent = await transitionOrder(
    tx,
    actor,
    { id: order.id, status: order.status },
    "confirmed",
    { name: "order.confirmed", data: { orderNumber: order.orderNumber } },
  );

  // (h) — coupon claim under the promotion lock.
  let overredeemedEvent: OrderEventDescriptor | null = null;
  if (order.promotionId) {
    const promotion = await loadPromotionById(tx, actor.tenantId, order.promotionId);
    if (promotion) {
      const claim = await claimRedemption(tx, actor.tenantId, {
        promotion,
        orderId: order.id,
        customerId: order.customerId,
        discountPaise: order.discountPaise,
      });
      if (!claim.claimed) {
        if (args.onCouponExhausted === "refuse") {
          refuse(
            "coupon_exhausted",
            422,
            `Coupon ${promotion.code} exhausted at confirm for order ${order.id}`,
            "That coupon has been fully redeemed.",
          );
        }
        // Captured money is never refused over a coupon: confirm anyway,
        // skip the insert, flag it for the merchant (§4.4.h).
        overredeemedEvent = await insertOrderEvent(tx, actor, order.id, "promotion.overredeemed", {
          promotionId: promotion.id,
          code: promotion.code,
          discountPaise: order.discountPaise,
        });
      }
    }
  }

  // (i) — invoice allocation + INSERT, THIS tx only (D5).
  const docType = docTypeFor(seller.taxRegistrationType);
  const address = parseOrderAddress(order.shippingAddress);
  const invoiceLines: InvoiceDocLine[] = lines.map((l) => ({
    kind: l.kind,
    titleSnapshot: l.titleSnapshot,
    skuSnapshot: l.skuSnapshot,
    hsnSnapshot: l.hsnSnapshot,
    quantity: l.quantity,
    unitPricePaise: l.unitPricePaise,
    discountPaise: l.discountPaise,
    taxablePaise: l.taxablePaise,
    taxRateBps: l.taxRateBps,
    cgstPaise: l.cgstPaise,
    sgstPaise: l.sgstPaise,
    igstPaise: l.igstPaise,
    taxPaise: l.taxPaise,
    totalPaise: l.totalPaise,
    position: l.position,
  }));
  const invoiceSeller: InvoiceSeller = {
    legalName: seller.legalName,
    gstin: seller.gstin,
    address: settings.sellerAddress,
    stateCode: seller.originStateCode ?? "",
    taxRegistrationType: seller.taxRegistrationType,
  };
  const invoiceBuyer: InvoiceBuyer = {
    name: order.buyerName,
    phone: order.buyerPhoneE164,
    email: order.buyerEmail,
    gstin: order.buyerGstin,
    shippingAddress: {
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      stateCode: address.stateCode || order.placeOfSupply,
      pincode: address.pincode,
    },
  };
  await createInvoice(tx, actor.tenantId, {
    orderId: order.id,
    docType,
    prefix: settings.invoicePrefix ?? (docType === "tax_invoice" ? "INV" : "BOS"),
    seller: invoiceSeller,
    buyer: invoiceBuyer,
    placeOfSupply: order.placeOfSupply,
    lines: invoiceLines,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    taxablePaise: lines.reduce((sum, l) => sum + l.taxablePaise, 0),
    cgstPaise: lines.reduce((sum, l) => sum + l.cgstPaise, 0),
    sgstPaise: lines.reduce((sum, l) => sum + l.sgstPaise, 0),
    igstPaise: lines.reduce((sum, l) => sum + l.igstPaise, 0),
    totalPaise: order.totalPaise,
  });

  // (j) — first-order mark + audit, atomic with the confirmation.
  if (order.customerId) await markFirstOrder(tx, actor.tenantId, order.customerId);
  await recordAudit(tx, actor.tenantId, {
    actorType: actor.actorType,
    actorUserId: actor.actorUserId ?? null,
    action: "order.status_changed",
    entityType: "order",
    entityId: order.id,
    before: { status: "pending_payment" },
    after: { status: "confirmed" },
    requestId: actor.requestId ?? null,
  });

  return { confirmedEvent, overredeemedEvent, productIds };
}

async function loadPromotionById(
  tx: Tx,
  tenantId: string,
  promotionId: string,
): Promise<PromotionData | null> {
  // claimRedemption re-locks the row itself; this SELECT (FOR UPDATE for
  // the same serialization) just materializes PromotionData by id.
  const [row] = await tx
    .select()
    .from(promotions)
    .where(and(eq(promotions.tenantId, tenantId), eq(promotions.id, promotionId)))
    .limit(1)
    .for("update");
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    conditions: (row.conditions ?? []) as PromotionData["conditions"],
    effects: (row.effects ?? []) as PromotionData["effects"],
    usageLimitTotal: row.usageLimitTotal,
    usageLimitPerCustomer: row.usageLimitPerCustomer,
  };
}

/** D2a classifier: the two stock-failure codes take ONE path. */
function isStockFailure(err: unknown): boolean {
  return err instanceof ConsumeShortfallError || err instanceof StockHeldError;
}

/** Buyer-worded 422 composed OUTSIDE the aborted tx (fresh availability read). */
async function stockFailureToBuyerError(tenantId: string, err: unknown): Promise<AppError> {
  if (err instanceof StockHeldError) return err; // already buyer-worded (S0 contract)
  const shortfall = err as ConsumeShortfallError;
  const line = shortfall.line;
  let available = 0;
  try {
    available = await withTenant(tenantId, async (tx) => {
      const map = await getAvailability(tx, [line.variantId]);
      return map.get(line.variantId)?.available ?? 0;
    });
  } catch {
    /* the refusal must not fail over a read */
  }
  return new InsufficientAvailabilityError([
    { variantId: line.variantId, requested: line.quantity, available },
  ]);
}

// ─────────────────────────────────────────────────────────────────────
// §4.3 — COD confirm at placement (D5)
// ─────────────────────────────────────────────────────────────────────

/**
 * §4.3 (D5): full-COD (and zero-total) confirmation at placement through
 * the SAME door as the webhook path — consumeStockWithin from ORDER
 * lines, transition to confirmed, coupon claim, invoice allocation +
 * insert IN THIS TX, markFirstOrder, events + audit. Called only by
 * startCheckout.
 */
export async function confirmCodOrder(ctx: BuyerContext, orderId: string): Promise<void> {
  const seller = await loadSellerIdentity(ctx.tenantId);
  const settings = await readCheckoutSettings(ctx.tenantId);
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "customer",
    requestId: ctx.requestId ?? null,
  };

  let outcome: ConfirmOutcome;
  try {
    outcome = await withTenant(ctx.tenantId, async (tx) => {
      const order = await lockOrder(tx, ctx.tenantId, orderId);
      if (!order) {
        refuse("not_found", 404, `Order ${orderId} not found`, "That order does not exist.");
      }
      if (order.status !== "pending_payment") {
        refuse(
          "invalid_transition",
          422,
          `Order ${orderId} is ${order.status}, not pending_payment`,
          "This order was already processed.",
        );
      }
      const lines = await loadOrderLines(tx, ctx.tenantId, orderId);

      const result = await confirmOrderCore(tx, actor, {
        order,
        lines,
        seller,
        settings,
        onCouponExhausted: "refuse",
      });

      // §4.3: cod_due = total (zero-total orders read as fully paid).
      await tx
        .update(orders)
        .set(
          order.totalPaise === 0
            ? { paymentStatus: "paid", codDuePaise: 0, updatedAt: new Date() }
            : { paymentStatus: "pending", codDuePaise: order.totalPaise, updatedAt: new Date() },
        )
        .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)));

      return result;
    });
  } catch (err) {
    if (isStockFailure(err)) {
      // TX rolled back: no movements, no redemption, invoice number
      // returned. Cancel; no refund — no money moved on a COD placement.
      const buyerError = await stockFailureToBuyerError(ctx.tenantId, err);
      await cancelPendingOrder(ctx, orderId, "stock_shortfall", {
        name: "order.oversold",
        data: { message: buyerError.publicMessage },
      });
      throw buyerError;
    }
    if (err instanceof AppError && err.code === "coupon_exhausted") {
      await cancelPendingOrder(ctx, orderId, "coupon_exhausted", {
        name: "order.cancelled",
        data: { reason: "coupon_exhausted" },
      });
    }
    throw err;
  }

  // After commit: enqueue + purge, fail-soft.
  await enqueueOrderEvent(outcome.confirmedEvent);
  if (outcome.overredeemedEvent) await enqueueOrderEvent(outcome.overredeemedEvent);
  if (outcome.productIds.length > 0) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, outcome.productIds));
  }
}

// ─────────────────────────────────────────────────────────────────────
// §4.4 — webhook confirm (the money tx)
// ─────────────────────────────────────────────────────────────────────

/**
 * §4.4 TX-2/TX-3: processes one verified, already-recorded webhook event
 * idempotently (no-op on already-final state). Resolves on success —
 * the route returns 2xx only after this commits; throws → 5xx → gateway
 * redelivery.
 */
export async function confirmFromWebhookEvent(
  ctx: BuyerContext,
  args: { webhookEventId: string; event: GatewayEvent },
): Promise<void> {
  switch (args.event.type) {
    case "payment.captured":
      return processCaptured(ctx, args.event, args.webhookEventId);
    case "payment.failed":
      return processFailed(ctx, args.event);
    case "refund.processed":
      return processRefundProcessed(ctx, args.event);
    default:
      // Unknown event vocabulary is acknowledged, never an error — the
      // evidence row already committed in TX-1.
      return;
  }
}

type CaptureResult =
  | { kind: "ignored" | "replay" | "amount_mismatch" }
  | { kind: "late_capture"; refundId: string; refundCreated: boolean }
  | { kind: "confirmed"; outcome: ConfirmOutcome };

async function processCaptured(
  ctx: BuyerContext,
  event: GatewayEvent,
  webhookEventId: string,
): Promise<void> {
  const seller = await loadSellerIdentity(ctx.tenantId);
  const settings = await readCheckoutSettings(ctx.tenantId);
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "system",
    requestId: ctx.requestId ?? null,
  };

  let result: CaptureResult;
  try {
    result = await withTenant(ctx.tenantId, async (tx): Promise<CaptureResult> => {
      // (a) order by gateway ref, FOR UPDATE.
      const [orderRef] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(eq(orders.tenantId, ctx.tenantId), eq(orders.gatewayOrderRef, event.gatewayOrderId)),
        )
        .limit(1);
      if (!orderRef) return { kind: "ignored" }; // test events, foreign refs
      const order = (await lockOrder(tx, ctx.tenantId, orderRef.id))!;

      const payment = await findPaymentByGatewayOrder(tx, ctx.tenantId, order.id, event.gatewayOrderId);
      if (!payment) return { kind: "ignored" };

      // (b) idempotence gate.
      if (payment.status === "captured") return { kind: "replay" };

      // (c) amount check BEFORE any state advance.
      if (event.amountPaise !== payment.amountPaise) {
        await markPaymentFailed(tx, ctx.tenantId, {
          paymentId: payment.id,
          errorCode: "amount_mismatch",
          errorDescription: `expected ${payment.amountPaise}, gateway reported ${event.amountPaise}`,
        });
        await insertOrderEvent(tx, actor, order.id, "payment.amount_mismatch", {
          expectedPaise: payment.amountPaise,
          reportedPaise: event.amountPaise,
          webhookEventId,
        });
        return { kind: "amount_mismatch" };
      }

      // (d) late capture — abandoned stays abandoned (D9); any other
      // non-pending state with money arriving fresh gets the same
      // money-safe treatment (unreachable in practice, cheap to keep).
      if (order.status !== "pending_payment") {
        await captureOntoPayment(tx, ctx.tenantId, payment.id, event);
        await tx
          .update(orders)
          .set({
            amountPaidPaise: sql`${orders.amountPaidPaise} + ${event.amountPaise}`,
            paymentStatus: "refund_initiated",
            updatedAt: new Date(),
          })
          .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id)));
        const refund = await createRefundIntent(tx, ctx.tenantId, {
          orderId: order.id,
          paymentId: payment.id,
          amountPaise: event.amountPaise,
          reason: "late_capture_abandoned",
        });
        if (refund.created) {
          await insertOrderEvent(tx, actor, order.id, "payment.late_captured", {
            amountPaise: event.amountPaise,
            orderStatus: order.status,
            webhookEventId,
          });
        }
        return { kind: "late_capture", refundId: refund.refundId, refundCreated: refund.created };
      }

      // (e) capture + amounts.
      await captureOntoPayment(tx, ctx.tenantId, payment.id, event);
      const paidAfter = order.amountPaidPaise + event.amountPaise;
      await tx
        .update(orders)
        .set({
          amountPaidPaise: paidAfter,
          paymentStatus: paidAfter >= order.totalPaise ? "paid" : "partially_paid",
          updatedAt: new Date(),
        })
        .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id)));

      // (f)–(j) — the shared door.
      const outcome = await confirmOrderCore(tx, actor, {
        order,
        lines: await loadOrderLines(tx, ctx.tenantId, order.id),
        seller,
        settings,
        onCouponExhausted: "overredeem",
      });
      return { kind: "confirmed", outcome };
    });
  } catch (err) {
    if (isStockFailure(err)) {
      // TX-2 rolled back entirely (invoice number returned, no
      // redemption, no movements) → TX-3: money is never hostage to
      // stock (D2a).
      await oversoldCancel(ctx, event);
      return;
    }
    throw err;
  }

  // Post-commit effects.
  if (result.kind === "confirmed") {
    await enqueueOrderEvent(result.outcome.confirmedEvent);
    if (result.outcome.overredeemedEvent) await enqueueOrderEvent(result.outcome.overredeemedEvent);
    if (result.outcome.productIds.length > 0) {
      await purgeStorefrontCache(
        ctx.tenantId,
        catalogPurgeTags(ctx.tenantId, result.outcome.productIds),
      );
    }
  } else if (result.kind === "late_capture") {
    await enqueueRefundJob(ctx.tenantId, result.refundId);
  }
}

type PaymentRow = { id: string; status: string; amountPaise: number };

async function findPaymentByGatewayOrder(
  tx: Tx,
  tenantId: string,
  orderId: string,
  gatewayOrderId: string,
): Promise<PaymentRow | null> {
  const [row] = await tx
    .select({ id: payments.id, status: payments.status, amountPaise: payments.amountPaise })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.orderId, orderId),
        eq(payments.gatewayOrderId, gatewayOrderId),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return row ?? null;
}

/** Capture with the fee economics from the payload (D17), in the caller's tx. */
async function captureOntoPayment(
  tx: Tx,
  tenantId: string,
  paymentId: string,
  event: GatewayEvent,
): Promise<void> {
  await markPaymentCaptured(tx, tenantId, {
    paymentId,
    gatewayPaymentId: event.gatewayPaymentId ?? event.eventId,
    method: event.method ?? null,
    feePaise: event.feePaise ?? null,
    feeTaxPaise: event.feeTaxPaise ?? null,
  });
}

const OVERSOLD_BUYER_MESSAGE =
  "An item in this order sold out before the payment completed. The order was cancelled and the full amount paid is being refunded.";

/**
 * [TX-3] (§4.4.g, D2a): record the capture, cancel the order, insert the
 * insert-once refund intent, enqueue the auto-refund after commit.
 * Idempotent under webhook redelivery — every step no-ops when already
 * done.
 */
async function oversoldCancel(ctx: BuyerContext, event: GatewayEvent): Promise<void> {
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "system",
    requestId: ctx.requestId ?? null,
  };
  const result = await withTenant(ctx.tenantId, async (tx) => {
    const [orderRef] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.gatewayOrderRef, event.gatewayOrderId)))
      .limit(1);
    if (!orderRef) return null;
    const order = (await lockOrder(tx, ctx.tenantId, orderRef.id))!;
    const payment = await findPaymentByGatewayOrder(tx, ctx.tenantId, order.id, event.gatewayOrderId);
    if (!payment) return null;

    if (payment.status !== "captured") {
      await captureOntoPayment(tx, ctx.tenantId, payment.id, event);
      await tx
        .update(orders)
        .set({
          amountPaidPaise: sql`${orders.amountPaidPaise} + ${event.amountPaise}`,
          updatedAt: new Date(),
        })
        .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id)));
    }

    const descriptors: OrderEventDescriptor[] = [];
    if (order.status === "pending_payment") {
      descriptors.push(
        await transitionOrder(tx, actor, { id: order.id, status: order.status }, "cancelled", {
          name: "order.oversold",
          data: { message: OVERSOLD_BUYER_MESSAGE },
        }),
      );
      await tx
        .update(orders)
        .set({ cancelReason: "stock_shortfall", paymentStatus: "refund_initiated", updatedAt: new Date() })
        .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, order.id)));
      if (order.cartId) {
        await tx
          .update(carts)
          .set({ status: "active", updatedAt: new Date() })
          .where(
            and(
              eq(carts.tenantId, ctx.tenantId),
              eq(carts.id, order.cartId),
              eq(carts.status, "converted"),
            ),
          );
      }
    }

    const refund = await createRefundIntent(tx, ctx.tenantId, {
      orderId: order.id,
      paymentId: payment.id,
      amountPaise: event.amountPaise,
      reason: "stock_shortfall",
    });
    if (refund.created) {
      descriptors.push(
        await insertOrderEvent(tx, actor, order.id, "payment.refund_initiated", {
          refundId: refund.refundId,
          amountPaise: event.amountPaise,
          reason: "stock_shortfall",
        }),
      );
    }
    return { descriptors, refundId: refund.refundId, orderId: order.id };
  });

  if (!result) return;
  for (const descriptor of result.descriptors) await enqueueOrderEvent(descriptor);
  await enqueueRefundJob(ctx.tenantId, result.refundId);
  // The hold rows survive the rollback; drop them (bookkeeping only —
  // read-side expiry already makes them harmless).
  try {
    await releaseStock(
      { tenantId: ctx.tenantId, requestId: ctx.requestId ?? null },
      { type: "checkout", id: result.orderId },
    );
  } catch (err) {
    logSoftFailure("hold release", ctx.tenantId, err);
  }
}

async function processFailed(ctx: BuyerContext, event: GatewayEvent): Promise<void> {
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "system",
    requestId: ctx.requestId ?? null,
  };
  await withTenant(ctx.tenantId, async (tx) => {
    const [orderRef] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.gatewayOrderRef, event.gatewayOrderId)))
      .limit(1);
    if (!orderRef) return;
    const order = (await lockOrder(tx, ctx.tenantId, orderRef.id))!;
    const payment = await findPaymentByGatewayOrder(tx, ctx.tenantId, order.id, event.gatewayOrderId);
    // Never downgrade a capture; a failed retry after success is noise.
    if (!payment || payment.status === "captured") return;
    await markPaymentFailed(tx, ctx.tenantId, {
      paymentId: payment.id,
      errorCode: event.error?.code ?? null,
      errorDescription: event.error?.description ?? null,
    });
    // Order stays pending_payment — the buyer may retry until expiry.
    await insertOrderEvent(tx, actor, order.id, "payment.failed", {
      errorCode: event.error?.code ?? null,
    });
  });
}

async function processRefundProcessed(ctx: BuyerContext, event: GatewayEvent): Promise<void> {
  if (!event.gatewayRefundId) return;
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "system",
    requestId: ctx.requestId ?? null,
  };
  const descriptor = await withTenant(ctx.tenantId, async (tx) => {
    const hit = await markRefundProcessed(tx, ctx.tenantId, {
      gatewayRefundId: event.gatewayRefundId!,
    });
    if (!hit) return null; // unknown id or replay after the transition — idempotence
    await tx
      .update(orders)
      .set({ paymentStatus: "refunded", updatedAt: new Date() })
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, hit.orderId)));
    return insertOrderEvent(tx, actor, hit.orderId, "order.refunded", {
      refundId: hit.refundId,
      gatewayRefundId: event.gatewayRefundId,
    });
  });
  if (descriptor) await enqueueOrderEvent(descriptor);
}

// ─────────────────────────────────────────────────────────────────────
// §4.6 — abandoned expiry (both D10 drivers call this one door)
// ─────────────────────────────────────────────────────────────────────

/**
 * §4.6, both drivers (delayed job + sweep backstop, D10): order FOR
 * UPDATE — an in-flight webhook wins; still pending past expiry →
 * abandoned + releaseStock (own TX, idempotent bookkeeping — expiry is
 * read-side). Returns what happened so the sweep can log it.
 */
export async function expireCheckout(
  ctx: BuyerContext,
  orderId: string,
): Promise<{ outcome: "abandoned" | "still_pending" | "already_final" }> {
  const result = await withTenant(ctx.tenantId, async (tx) => {
    const order = await lockOrder(tx, ctx.tenantId, orderId);
    if (!order || order.status !== "pending_payment") return { outcome: "already_final" as const };
    if (order.expiresAt && order.expiresAt.getTime() > Date.now()) {
      // A payment retry extended the TTL — not ours to reap yet.
      return { outcome: "still_pending" as const };
    }
    const descriptor = await transitionOrder(
      tx,
      { tenantId: ctx.tenantId, actorType: "system", requestId: ctx.requestId ?? null },
      { id: order.id, status: order.status },
      "abandoned",
      { name: "order.abandoned", data: { orderNumber: order.orderNumber } },
    );
    if (order.cartId) {
      // Give the buyer their cart back — the abandoned order released its
      // claim on it (D1a belt: abandoned rows leave the pending index).
      await tx
        .update(carts)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(carts.tenantId, ctx.tenantId),
            eq(carts.id, order.cartId),
            eq(carts.status, "converted"),
          ),
        );
    }
    return { outcome: "abandoned" as const, descriptor };
  });

  if (result.outcome === "abandoned") {
    // Own TX, existing entry point, idempotent — holds stopped counting
    // read-side at expires_at; this is bookkeeping, never correctness.
    try {
      await releaseStock({ tenantId: ctx.tenantId, requestId: ctx.requestId ?? null }, {
        type: "checkout",
        id: orderId,
      });
    } catch (err) {
      logSoftFailure("hold release", ctx.tenantId, err);
    }
    if ("descriptor" in result && result.descriptor) await enqueueOrderEvent(result.descriptor);
  }
  return { outcome: result.outcome };
}

// ─────────────────────────────────────────────────────────────────────
// §4.7 — console cancel + full refund (pre-shipment)
// ─────────────────────────────────────────────────────────────────────

/** §4.7: console cancel reaches only these states; everything else is 422. */
const CANCELLABLE_BY_STAFF: readonly OrderStatus[] = ["confirmed", "processing"];

/**
 * §4.7 console cancel (permission orders:cancel): transition table
 * permits confirmed/processing → cancelled only; restockWithin
 * (cancellation_restock, reference {type:'order', id}) + insert-once
 * refund intent when money was captured; refund job enqueued after
 * commit.
 */
export async function cancelOrder(
  ctx: WriteContext,
  orderId: string,
  input: { reason?: string | null } = {},
): Promise<void> {
  const actor: OrderActorContext = {
    tenantId: ctx.tenantId,
    actorType: "staff",
    actorUserId: ctx.actorUserId,
    requestId: ctx.requestId ?? null,
  };

  const result = await withTenant(ctx.tenantId, async (tx) => {
    const order = await lockOrder(tx, ctx.tenantId, orderId);
    if (!order) {
      refuse("not_found", 404, `Order ${orderId} not found in this tenant`, "That order does not exist.");
    }
    if (!CANCELLABLE_BY_STAFF.includes(order.status)) {
      refuse(
        "invalid_transition",
        422,
        `Console cancel refused for order ${orderId} in status ${order.status}`,
        `An order that is ${order.status.replaceAll("_", " ")} cannot be cancelled from the console.`,
        { from: order.status, to: "cancelled", allowed: CANCELLABLE_BY_STAFF },
      );
    }

    const lines = await loadOrderLines(tx, ctx.tenantId, orderId);
    // Restock only variants that still exist (a soft-deleted variant's
    // stock is moot and must not brick the cancel).
    const candidateLines = holdLinesOf(lines);
    let productIds: string[] = [];
    if (candidateLines.length > 0) {
      const liveIds = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          and(
            eq(productVariants.tenantId, ctx.tenantId),
            inArray(
              productVariants.id,
              candidateLines.map((l) => l.variantId),
            ),
            isNull(productVariants.deletedAt),
          ),
        );
      const liveSet = new Set(liveIds.map((r) => r.id));
      const restockLines = candidateLines.filter((l) => liveSet.has(l.variantId));
      if (restockLines.length > 0) {
        const restocked = await restockWithin(
          tx,
          { tenantId: ctx.tenantId, requestId: ctx.requestId ?? null },
          restockLines,
          { type: "order", id: orderId },
        );
        productIds = restocked.productIds;
      }
    }

    const descriptors: OrderEventDescriptor[] = [
      await transitionOrder(tx, actor, { id: order.id, status: order.status }, "cancelled", {
        name: "order.cancelled",
        data: { reason: input.reason ?? null, orderNumber: order.orderNumber },
      }),
    ];
    await tx
      .update(orders)
      .set({ cancelReason: input.reason?.trim() || "merchant_cancelled", updatedAt: new Date() })
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)));

    // Insert-once refund intent (D6) when money was captured — a
    // double-cancel race resolves on the refunds UNIQUE.
    let refundId: string | null = null;
    if (order.amountPaidPaise > 0) {
      const [capturedPayment] = await tx
        .select({ id: payments.id, amountPaise: payments.amountPaise })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, ctx.tenantId),
            eq(payments.orderId, orderId),
            eq(payments.status, "captured"),
          ),
        )
        .orderBy(desc(payments.createdAt))
        .limit(1);
      if (capturedPayment) {
        const refund = await createRefundIntent(tx, ctx.tenantId, {
          orderId,
          paymentId: capturedPayment.id,
          amountPaise: capturedPayment.amountPaise,
          reason: "merchant_cancelled",
          createdByUserId: ctx.actorUserId,
        });
        refundId = refund.refundId;
        await tx
          .update(orders)
          .set({ paymentStatus: "refund_initiated", updatedAt: new Date() })
          .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)));
        if (refund.created) {
          descriptors.push(
            await insertOrderEvent(tx, actor, orderId, "payment.refund_initiated", {
              refundId: refund.refundId,
              amountPaise: capturedPayment.amountPaise,
              reason: "merchant_cancelled",
            }),
          );
        }
      }
    }

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "order.cancelled",
      entityType: "order",
      entityId: orderId,
      before: { status: order.status },
      after: { status: "cancelled", reason: input.reason ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return { descriptors, refundId, productIds };
  });

  // After commit, fail-soft: refund job, events, purge for restocked
  // products.
  if (result.refundId) await enqueueRefundJob(ctx.tenantId, result.refundId);
  for (const descriptor of result.descriptors) await enqueueOrderEvent(descriptor);
  if (result.productIds.length > 0) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, result.productIds));
  }
}
