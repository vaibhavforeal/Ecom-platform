import type { CheckoutPaymentMode } from "@platform/db";

import type { BuyerContext } from "../cart/index";
import type { PincodePolicy } from "./index";

/**
 * Serviceability — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN;
 * bodies implemented by lot B4.
 */

export type ServiceabilityResult =
  | { serviceable: true; mode: PincodePolicy["mode"] }
  | { serviceable: false; mode: PincodePolicy["mode"]; reason: "pincode_unserviceable" };

/**
 * Applies the store_settings pincode policy (default {mode:"all"});
 * 'carrier' mode consults serviceability_cache via the carrier registry,
 * cache-first, so checkout never blocks on a carrier API.
 */
export async function checkServiceability(
  _ctx: BuyerContext,
  _input: { pincode: string; paymentMode: CheckoutPaymentMode },
): Promise<ServiceabilityResult> {
  throw new Error("S0 stub: implemented by lot B4");
}
