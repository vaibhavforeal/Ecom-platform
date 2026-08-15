/**
 * Inventory domain — PURE barrel, safe for client bundles.
 *
 * Everything that touches the database lives in ./server. This file must
 * not import @platform/db (whose root barrel pulls the postgres driver).
 */

/** Hard cap on one adjustment's magnitude; the route schema mirrors it. */
export const STOCK_ADJUSTMENT_MAX = 1_000_000;

/**
 * Threshold seeded onto a tracked variant saved without one.
 *
 * A null threshold means "never low", so a tracked variant without one is
 * invisible to the low-stock filter — including one sitting at zero. The
 * catalog write layer seeds this value whenever a variant is saved tracked
 * with a blank threshold (owner decision, 2026-08-15); untracked variants
 * keep the null. Matches the column's DEFAULT 2 in the schema.
 */
export const DEFAULT_LOW_STOCK_AT = 2;

/** Low-stock is a display state, not a schema fact: null threshold = never low. */
export function isLowStock(onHand: number, lowStockAt: number | null): boolean {
  return lowStockAt !== null && onHand <= lowStockAt;
}
