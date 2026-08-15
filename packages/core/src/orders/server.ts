import type {
  ActorType,
  CheckoutPaymentMode,
  OrderChannel,
  OrderPaymentStatus,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  Tx,
} from "@platform/db";

import type { WriteContext } from "../catalog/writes";
import type { OrderEventName } from "./index";

/**
 * Orders — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B5. View-row shapes are lot-internal: B5 may ADD
 * fields but never remove or rename the ones frozen here.
 */

/**
 * Who is acting on the order. Confirmation (webhook) and expiry are
 * `system`, COD confirm is `customer`, manual transitions and cancel are
 * `staff` with an actorUserId. Tenant id comes from the session or the
 * resolved Host — never a payload.
 */
export type OrderActorContext = {
  tenantId: string;
  actorType: ActorType;
  actorUserId?: string | null;
  requestId?: string | null;
};

/**
 * What transitionOrder returns for post-commit enqueue: the order_events
 * row it inserted, ready to become the queue message (jobId =
 * orderEventId).
 */
export type OrderEventDescriptor = {
  orderEventId: string;
  tenantId: string;
  orderId: string;
  event: OrderEventName;
  /** ISO timestamp from the inserted order_events row. */
  occurredAt: string;
  requestId?: string | null;
  data?: Record<string, unknown>;
};

/**
 * THE one status write door (spec §5.1) — no route or module mutates
 * orders.status directly. Inside the CALLER's tx it (1) checks the
 * transition table → 422 `invalid_transition` with {from, to, allowed};
 * (2) UPDATE orders SET status .. WHERE status = <from> — 0 rows → 409
 * `concurrent_modification` (D21, on top of the caller's FOR UPDATE);
 * (3) INSERTs the order_events row; (4) returns the descriptor for
 * post-commit enqueue.
 */
export async function transitionOrder(
  _tx: Tx,
  _ctx: OrderActorContext,
  _order: { id: string; status: OrderStatus },
  _to: OrderStatus,
  _event: { name: OrderEventName; data?: Record<string, unknown> },
): Promise<OrderEventDescriptor> {
  throw new Error("S0 stub: implemented by lot B5");
}

/**
 * Enqueue a committed order_events row onto the orders queue with
 * jobId = orderEventId (Redis-deduped, D11). AFTER commit only,
 * fail-soft — a lost enqueue loses a notification, never a fact.
 */
export async function enqueueOrderEvent(_event: OrderEventDescriptor): Promise<void> {
  throw new Error("S0 stub: implemented by lot B5");
}

export type OrderListRow = {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMode: CheckoutPaymentMode;
  channel: OrderChannel;
  buyerName: string;
  buyerPhoneE164: string;
  totalPaise: number;
  amountPaidPaise: number;
  codDuePaise: number;
  currency: string;
  placedAt: Date;
};

export async function listOrders(
  _tenantId: string,
  _opts: { status?: OrderStatus; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: OrderListRow[]; total: number }> {
  throw new Error("S0 stub: implemented by lot B5");
}

export type OrderDetailLine = {
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

export type OrderDetailPayment = {
  id: string;
  providerCode: string;
  status: PaymentStatus;
  amountPaise: number;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  method: string | null;
  /** D17: console renders gross − fee − fee GST = net settlement. */
  feePaise: number | null;
  feeTaxPaise: number | null;
  errorCode: string | null;
  errorDescription: string | null;
  capturedAt: Date | null;
  createdAt: Date;
};

export type OrderDetailRefund = {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: RefundStatus;
  reason: string;
  gatewayRefundId: string | null;
  createdAt: Date;
};

export type OrderTimelineEvent = {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: ActorType;
  actorName: string | null;
  data: Record<string, unknown> | null;
  createdAt: Date;
};

export type OrderDetail = OrderListRow & {
  fulfilmentStatus: string;
  buyerEmail: string | null;
  shippingAddress: Record<string, unknown>;
  placeOfSupply: string;
  buyerGstin: string | null;
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  couponCodeSnapshot: string | null;
  cancelReason: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  lines: OrderDetailLine[];
  payments: OrderDetailPayment[];
  refunds: OrderDetailRefund[];
  events: OrderTimelineEvent[];
  /** Invoice reference, when issued. */
  invoice: { id: string; invoiceNumber: string; docType: string } | null;
};

export async function getOrderDetail(
  _tenantId: string,
  _orderId: string,
): Promise<OrderDetail | null> {
  throw new Error("S0 stub: implemented by lot B5");
}

/**
 * Console entry point for the manual fulfilment ladder (D12/§4.8): FOR
 * UPDATE, MANUAL_ORDER_TRANSITIONS allowlist, transitionOrder, audit —
 * one tx; enqueue after commit. `delivered` on a COD order sets
 * payment_status = 'paid' and amount_paid = total.
 */
export async function manualTransition(
  _ctx: WriteContext,
  _orderId: string,
  _to: OrderStatus,
): Promise<OrderEventDescriptor> {
  throw new Error("S0 stub: implemented by lot B5");
}
