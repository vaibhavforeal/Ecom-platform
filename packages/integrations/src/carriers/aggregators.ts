import { z } from "zod";

import { BASE_CAPABILITIES, COMMON_STATUS_MAP, defineCarrier } from "./define";

/**
 * Aggregators — resellers that sit in front of many carriers.
 *
 * They differ from direct carriers in ways the platform must respect:
 *
 *  · They run their own carrier assignment, so our rate shopping either
 *    consumes their per-carrier quotes or defers to their engine.
 *  · The parcel's real carrier is only known after booking, which is why
 *    `subCarrier` exists on quotes and bookings.
 *  · Their status vocabulary is their own, not the underlying carrier's,
 *    so one status map covers every carrier behind them.
 */

export const shiprocket = defineCarrier({
  code: "shiprocket",
  displayName: "Shiprocket",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "aggregator",
    reversePickup: true,
    qcOnReturn: true,
    multiPiece: true,
    insurance: true,
    amendCodAmount: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    awb_assigned: { status: "manifested" },
    label_generated: { status: "manifested" },
    pickup_error: { status: "pickup_failed" },
    out_for_pickup: { status: "pickup_scheduled" },
    in_transit_at_hub: { status: "in_transit" },
    misrouted: { status: "on_hold" },
    delivery_delayed: { status: "on_hold" },
    rto_acknowledged: { status: "rto_delivered" },
  },
  credentialSchema: z.object({
    email: z.string().email(),
    password: z.string().min(1),
    /** Numeric pickup location id registered in the Shiprocket panel. */
    pickupLocationId: z.string().optional(),
    channelId: z.string().optional(),
  }),
  setupNotes:
    "Shiprocket account credentials plus a registered pickup location. " +
    "Auth is a short-lived bearer token exchanged from email/password and must be " +
    "cached and refreshed rather than re-requested per call.",
});

export const shipmozo = defineCarrier({
  code: "shipmozo",
  displayName: "Shipmozo",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "aggregator",
    reversePickup: true,
    multiPiece: true,
    amendCodAmount: true,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    manifested: { status: "manifested" },
    order_placed: { status: "created" },
  },
  credentialSchema: z.object({
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
    warehouseId: z.string().optional(),
  }),
  setupNotes: "Shipmozo public/private API key pair and a registered warehouse id.",
});

export const nimbuspost = defineCarrier({
  code: "nimbuspost",
  displayName: "NimbusPost",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "aggregator",
    reversePickup: true,
    multiPiece: true,
  },
  statusMap: { ...COMMON_STATUS_MAP },
  credentialSchema: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
  setupNotes: "NimbusPost account credentials; auth yields a bearer token.",
});
