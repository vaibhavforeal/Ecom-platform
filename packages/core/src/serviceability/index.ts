/**
 * Serviceability — PURE barrel, safe for client bundles (the checkout
 * page validates pincodes client-side with the same regex).
 *
 * S0 SCHEMA SPINE: signatures FROZEN; bodies and the prefix map data are
 * implemented by lot B4.
 */

export const PINCODE_RE = /^[1-9][0-9]{5}$/;

/**
 * Static 2-digit pincode prefix → allowed GST state codes (design D3).
 * Cross-checks the buyer-typed stateCode so the CGST/SGST-vs-IGST fork
 * never trusts typed input alone. Prefixes that legitimately span states
 * list EVERY legitimate code — safety over precision, never a false
 * refusal. An unknown prefix returns [] and the caller accepts the typed
 * state (fail-open on the cross-check ONLY; the serviceability policy
 * still applies).
 *
 * S0 note: map data populated by lot B4.
 */
export const PINCODE_PREFIX_STATES: Record<string, readonly string[]> = {};

/** [] = unknown prefix → do NOT refuse (log only). Invalid shape refused first. */
export function statesForPincode(_pincode: string): readonly string[] {
  throw new Error("S0 stub: implemented by lot B4");
}

/**
 * store_settings 'shipping.pincode_policy' (design D13 — no
 * shipping_zones table in Phase 2). Default when unset: {mode:"all"} —
 * checkout works day one. 'carrier' consults the existing
 * serviceability_cache via the carrier registry, cache-first.
 */
export type PincodePolicy =
  | { mode: "all" }
  | { mode: "carrier" }
  | { mode: "list"; allowedPrefixes: string[] };

/** store_settings keys — defined once so reader and writer cannot drift. */
export const SHIPPING_SETTINGS_KEYS = {
  pincodePolicy: "shipping.pincode_policy",
  flatFeePaise: "shipping.flat_fee_paise",
  freeAbovePaise: "shipping.free_above_paise",
} as const;
