/**
 * Inventory domain — PURE barrel, safe for client bundles.
 *
 * Everything that touches the database lives in ./server. This file must
 * not import @platform/db (whose root barrel pulls the postgres driver).
 */

/** Hard cap on one adjustment's magnitude; the route schema mirrors it. */
export const STOCK_ADJUSTMENT_MAX = 1_000_000;

/** Low-stock is a display state, not a schema fact: null threshold = never low. */
export function isLowStock(onHand: number, lowStockAt: number | null): boolean {
  return lowStockAt !== null && onHand <= lowStockAt;
}
