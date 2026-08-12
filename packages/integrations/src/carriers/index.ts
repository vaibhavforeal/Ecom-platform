import type { CarrierCode } from "@platform/core";

import { nimbuspost, shipmozo, shiprocket } from "./aggregators";
import { bluedart, delhivery, dtdc, ecomExpress, ekart, xpressbees } from "./direct";
import { fake } from "./fake";
import type { DefinedCarrier } from "./define";

export * from "./define";
export * from "./shared";
export { shiprocket, shipmozo, nimbuspost };
export { ekart, delhivery, bluedart, xpressbees, dtdc, ecomExpress };
export { fake, resetFakeCarrier, simulate, fakeShipments } from "./fake";

/**
 * The carrier registry.
 *
 * Nothing outside this file knows which carriers exist. Adding a
 * provider means adding one entry here — no changes to orders,
 * checkout, the console, or any other adapter.
 */
const REGISTRY: Record<CarrierCode, DefinedCarrier> = {
  shiprocket,
  shipmozo,
  nimbuspost,
  ekart,
  delhivery,
  bluedart,
  xpressbees,
  dtdc,
  ecom_express: ecomExpress,
  fake,
};

export function getCarrier(code: CarrierCode): DefinedCarrier {
  const carrier = REGISTRY[code];
  if (!carrier) throw new Error(`Unknown carrier: ${code}`);
  return carrier;
}

/**
 * Carriers a merchant may connect.
 *
 * The fake carrier is excluded outside development — a production
 * merchant must never be able to select an in-memory carrier that
 * silently swallows real parcels.
 */
export function availableCarriers(): DefinedCarrier[] {
  const all = Object.values(REGISTRY);
  return process.env.NODE_ENV === "production" ? all.filter((c) => c.code !== "fake") : all;
}

export function carriersByKind(kind: "aggregator" | "direct"): DefinedCarrier[] {
  return availableCarriers().filter((c) => c.capabilities.kind === kind);
}
