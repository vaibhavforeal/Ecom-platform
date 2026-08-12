import { z } from "zod";

import { BASE_CAPABILITIES, COMMON_STATUS_MAP, defineCarrier } from "./define";

/**
 * Direct carriers — contracted with the merchant, no reseller in front.
 *
 * Typically cheaper per shipment at volume, but each demands its own
 * commercial agreement, its own credential dance, and its own status
 * vocabulary. Merchants arriving in Phase B will already hold some of
 * these accounts and will refuse to give them up, which is the whole
 * reason the adapter interface exists.
 */

export const ekart = defineCarrier({
  code: "ekart",
  displayName: "Ekart Logistics",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    qcOnReturn: true, // strong doorstep QC — valuable for apparel returns
    multiPiece: true,
    insurance: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    shipment_created: { status: "created" },
    pickup_pending: { status: "pickup_scheduled" },
    dispatched: { status: "in_transit" },
    arrived_at_hub: { status: "in_transit" },
    arrived_at_destination_hub: { status: "reached_destination_hub" },
    delivery_attempted: { status: "delivery_failed", ndr: "customer_unavailable" },
    return_to_origin: { status: "rto_initiated" },
  },
  credentialSchema: z.object({
    merchantCode: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    /** Ekart issues separate credentials per environment. */
    environment: z.enum(["staging", "production"]).default("production"),
  }),
  setupNotes:
    "Ekart access is partner-gated: a commercial agreement with Flipkart's logistics arm " +
    "is required before API credentials are issued, and the docs are shared under that " +
    "agreement rather than published. Wire this adapter only once that contract and its " +
    "current API reference are in hand.",
});

export const delhivery = defineCarrier({
  code: "delhivery",
  displayName: "Delhivery",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    multiPiece: true,
    insurance: true,
    amendCodAmount: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    manifested: { status: "manifested" },
    not_picked: { status: "pickup_failed" },
    in_transit: { status: "in_transit" },
    pending: { status: "on_hold" },
    dispatched: { status: "out_for_delivery" },
    rto: { status: "rto_initiated" },
    dto: { status: "rto_in_transit" }, // delivery-to-origin leg
  },
  credentialSchema: z.object({
    apiToken: z.string().min(1),
    clientName: z.string().min(1),
    pickupLocationName: z.string().min(1),
  }),
  setupNotes:
    "Delhivery API token plus the registered client name and pickup location name, " +
    "both of which must match the values configured in the Delhivery panel exactly.",
});

export const bluedart = defineCarrier({
  code: "bluedart",
  displayName: "Blue Dart",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    multiPiece: true,
    insurance: true,
    sameDay: true, // premium air network
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    shipment_picked_up: { status: "picked_up" },
    in_transit_to_destination: { status: "in_transit" },
    arrived_at_service_area: { status: "reached_destination_hub" },
    undelivered: { status: "delivery_failed", ndr: "other" },
  },
  credentialSchema: z.object({
    licenceKey: z.string().min(1),
    loginId: z.string().min(1),
    customerCode: z.string().min(1),
    /** Blue Dart separates prepaid and COD product codes. */
    productCode: z.string().default("A"),
  }),
  setupNotes:
    "Blue Dart licence key, login id and customer code from your account manager. " +
    "The API is SOAP/XML on several endpoints, so this adapter needs an XML codec " +
    "rather than the shared JSON fetch helper.",
});

export const xpressbees = defineCarrier({
  code: "xpressbees",
  displayName: "XpressBees",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    multiPiece: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: {
    ...COMMON_STATUS_MAP,
    booked: { status: "manifested" },
    out_for_pickup: { status: "pickup_scheduled" },
    received_at_facility: { status: "in_transit" },
    at_destination_facility: { status: "reached_destination_hub" },
  },
  credentialSchema: z.object({
    email: z.string().email(),
    password: z.string().min(1),
    businessId: z.string().optional(),
  }),
  setupNotes: "XpressBees account credentials; auth yields a bearer token with a short TTL.",
});

export const dtdc = defineCarrier({
  code: "dtdc",
  displayName: "DTDC",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: { ...COMMON_STATUS_MAP },
  credentialSchema: z.object({
    accessToken: z.string().min(1),
    customerCode: z.string().min(1),
  }),
  setupNotes: "DTDC API access token and customer code from your account manager.",
});

export const ecomExpress = defineCarrier({
  code: "ecom_express",
  displayName: "Ecom Express",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    qcOnReturn: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: { ...COMMON_STATUS_MAP },
  credentialSchema: z.object({
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  setupNotes: "Ecom Express username and password issued with your merchant account.",
});
