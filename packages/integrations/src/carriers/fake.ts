import { computeBillableWeight } from "@platform/core";
import type {
  BookedShipment,
  ServiceabilityQuote,
  ServiceabilityRequest,
  ShipmentRequest,
  TrackingEvent,
} from "@platform/core";
import { z } from "zod";

import { BASE_CAPABILITIES, COMMON_STATUS_MAP, defineCarrier } from "./define";
import { toTrackingEvent } from "./shared";

/**
 * A complete, in-memory carrier.
 *
 * This exists to prove the adapter contract end to end without a
 * network or a commercial agreement, and to give the rest of the
 * platform something real to develop and test fulfilment against long
 * before any vendor integration is signed off.
 *
 * It is also the reference implementation: a new carrier adapter should
 * read like this one with HTTP calls where the in-memory state is.
 */

type FakeShipment = {
  awb: string;
  request: ShipmentRequest;
  events: TrackingEvent[];
  cancelled: boolean;
};

const store = new Map<string, FakeShipment>();
/** Idempotency key → AWB. Booking twice must not create two shipments. */
const idempotency = new Map<string, string>();

export function resetFakeCarrier(): void {
  store.clear();
  idempotency.clear();
}

export function fakeShipments(): ReadonlyMap<string, FakeShipment> {
  return store;
}

let counter = 0;
function nextAwb(): string {
  counter += 1;
  return `FAKE${String(counter).padStart(10, "0")}`;
}

/** Deterministic pseudo-variation so quotes differ per lane, without RNG. */
function laneHash(from: string, to: string): number {
  let h = 0;
  for (const ch of `${from}-${to}`) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h;
}

const credentialSchema = z.object({
  apiKey: z.string().min(1),
  /** Lets tests force a serviceability miss. */
  unserviceablePincodes: z.array(z.string()).optional(),
});

type FakeCreds = z.infer<typeof credentialSchema>;

export const fake = defineCarrier({
  code: "fake",
  displayName: "Fake Carrier (development)",
  capabilities: {
    ...BASE_CAPABILITIES,
    kind: "direct",
    reversePickup: true,
    multiPiece: true,
    amendCodAmount: true,
    volumetricDivisor: 5000,
    weightSlabGrams: 500,
  },
  statusMap: { ...COMMON_STATUS_MAP },
  credentialSchema,
  setupNotes: "No setup — in-memory development carrier. Never register in production.",

  impl: {
    async verifyCredentials(creds) {
      const parsed = credentialSchema.safeParse(creds);
      return parsed.success
        ? { ok: true }
        : { ok: false, detail: "apiKey is required" };
    },

    async checkServiceability(
      creds: unknown,
      req: ServiceabilityRequest,
    ): Promise<ServiceabilityQuote[]> {
      const c = credentialSchema.parse(creds) as FakeCreds;
      if (c.unserviceablePincodes?.includes(req.toPincode)) return [];

      const weight = computeBillableWeight(req.pkg, {
        volumetricDivisor: 5000,
        weightSlabGrams: 500,
      });

      const h = laneHash(req.fromPincode, req.toPincode);
      const baseFreight = 4000 + Math.round((weight.billableWeightGrams / 500) * 1800);
      const codFee = req.paymentMode === "cod" ? Math.max(3000, Math.round(req.codAmountPaise * 0.012)) : 0;

      const surface: ServiceabilityQuote = {
        carrier: "fake",
        serviceCode: "surface",
        serviceLabel: "Surface",
        freightPaise: baseFreight,
        codFeePaise: codFee,
        totalPaise: baseFreight + codFee,
        billableWeightGrams: weight.billableWeightGrams,
        estimatedDays: 3 + (h % 4),
        codSupported: true,
      };

      const air: ServiceabilityQuote = {
        ...surface,
        serviceCode: "air",
        serviceLabel: "Air Express",
        freightPaise: Math.round(baseFreight * 1.8),
        totalPaise: Math.round(baseFreight * 1.8) + codFee,
        estimatedDays: 1 + (h % 2),
      };

      return [surface, air];
    },

    async createShipment(creds: unknown, req: ShipmentRequest): Promise<BookedShipment> {
      credentialSchema.parse(creds);

      // Idempotency is the whole point of this branch: a retried booking
      // after a timeout must return the original AWB, not book again.
      const existingAwb = idempotency.get(req.idempotencyKey);
      if (existingAwb) {
        const existing = store.get(existingAwb);
        if (existing) {
          return {
            carrier: "fake",
            awb: existing.awb,
            carrierShipmentId: existing.awb,
            labelUrl: `memory://label/${existing.awb}.pdf`,
            billableWeightGrams: req.quote.billableWeightGrams,
            chargedPaise: req.quote.totalPaise,
          };
        }
      }

      const awb = nextAwb();
      const shipment: FakeShipment = { awb, request: req, events: [], cancelled: false };

      shipment.events.push(
        toTrackingEvent({
          awb,
          rawStatus: "manifested",
          occurredAt: new Date(0),
          map: COMMON_STATUS_MAP,
        }),
      );

      store.set(awb, shipment);
      idempotency.set(req.idempotencyKey, awb);

      return {
        carrier: "fake",
        awb,
        carrierShipmentId: awb,
        labelUrl: `memory://label/${awb}.pdf`,
        billableWeightGrams: req.quote.billableWeightGrams,
        chargedPaise: req.quote.totalPaise,
      };
    },

    async cancelShipment(_creds: unknown, awb: string): Promise<void> {
      const s = store.get(awb);
      if (!s) throw new Error(`Unknown AWB ${awb}`);
      s.cancelled = true;
      s.events.push(
        toTrackingEvent({
          awb,
          rawStatus: "cancelled",
          occurredAt: new Date(1),
          map: COMMON_STATUS_MAP,
        }),
      );
    },

    async schedulePickup(_creds: unknown, awbs: string[]): Promise<{ pickupId: string }> {
      return { pickupId: `PICKUP-${awbs.length}-${awbs[0] ?? "none"}` };
    },

    async track(_creds: unknown, awb: string): Promise<TrackingEvent[]> {
      return store.get(awb)?.events ?? [];
    },

    async updateCodAmount(_creds: unknown, awb: string, amountPaise: number): Promise<void> {
      const s = store.get(awb);
      if (!s) throw new Error(`Unknown AWB ${awb}`);
      s.request = { ...s.request, codAmountPaise: amountPaise };
    },

    async parseWebhook(_creds: unknown, raw: unknown): Promise<TrackingEvent[]> {
      const payload = z
        .object({
          awb: z.string(),
          status: z.string(),
          occurredAt: z.string(),
          location: z.string().optional(),
        })
        .parse(raw);

      const event = toTrackingEvent({
        awb: payload.awb,
        rawStatus: payload.status,
        occurredAt: new Date(payload.occurredAt),
        location: payload.location,
        map: COMMON_STATUS_MAP,
      });

      store.get(payload.awb)?.events.push(event);
      return [event];
    },
  },
});

/** Drives a shipment through a scenario. Used by fulfilment tests. */
export function simulate(awb: string, statuses: string[], startMs = 1_000): void {
  const s = store.get(awb);
  if (!s) throw new Error(`Unknown AWB ${awb}`);

  statuses.forEach((status, i) => {
    s.events.push(
      toTrackingEvent({
        awb,
        rawStatus: status,
        occurredAt: new Date(startMs + i * 3_600_000),
        map: COMMON_STATUS_MAP,
      }),
    );
  });
}
