import type {
  BookedShipment,
  CarrierAdapter,
  CarrierCapabilities,
  CarrierCode,
  ServiceabilityQuote,
  StatusMap,
  TrackingEvent,
} from "@platform/core";
import type { ZodType } from "zod";

import { pendingIntegration } from "./shared";

/**
 * Adapter factory.
 *
 * Each carrier declares the parts that are genuinely carrier-specific
 * and that we can state accurately without vendor credentials —
 * capabilities, status vocabulary, credential shape — and overrides
 * whichever transport methods have been wired up.
 *
 * Anything not overridden throws `pendingIntegration` rather than
 * returning a convincing fake, so an unfinished adapter fails loudly at
 * the call site instead of marking orders shipped with no parcel behind
 * them.
 */

export type CarrierSpec = {
  code: CarrierCode;
  displayName: string;
  capabilities: CarrierCapabilities;
  /** Carrier status vocabulary → our normalised statuses. */
  statusMap: StatusMap;
  /** Shape of the credentials this carrier needs from the merchant. */
  credentialSchema: ZodType;
  /** What a merchant must obtain to connect this carrier. */
  setupNotes: string;
  /** Overrides for whatever transport is implemented. */
  impl?: Partial<CarrierAdapter>;
};

export type DefinedCarrier = CarrierAdapter & {
  readonly statusMap: StatusMap;
  readonly credentialSchema: ZodType;
  readonly setupNotes: string;
};

export function defineCarrier(spec: CarrierSpec): DefinedCarrier {
  const { code, impl = {} } = spec;

  const base: CarrierAdapter = {
    code,
    displayName: spec.displayName,
    capabilities: spec.capabilities,

    async verifyCredentials(creds) {
      const parsed = spec.credentialSchema.safeParse(creds);
      if (!parsed.success) {
        return { ok: false, detail: "Credentials do not match the expected shape." };
      }
      if (!impl.verifyCredentials) {
        return { ok: false, detail: `Live verification pending. ${spec.setupNotes}` };
      }
      return impl.verifyCredentials(creds);
    },

    async checkServiceability(_c, _r): Promise<ServiceabilityQuote[]> {
      return pendingIntegration(code, "checkServiceability", spec.setupNotes);
    },
    async createShipment(_c, _r): Promise<BookedShipment> {
      return pendingIntegration(code, "createShipment", spec.setupNotes);
    },
    async cancelShipment(): Promise<void> {
      return pendingIntegration(code, "cancelShipment", spec.setupNotes);
    },
    async schedulePickup(): Promise<{ pickupId: string }> {
      return pendingIntegration(code, "schedulePickup", spec.setupNotes);
    },
    async track(): Promise<TrackingEvent[]> {
      return pendingIntegration(code, "track", spec.setupNotes);
    },
    async parseWebhook(): Promise<TrackingEvent[]> {
      return pendingIntegration(code, "parseWebhook", spec.setupNotes);
    },
  };

  return Object.freeze({
    ...base,
    ...impl,
    // Never let an override change identity or declared capability.
    code,
    displayName: spec.displayName,
    capabilities: spec.capabilities,
    statusMap: spec.statusMap,
    credentialSchema: spec.credentialSchema,
    setupNotes: spec.setupNotes,
  }) as DefinedCarrier;
}

/** Reasonable defaults; carriers override what differs. */
export const BASE_CAPABILITIES: CarrierCapabilities = {
  kind: "direct",
  cod: true,
  prepaid: true,
  reversePickup: false,
  qcOnReturn: false,
  multiPiece: false,
  insurance: false,
  amendCodAmount: false,
  sameDay: false,
  volumetricDivisor: 5000,
  weightSlabGrams: 500,
  webhooks: true,
};

/**
 * Status vocabulary shared by most Indian carriers. Individual adapters
 * extend or override it; the keyword fallback in `translateStatus`
 * catches whatever neither covers.
 */
export const COMMON_STATUS_MAP: StatusMap = {
  pickup_scheduled: { status: "pickup_scheduled" },
  pickup_generated: { status: "pickup_scheduled" },
  pickup_exception: { status: "pickup_failed" },
  pickup_cancelled: { status: "pickup_failed" },
  picked_up: { status: "picked_up" },
  in_transit: { status: "in_transit" },
  shipped: { status: "in_transit" },
  reached_destination: { status: "reached_destination_hub" },
  out_for_delivery: { status: "out_for_delivery" },
  delivered: { status: "delivered" },
  cancelled: { status: "cancelled" },
  lost: { status: "lost" },
  damaged: { status: "damaged" },
  rto_initiated: { status: "rto_initiated" },
  rto_in_transit: { status: "rto_in_transit" },
  rto_delivered: { status: "rto_delivered" },

  // NDR codes carry a reason as well as a status. Getting these right
  // is what decides auto-reattempt versus asking the customer.
  undelivered_customer_not_available: {
    status: "delivery_failed",
    ndr: "customer_unavailable",
  },
  undelivered_customer_refused: { status: "delivery_failed", ndr: "customer_refused" },
  undelivered_incorrect_address: { status: "delivery_failed", ndr: "address_incorrect" },
  undelivered_incomplete_address: { status: "delivery_failed", ndr: "address_incomplete" },
  undelivered_cod_not_ready: { status: "delivery_failed", ndr: "cod_amount_unavailable" },
  undelivered_office_closed: { status: "delivery_failed", ndr: "premises_closed" },
  undelivered_out_of_delivery_area: {
    status: "delivery_failed",
    ndr: "out_of_delivery_area",
  },
  undelivered_consignee_shifted: { status: "delivery_failed", ndr: "consignee_shifted" },
  undelivered_reschedule_requested: {
    status: "delivery_failed",
    ndr: "customer_requested_reschedule",
  },
};
