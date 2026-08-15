import type { WriteContext } from "../catalog/writes";
import type { BuyerContext } from "../cart/index";
import type { GatewayEvent } from "../payments/index";
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
  _ctx: BuyerContext,
  _cartId: string,
  _payload: CheckoutPayload,
): Promise<CheckoutStartResponse> {
  throw new Error("S0 stub: implemented by lot B-INT");
}

/**
 * §4.3 (D5): full-COD (and zero-total) confirmation at placement through
 * the SAME door as the webhook path — consumeStockWithin from ORDER
 * lines, transition to confirmed, coupon claim, invoice allocation +
 * insert IN THIS TX, markFirstOrder, events + audit. Called only by
 * startCheckout.
 */
export async function confirmCodOrder(_ctx: BuyerContext, _orderId: string): Promise<void> {
  throw new Error("S0 stub: implemented by lot B-INT");
}

/**
 * §4.4 TX-2/TX-3: processes one verified, already-recorded webhook event
 * idempotently (no-op on already-final state). Resolves on success —
 * the route returns 2xx only after this commits; throws → 5xx → gateway
 * redelivery.
 */
export async function confirmFromWebhookEvent(
  _ctx: BuyerContext,
  _args: { webhookEventId: string; event: GatewayEvent },
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B-INT");
}

/**
 * §4.6, both drivers (delayed job + sweep backstop, D10): order FOR
 * UPDATE — an in-flight webhook wins; still pending past expiry →
 * abandoned + releaseStock (own TX, idempotent bookkeeping — expiry is
 * read-side). Returns what happened so the sweep can log it.
 */
export async function expireCheckout(
  _ctx: BuyerContext,
  _orderId: string,
): Promise<{ outcome: "abandoned" | "still_pending" | "already_final" }> {
  throw new Error("S0 stub: implemented by lot B-INT");
}

/**
 * §4.7 console cancel (permission orders:cancel): transition table
 * permits confirmed/processing → cancelled only; restockWithin
 * (cancellation_restock, reference {type:'order', id}) + insert-once
 * refund intent when money was captured; refund job enqueued after
 * commit.
 */
export async function cancelOrder(
  _ctx: WriteContext,
  _orderId: string,
  _input: { reason?: string | null } = {},
): Promise<void> {
  throw new Error("S0 stub: implemented by lot B-INT");
}
