import type { CartStatus } from "@platform/db/schema";

/**
 * Cart — PURE barrel, safe for client bundles (the cart page renders
 * these view types). S0 SCHEMA SPINE: shapes FROZEN; lot B4 implements
 * the server side and may ADD view fields but never remove or rename.
 */

export type { CartStatus };

/** Mirrors the cart_lines CHECK (quantity > 0 AND quantity <= 100). */
export const CART_LINE_MAX_QUANTITY = 100;
/** Mirrors holdStock's per-hold line cap. */
export const CART_MAX_LINES = 100;

/**
 * Buyer-request context: tenant resolved from the Host, NEVER a payload;
 * there is no staff actor on the storefront. The ReservationContext
 * shape, shared by every buyer-facing server entry point.
 */
export type BuyerContext = { tenantId: string; requestId?: string | null };

export type CartViewLine = {
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  options: Record<string, string>;
  quantity: number;
  /** Live price at read time — carts never snapshot (blueprint line 365). */
  unitPricePaise: number;
  lineTotalPaise: number;
  /** null = untracked (cannot run out). Read-side hold filter applies. */
  available: number | null;
};

/** Read-only coupon preview — evaluation only, never a claim. */
export type CartCouponPreview = {
  code: string;
  applicable: boolean;
  discountPaise: number;
  freeShipping: boolean;
  /** PromotionRefusalReason when not applicable. */
  reason?: string;
};

export type CartView = {
  cartId: string;
  status: CartStatus;
  currency: string;
  lines: CartViewLine[];
  subtotalPaise: number;
  couponCode: string | null;
  couponPreview: CartCouponPreview | null;
};
