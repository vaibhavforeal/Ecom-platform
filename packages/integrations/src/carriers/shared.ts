import { CarrierError, eventSignature, translateStatus } from "@platform/core";
import type {
  CarrierCode,
  StatusMap,
  TrackingEvent,
} from "@platform/core";

/**
 * Shared plumbing for carrier adapters.
 *
 * Every carrier gets retries, timeouts, error classification and status
 * translation from here, so an adapter only has to describe what makes
 * that carrier different.
 */

export type HttpOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
};

/**
 * Which HTTP failures are worth retrying.
 *
 * 429 and 5xx are transient. 4xx is not — retrying a rejected booking
 * just burns rate limit, and retrying a *successful* booking that
 * merely returned an odd status code books the parcel twice and bills
 * the merchant twice. When in doubt, do not retry a write.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status < 600);
}

export async function carrierFetch(
  carrier: CarrierCode,
  url: string,
  init: RequestInit & HttpOptions = {},
): Promise<unknown> {
  const { timeoutMs = 15_000, query, headers, ...rest } = init;

  const target = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) target.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(target, {
      ...rest,
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new CarrierError({
        carrier,
        message: `HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`,
        retryable: isRetryableStatus(res.status),
        carrierCode: String(res.status),
      });
    }

    return body;
  } catch (err) {
    if (err instanceof CarrierError) throw err;
    // A timeout on a booking call is the dangerous case: the shipment
    // may well have been created. Marked retryable only because the
    // caller pairs every write with an idempotency key.
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new CarrierError({
      carrier,
      message: aborted ? `Timed out after ${timeoutMs}ms` : String(err),
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Build a normalised TrackingEvent from a carrier's raw scan record. */
export function toTrackingEvent(input: {
  awb: string;
  rawStatus: string;
  rawDescription?: string;
  occurredAt: Date;
  location?: string;
  map: StatusMap;
  onUnmapped?: (raw: string) => void;
}): TrackingEvent {
  const { status, ndr, matched } = translateStatus(input.rawStatus, input.map);

  // Unmapped statuses are reported, not swallowed. Carriers add codes
  // without notice, and a silent fallback is how a platform ends up
  // showing "on hold" for a delivered parcel.
  if (matched !== "map") input.onUnmapped?.(input.rawStatus);

  return {
    awb: input.awb,
    status,
    ndrReason: ndr,
    rawStatus: input.rawStatus,
    rawDescription: input.rawDescription,
    location: input.location,
    occurredAt: input.occurredAt,
    signature: eventSignature({
      awb: input.awb,
      rawStatus: input.rawStatus,
      occurredAt: input.occurredAt,
      location: input.location,
    }),
  };
}

/**
 * Marks an adapter method that needs vendor documentation and live
 * credentials before it can be written honestly.
 *
 * These throw rather than returning plausible-looking fakes on purpose:
 * a stub that silently "succeeds" would let an order be marked shipped
 * with no parcel behind it.
 */
export function pendingIntegration(carrier: CarrierCode, method: string, needs: string): never {
  throw new CarrierError({
    carrier,
    message:
      `${method}() is not wired up yet. Needs: ${needs}. ` +
      `The adapter contract, status map and capabilities are complete — ` +
      `only the HTTP calls remain, and those must be written against the ` +
      `vendor's current API docs rather than guessed.`,
    retryable: false,
  });
}
