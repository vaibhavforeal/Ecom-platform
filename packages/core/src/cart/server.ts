import type { BuyerContext, CartView } from "./index";

/**
 * Cart — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B4.
 *
 * Rules the implementation must keep: every variant id from a payload is
 * verified with a visibility SELECT inside the tx (FK ≠ tenancy); prices
 * are read live, never stored on cart_lines; availability reads keep the
 * `expires_at > now()` hold filter; cart reads are NEVER unstable_cache'd.
 */

/**
 * Returns the existing active cart or creates one. The id goes into an
 * httpOnly cookie scoped to the storefront host — a cookie replayed
 * against another tenant's host matches zero rows via RLS.
 */
export async function getOrCreateCart(
  _ctx: BuyerContext,
  _cartId: string | null,
): Promise<{ cartId: string; created: boolean }> {
  throw new Error("S0 stub: implemented by lot B4");
}

/**
 * Upsert one line (ON CONFLICT (tenant_id, cart_id, variant_id) DO
 * UPDATE); quantity 0 removes. Refuses `insufficient_stock` (422) when
 * requested > available for tracked variants. Touches carts.updated_at.
 */
export async function upsertLine(
  _ctx: BuyerContext,
  _cartId: string,
  _input: { variantId: string; quantity: number },
): Promise<CartView> {
  throw new Error("S0 stub: implemented by lot B4");
}

export async function removeLine(
  _ctx: BuyerContext,
  _cartId: string,
  _variantId: string,
): Promise<CartView> {
  throw new Error("S0 stub: implemented by lot B4");
}

/** Live prices + availability + read-only coupon preview. Null: no such cart. */
export async function getCartView(
  _ctx: BuyerContext,
  _cartId: string,
): Promise<CartView | null> {
  throw new Error("S0 stub: implemented by lot B4");
}

/** Stores the uppercased code; evaluation stays read-only until confirm. */
export async function setCartCoupon(
  _ctx: BuyerContext,
  _cartId: string,
  _code: string,
): Promise<CartView> {
  throw new Error("S0 stub: implemented by lot B4");
}

export async function clearCartCoupon(_ctx: BuyerContext, _cartId: string): Promise<CartView> {
  throw new Error("S0 stub: implemented by lot B4");
}
