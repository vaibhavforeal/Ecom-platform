import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors";
import {
  MANUAL_ORDER_TRANSITIONS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  assertTransition,
  canTransition,
  formatOrderNumber,
} from "../src/orders/index";
import type { OrderStatus } from "../src/orders/index";

/**
 * The state machine is pure pinned data (spec §5.1) and this suite pins
 * it INDEPENDENTLY: the blueprint edge list below is written out by
 * hand, not derived from ORDER_TRANSITIONS, so an accidental edit to the
 * table fails here rather than shipping.
 */

/** Every legal edge in the blueprint §4.2 diagram, written out by hand. */
const BLUEPRINT_EDGES: readonly [OrderStatus, OrderStatus][] = [
  ["pending_payment", "confirmed"],
  ["pending_payment", "abandoned"],
  ["pending_payment", "cancelled"], // hold_failed / oversold
  ["confirmed", "processing"],
  ["confirmed", "cancelled"],
  ["processing", "ready_to_ship"],
  ["processing", "cancelled"],
  ["ready_to_ship", "shipped"],
  ["shipped", "out_for_delivery"],
  ["shipped", "rto_initiated"], // Phase 3 writer
  ["out_for_delivery", "delivered"],
  ["out_for_delivery", "rto_initiated"], // Phase 3 writer
  ["rto_initiated", "rto_delivered"], // Phase 3 writer
  ["delivered", "return_requested"], // Phase 3 writer
  ["return_requested", "return_picked"], // Phase 3 writer
  ["return_picked", "refunded"], // Phase 3 writer
];

const TERMINAL: readonly OrderStatus[] = ["abandoned", "cancelled", "refunded", "rto_delivered"];

describe("ORDER_TRANSITIONS (pinned table)", () => {
  it("agrees with the hand-pinned blueprint edge list across the full 14×14 matrix", () => {
    const legal = new Set(BLUEPRINT_EDGES.map(([from, to]) => `${from}→${to}`));
    // 14 statuses → 196 pairs, every one asserted.
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(legal.has(`${from}→${to}`));
      }
    }
  });

  it("has an entry for every order status — no status can dodge the gate", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[status], status).toBeDefined();
    }
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it("names only valid statuses as targets", () => {
    const valid = new Set<string>(ORDER_STATUSES);
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const target of targets) expect(valid.has(target), target).toBe(true);
    }
  });

  it("allows no self-transitions", () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it("keeps abandoned terminal — a late capture never revives the order (D9)", () => {
    expect(ORDER_TRANSITIONS.abandoned).toEqual([]);
    expect(canTransition("abandoned", "confirmed")).toBe(false);
  });

  it("keeps cancelled terminal", () => {
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it("keeps refunded terminal", () => {
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
  });

  it("keeps rto_delivered terminal", () => {
    expect(ORDER_TRANSITIONS.rto_delivered).toEqual([]);
  });
});

describe("assertTransition", () => {
  it("passes silently on a legal edge", () => {
    expect(() => assertTransition("pending_payment", "confirmed")).not.toThrow();
    expect(() => assertTransition("out_for_delivery", "delivered")).not.toThrow();
  });

  it("throws a 422 AppError invalid_transition naming from, to and the allowed set", () => {
    let thrown: unknown;
    try {
      assertTransition("confirmed", "shipped");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const err = thrown as AppError;
    expect(err.code).toBe("invalid_transition");
    expect(err.status).toBe(422);
    expect(err.message).toContain("confirmed");
    expect(err.message).toContain("shipped");
    expect(err.details).toEqual({
      from: "confirmed",
      to: "shipped",
      allowed: ["processing", "cancelled"],
    });
  });

  it("reports an empty allowed set from a terminal state", () => {
    let thrown: unknown;
    try {
      assertTransition("cancelled", "confirmed");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).details).toEqual({
      from: "cancelled",
      to: "confirmed",
      allowed: [],
    });
  });
});

describe("MANUAL_ORDER_TRANSITIONS (staff allowlist, D12)", () => {
  it("is a strict subset of the transition table", () => {
    for (const { from, to } of MANUAL_ORDER_TRANSITIONS) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
    }
    const tableEdgeCount = Object.values(ORDER_TRANSITIONS).reduce(
      (sum, targets) => sum + targets.length,
      0,
    );
    expect(MANUAL_ORDER_TRANSITIONS.length).toBeLessThan(tableEdgeCount);
  });

  it("is exactly the five-step forward ladder to delivered (§4.8)", () => {
    expect(MANUAL_ORDER_TRANSITIONS).toEqual([
      { from: "confirmed", to: "processing" },
      { from: "processing", to: "ready_to_ship" },
      { from: "ready_to_ship", to: "shipped" },
      { from: "shipped", to: "out_for_delivery" },
      { from: "out_for_delivery", to: "delivered" },
    ]);
  });

  it("contains no cancel, RTO or return edges — those have their own doors or no writer", () => {
    const forbidden = new Set<OrderStatus>([
      "cancelled",
      "abandoned",
      "refunded",
      "rto_initiated",
      "rto_delivered",
      "return_requested",
      "return_picked",
      "confirmed", // confirmation belongs to the payment path, never a button
    ]);
    for (const { to } of MANUAL_ORDER_TRANSITIONS) {
      expect(forbidden.has(to), to).toBe(false);
    }
  });

  it("gives terminal states no manual moves", () => {
    for (const status of TERMINAL) {
      expect(MANUAL_ORDER_TRANSITIONS.some((t) => t.from === status), status).toBe(false);
    }
  });
});

describe("formatOrderNumber", () => {
  it("joins prefix and number with a dash: 'ORD' + 1001 → 'ORD-1001'", () => {
    expect(formatOrderNumber("ORD", 1001)).toBe("ORD-1001");
    expect(formatOrderNumber("ACME", 42)).toBe("ACME-42");
  });

  it("renders the bare number for an empty or whitespace prefix — no dangling dash", () => {
    expect(formatOrderNumber("", 1001)).toBe("1001");
    expect(formatOrderNumber("   ", 1001)).toBe("1001");
  });
});
