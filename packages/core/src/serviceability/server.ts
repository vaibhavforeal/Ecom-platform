import { and, eq, inArray, storeSettings, withTenant } from "@platform/db";
import type { CheckoutPaymentMode, Tx } from "@platform/db";

import { AppError } from "../errors";
import type { BuyerContext } from "../cart/index";
import { PINCODE_RE, SHIPPING_SETTINGS_KEYS, computeShippingFeePaise } from "./index";
import type { PincodePolicy } from "./index";

/**
 * Serviceability — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN;
 * bodies implemented by lot B4.
 */

export type ServiceabilityResult =
  | { serviceable: true; mode: PincodePolicy["mode"] }
  | { serviceable: false; mode: PincodePolicy["mode"]; reason: "pincode_unserviceable" };

/**
 * Parse the stored jsonb into a policy, defaulting to {mode:"all"}.
 *
 * A malformed value also falls back to "all" WITH a structured warning
 * rather than refusing checkout: nothing in Phase 2 writes this key, so a
 * bad value means a hand edit, and bricking every checkout over it is a
 * worse failure than over-serving until the log is read.
 */
function parsePincodePolicy(value: unknown, tenantId: string): PincodePolicy {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as { mode?: unknown; allowedPrefixes?: unknown };
    if (candidate.mode === "all") return { mode: "all" };
    if (candidate.mode === "carrier") return { mode: "carrier" };
    if (
      candidate.mode === "list" &&
      Array.isArray(candidate.allowedPrefixes) &&
      candidate.allowedPrefixes.every((p) => typeof p === "string" && /^[1-9][0-9]{0,5}$/.test(p))
    ) {
      return { mode: "list", allowedPrefixes: candidate.allowedPrefixes as string[] };
    }
  }
  if (value !== undefined) {
    console.warn(
      JSON.stringify({
        level: "warn",
        tenantId,
        message: `Malformed ${SHIPPING_SETTINGS_KEYS.pincodePolicy} setting; defaulting to {mode:"all"}`,
      }),
    );
  }
  return { mode: "all" };
}

async function readSettings(tx: Tx, tenantId: string, keys: string[]): Promise<Map<string, unknown>> {
  const rows = await tx
    .select({ key: storeSettings.key, value: storeSettings.value })
    .from(storeSettings)
    .where(and(eq(storeSettings.tenantId, tenantId), inArray(storeSettings.key, keys)));
  return new Map(rows.map((r) => [r.key, r.value]));
}

/**
 * Applies the store_settings pincode policy (default {mode:"all"});
 * 'carrier' mode consults serviceability_cache via the carrier registry,
 * cache-first, so checkout never blocks on a carrier API.
 *
 * PHASE 2 SCOPE (per the B4 task, narrowing §1.10): no carrier adapter
 * has a live serviceability transport yet (every one still throws
 * pendingIntegration), so 'carrier' mode refuses with a typed 422
 * `not_supported_yet` instead of pretending to consult a registry that
 * cannot answer. The frozen result type is untouched — the refusal is an
 * AppError, exactly like every other typed refusal on the buyer path.
 * Phase 3 replaces that throw with the cache-first registry lookup.
 *
 * `paymentMode` is part of the frozen signature for Phase 3 (COD
 * serviceability differs per carrier); the Phase 2 policy ignores it.
 */
export async function checkServiceability(
  ctx: BuyerContext,
  input: { pincode: string; paymentMode: CheckoutPaymentMode },
): Promise<ServiceabilityResult> {
  if (typeof input.pincode !== "string" || !PINCODE_RE.test(input.pincode)) {
    throw new AppError({
      code: "invalid_payload",
      message: `Malformed pincode ${JSON.stringify(input.pincode)}`,
      status: 422,
      publicMessage: "Enter a valid 6-digit pincode.",
      details: { issues: [{ path: "pincode", message: "Enter a valid 6-digit pincode." }] },
    });
  }

  const policy = await withTenant(ctx.tenantId, async (tx) => {
    const settings = await readSettings(tx, ctx.tenantId, [SHIPPING_SETTINGS_KEYS.pincodePolicy]);
    return parsePincodePolicy(settings.get(SHIPPING_SETTINGS_KEYS.pincodePolicy), ctx.tenantId);
  });

  switch (policy.mode) {
    case "all":
      return { serviceable: true, mode: "all" };
    case "list": {
      const serviceable = policy.allowedPrefixes.some((prefix) => input.pincode.startsWith(prefix));
      return serviceable
        ? { serviceable: true, mode: "list" }
        : { serviceable: false, mode: "list", reason: "pincode_unserviceable" };
    }
    case "carrier":
      throw new AppError({
        code: "not_supported_yet",
        message: "shipping.pincode_policy mode 'carrier' has no live carrier transport in Phase 2",
        status: 422,
        publicMessage:
          "Carrier-based delivery checks are not available yet. Please contact the store.",
      });
  }
}

/**
 * The §1.10 shipping-fee settings, read once for a checkout: flat fee
 * (default 0) waived at/above the free-shipping threshold (default none).
 * Returns the raw settings alongside the computed fee so checkout-start
 * (B-INT) can snapshot both without a second read. Additive B4 export —
 * not part of the frozen S0 surface.
 */
export async function getShippingFeeQuote(
  ctx: BuyerContext,
  subtotalPaise: number,
): Promise<{ feePaise: number; flatFeePaise: number; freeAbovePaise: number | null }> {
  const { flatFeePaise, freeAbovePaise } = await withTenant(ctx.tenantId, async (tx) => {
    const settings = await readSettings(tx, ctx.tenantId, [
      SHIPPING_SETTINGS_KEYS.flatFeePaise,
      SHIPPING_SETTINGS_KEYS.freeAbovePaise,
    ]);
    const readPaise = (key: string): number | null => {
      const value = settings.get(key);
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    return {
      flatFeePaise: readPaise(SHIPPING_SETTINGS_KEYS.flatFeePaise) ?? 0,
      freeAbovePaise: readPaise(SHIPPING_SETTINGS_KEYS.freeAbovePaise),
    };
  });

  const feePaise = computeShippingFeePaise(subtotalPaise, { flatFeePaise, freeAbovePaise });
  return { feePaise, flatFeePaise, freeAbovePaise };
}
