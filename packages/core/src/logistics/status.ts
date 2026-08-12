import { STATUS_RANK, TERMINAL_STATUSES } from "./types";
import type { NdrReason, ShipmentStatus } from "./types";

/**
 * Status normalisation and event ordering.
 *
 * This is the least glamorous and most load-bearing file in the
 * logistics layer. Carriers emit dozens of free-text statuses, resend
 * events, and deliver them out of order. Everything downstream —
 * customer notifications, the order state machine, RTO accounting,
 * delivery-performance scoring — trusts what comes out of here.
 */

export type StatusMap = Record<string, { status: ShipmentStatus; ndr?: NdrReason }>;

/** Normalise a carrier's raw code/text for lookup. */
export function normaliseKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s\-/]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

/**
 * Translate a carrier status using its map, with a conservative
 * keyword fallback.
 *
 * The fallback matters: carriers add status codes without telling
 * anyone, and the alternative to guessing is dropping the event
 * entirely. Unknown-but-plausible beats silence, and every fallback hit
 * is reported so the map can be corrected.
 */
export function translateStatus(
  raw: string,
  map: StatusMap,
): { status: ShipmentStatus; ndr?: NdrReason; matched: "map" | "keyword" | "none" } {
  const key = normaliseKey(raw);
  const direct = map[key];
  if (direct) return { ...direct, matched: "map" };

  const t = key;
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // Order matters: check the most specific and most damaging first.
  // "rto delivered" must not fall through to the plain "delivered" branch.
  //
  // Only unambiguous completion counts as rto_delivered. Bare phrasing
  // like "Returned to Origin" is treated as merely initiated, because
  // the two errors are not symmetric: calling an RTO complete too early
  // restocks inventory that is still in transit and causes oversell,
  // whereas lagging behind is corrected by the next event.
  if (has("rto_deliver", "rto_complete", "rto_received", "return_received")) {
    return { status: "rto_delivered", matched: "keyword" };
  }
  if (has("rto", "return_to_origin", "returned_to_origin", "return_to_shipper")) {
    return { status: "rto_initiated", matched: "keyword" };
  }
  if (has("lost", "untraceable")) return { status: "lost", matched: "keyword" };
  if (has("damage")) return { status: "damaged", matched: "keyword" };
  if (has("cancel")) return { status: "cancelled", matched: "keyword" };
  if (has("deliver") && has("fail", "unsuccess", "attempt", "undeliver", "ndr")) {
    return { status: "delivery_failed", matched: "keyword" };
  }
  if (has("delivered")) return { status: "delivered", matched: "keyword" };
  if (has("out_for_delivery", "ofd")) return { status: "out_for_delivery", matched: "keyword" };
  if (has("destination", "reached_hub", "arrived_at_destination")) {
    return { status: "reached_destination_hub", matched: "keyword" };
  }
  if (has("in_transit", "shipped", "dispatch", "bagged", "intransit")) {
    return { status: "in_transit", matched: "keyword" };
  }
  if (has("picked", "pickup_done", "collected")) return { status: "picked_up", matched: "keyword" };
  if (has("pickup") && has("fail", "cancel", "exception")) {
    return { status: "pickup_failed", matched: "keyword" };
  }
  if (has("pickup", "pick_up")) return { status: "pickup_scheduled", matched: "keyword" };
  if (has("manifest", "awb_assigned", "label")) return { status: "manifested", matched: "keyword" };
  if (has("hold", "exception", "delay")) return { status: "on_hold", matched: "keyword" };

  // Unknown: hold rather than invent progress. `matched: none` is
  // surfaced to monitoring so the map gets fixed.
  return { status: "on_hold", matched: "none" };
}

/**
 * Should this event be ignored as stale or out of order?
 *
 * Rank alone is not enough, because some backward moves are real:
 * a delivery can fail after being out for delivery, a shipment can go
 * on hold mid-transit, and an RTO legitimately walks the whole thing
 * back. Those are allowed explicitly; everything else that moves
 * backwards is a duplicate or a late retry and gets dropped.
 */
export function isStatusRegression(
  current: ShipmentStatus,
  incoming: ShipmentStatus,
): boolean {
  if (current === incoming) return true; // duplicate

  // Terminal states are final. A late "in_transit" must never reopen a
  // delivered order — that re-fires customer notifications and corrupts
  // the fulfilment funnel.
  if (TERMINAL_STATUSES.has(current)) return true;

  // Legitimate backward transitions.
  const allowedBackward: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
    delivery_failed: ["out_for_delivery", "in_transit", "reached_destination_hub"],
    on_hold: ["in_transit", "reached_destination_hub", "out_for_delivery", "picked_up"],
    rto_initiated: [
      "delivery_failed",
      "out_for_delivery",
      "in_transit",
      "reached_destination_hub",
      "on_hold",
    ],
    rto_in_transit: ["rto_initiated"],
    pickup_failed: ["pickup_scheduled", "manifested"],
    damaged: ["in_transit", "reached_destination_hub", "out_for_delivery", "picked_up"],
    lost: ["in_transit", "reached_destination_hub", "out_for_delivery", "picked_up", "on_hold"],
    cancelled: ["created", "manifested", "pickup_scheduled", "pickup_failed"],
  };

  if (allowedBackward[incoming]?.includes(current)) return false;

  return STATUS_RANK[incoming] <= STATUS_RANK[current];
}

/**
 * Stable dedupe signature. Carriers resend the same event on retry with
 * a fresh envelope but identical content.
 */
export function eventSignature(input: {
  awb: string;
  rawStatus: string;
  occurredAt: Date;
  location?: string;
}): string {
  return [
    input.awb,
    normaliseKey(input.rawStatus),
    // Minute precision: the same event replayed often carries a
    // second-level jitter that would defeat exact-timestamp dedupe.
    Math.floor(input.occurredAt.getTime() / 60_000),
    normaliseKey(input.location ?? ""),
  ].join("|");
}

/** Does this status mean the merchant has lost the freight cost? */
export function isRevenueLoss(status: ShipmentStatus): boolean {
  return status === "rto_delivered" || status === "lost" || status === "damaged";
}

/** Map a shipment status onto the order state machine's fulfilment view. */
export function toFulfilmentStatus(status: ShipmentStatus): string {
  switch (status) {
    case "created":
    case "manifested":
    case "pickup_scheduled":
    case "pickup_failed":
      return "ready_to_ship";
    case "picked_up":
    case "in_transit":
    case "reached_destination_hub":
    case "on_hold":
      return "shipped";
    case "out_for_delivery":
    case "delivery_failed":
      return "out_for_delivery";
    case "delivered":
      return "delivered";
    case "rto_initiated":
    case "rto_in_transit":
      return "rto_initiated";
    case "rto_delivered":
      return "rto_delivered";
    case "cancelled":
      return "cancelled";
    case "lost":
    case "damaged":
      return "exception";
  }
}
