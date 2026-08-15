import {
  ORDER_CHANNELS,
  ORDER_FULFILMENT_STATUSES,
  ORDER_PAYMENT_STATUSES,
  ORDER_STATUSES,
} from "@platform/db/schema";
import type {
  OrderChannel,
  OrderFulfilmentStatus,
  OrderPaymentStatus,
  OrderStatus,
} from "@platform/db/schema";

import { AppError } from "../errors";

/**
 * Orders — PURE barrel, safe for client bundles (the console renders its
 * action buttons from ORDER_TRANSITIONS). Values come from
 * `@platform/db/schema`, which carries no postgres driver — the root
 * `@platform/db` barrel does and must never be imported here.
 *
 * S0 SCHEMA SPINE: the transition table and event catalog below are
 * PINNED DATA (PHASE2_COMMERCE_DESIGN.md §5); function signatures are
 * FROZEN; function bodies are implemented by lot B5.
 */

export { ORDER_CHANNELS, ORDER_FULFILMENT_STATUSES, ORDER_PAYMENT_STATUSES, ORDER_STATUSES };
export type { OrderChannel, OrderFulfilmentStatus, OrderPaymentStatus, OrderStatus };

/** store_settings key for the merchant-facing order-number prefix. */
export const ORDER_NUMBER_PREFIX_KEY = "orders.number_prefix";

/**
 * The state machine, pinned per spec §5.1. The FULL blueprint state set
 * ships at once; this table is the gate that keeps Phase-3 edges
 * (RTO/return) unreachable — they exist here but have no writer and no
 * console button. Terminal states have no exits: a late capture on an
 * abandoned order records the money and refunds it, it never revives
 * the order (D9).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["confirmed", "abandoned", "cancelled"], // cancelled = hold_failed / oversold
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped"],
  shipped: ["out_for_delivery", "rto_initiated"], // rto edges: Phase 3 writers
  out_for_delivery: ["delivered", "rto_initiated"],
  rto_initiated: ["rto_delivered"],
  delivered: ["return_requested"],
  return_requested: ["return_picked"],
  return_picked: ["refunded"],
  abandoned: [],
  cancelled: [],
  refunded: [],
  rto_delivered: [], // terminal (no revival — D9)
};

/**
 * Staff-clickable forward ladder (D12/§4.8). The console renders ONLY
 * ORDER_TRANSITIONS[current] ∩ this allowlist; cancel goes through its
 * own route/permission. The server door (`transitionOrder`) is the wall.
 */
export const MANUAL_ORDER_TRANSITIONS: readonly { from: OrderStatus; to: OrderStatus }[] = [
  { from: "confirmed", to: "processing" },
  { from: "processing", to: "ready_to_ship" },
  { from: "ready_to_ship", to: "shipped" },
  { from: "shipped", to: "out_for_delivery" },
  { from: "out_for_delivery", to: "delivered" },
];

/** Domain event catalog, pinned per spec §5.2. Job name = event name. */
export const ORDER_EVENT_NAMES = [
  "order.placed",
  "order.confirmed",
  "order.hold_failed",
  "order.oversold",
  "order.cancelled",
  "order.abandoned",
  "order.refunded",
  "order.processing",
  "order.ready_to_ship",
  "order.shipped",
  "order.out_for_delivery",
  "order.delivered",
  "payment.failed",
  "payment.amount_mismatch",
  "payment.late_captured",
  "payment.refund_initiated",
  "promotion.overredeemed",
] as const;
export type OrderEventName = (typeof ORDER_EVENT_NAMES)[number];

/**
 * The queue message (orders queue; jobId = order_events.id, D11). Small
 * payload — consumers re-read the database for truth. TenantJob
 * discipline: tenantId mandatory; the handler's first act is withTenant.
 */
export type OrderDomainEvent = {
  tenantId: string;
  orderId: string;
  event: OrderEventName;
  /** ISO, from the order_events row. */
  occurredAt: string;
  /** Provenance + BullMQ jobId. */
  orderEventId: string;
  requestId?: string | null;
  data?: Record<string, unknown>;
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

/** Throws a 422 AppError `invalid_transition` with {from, to, allowed} details. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (canTransition(from, to)) return;
  const allowed = ORDER_TRANSITIONS[from] ?? [];
  throw new AppError({
    code: "invalid_transition",
    message: `Order transition ${from} → ${to} is not in the transition table`,
    status: 422,
    publicMessage: `An order that is ${label(from)} cannot move to ${label(to)}.`,
    details: { from, to, allowed },
  });
}

/** 'ready_to_ship' → 'ready to ship' — for merchant-facing refusals. */
function label(status: OrderStatus): string {
  return status.replaceAll("_", " ");
}

/**
 * Merchant-facing label, e.g. prefix 'ORD' + 1001 → 'ORD-1001'. An empty
 * prefix yields the bare number — no dangling separator.
 */
export function formatOrderNumber(prefix: string, orderNumber: number): string {
  const trimmed = prefix.trim();
  return trimmed ? `${trimmed}-${orderNumber}` : String(orderNumber);
}
