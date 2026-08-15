import {
  getRefundForProcessing,
  markRefundProcessing,
  unsealGatewayCredentials,
} from "@platform/core/payments/server";
import { getPaymentAdapter } from "@platform/integrations/payments";

/**
 * Payments-queue consumer (spec §4.7.2): the outbound refund call runs
 * HERE, never in a web request. BullMQ's defaultJobOptions supply the
 * exponential backoff + capped retries + retained dead letters; the
 * refunds row's insert-once UNIQUE (D6) plus the adapter idempotency key
 * (= refundId) make a replayed job safe at both ends.
 *
 * Terminal state ('processed') arrives via the refund.processed webhook
 * (§4.4), not from this job — this job only carries the intent to the
 * gateway and marks it 'processing'.
 */

export type GatewayRefundJob = { tenantId: string; refundId: string };

export async function processGatewayRefund(
  data: GatewayRefundJob,
): Promise<{ status: string; gatewayRefundId?: string }> {
  const { tenantId, refundId } = data;

  const refund = await getRefundForProcessing(tenantId, refundId);
  if (!refund) return { status: "missing" };
  // Idempotent replay: only a 'pending' intent goes out. A job retried
  // after markRefundProcessing (or racing the processed webhook) no-ops.
  if (refund.status !== "pending") return { status: `already_${refund.status}` };

  if (!refund.account) {
    // Retryable: the merchant may re-enable a gateway; backoff + the
    // retained failed job make the stall visible instead of silent.
    throw new Error(`refund ${refundId}: no enabled payment account for tenant ${tenantId}`);
  }
  if (!refund.gatewayPaymentId) {
    throw new Error(`refund ${refundId}: payment ${refund.paymentId} has no gateway payment id`);
  }

  const adapter = getPaymentAdapter(refund.account.providerCode);
  const creds = await unsealGatewayCredentials(tenantId, refund.account);
  const { gatewayRefundId } = await adapter.refund(creds, {
    gatewayPaymentId: refund.gatewayPaymentId,
    amountPaise: refund.amountPaise,
    // The refund intent's id IS the idempotency key — a retried call is
    // traceable at the gateway and deduped platform-side by the UNIQUE.
    idempotencyKey: refundId,
  });

  await markRefundProcessing(tenantId, { refundId, gatewayRefundId });
  return { status: "processing", gatewayRefundId };
}
