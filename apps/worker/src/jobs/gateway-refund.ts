import {
  getRefundForProcessing,
  unsealGatewayCredentials,
} from "@platform/core/payments/server";
import { getPaymentAdapter } from "@platform/integrations/payments";
import { and, eq, isNull, refunds, withTenant } from "@platform/db";

/**
 * Payments-queue consumer (spec §4.7.2): the outbound refund call runs
 * HERE, never in a web request. BullMQ's defaultJobOptions supply the
 * exponential backoff + capped retries + retained dead letters.
 *
 * CLAIM-FIRST discipline: the row moves pending → processing BEFORE the
 * gateway is called, and the gateway ref is recorded after. Razorpay's
 * refund API does NOT dedupe on our idempotency key (the adapter can
 * only send it as `receipt`, a reference field), so a replayed call
 * after a successful-but-unrecorded refund would move money twice — or
 * 4xx into the dead letter with the buyer's money already returned and
 * no gateway ref stored. A row seen 'processing' with NO gateway ref is
 * therefore never re-sent: the previous run may have died between the
 * call and the record, and only reconciliation (Phase 3) can say which
 * side of the call it died on. This job logs that state loudly and
 * leaves the row; the console order page shows the stuck status.
 *
 * Terminal state ('processed') arrives via the refund.processed webhook
 * (§4.4), not from this job — this job only carries the intent to the
 * gateway.
 */

export type GatewayRefundJob = { tenantId: string; refundId: string };

export async function processGatewayRefund(
  data: GatewayRefundJob,
): Promise<{ status: string; gatewayRefundId?: string }> {
  const { tenantId, refundId } = data;

  const refund = await getRefundForProcessing(tenantId, refundId);
  if (!refund) return { status: "missing" };

  if (refund.status === "processing" && refund.gatewayRefundId === null) {
    // Claimed but never recorded: ambiguous whether the gateway call
    // happened. Do NOT re-call (see header). Returning (not throwing)
    // keeps BullMQ from burning retries on a state no retry can fix.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "refund.needs_reconciliation",
        tenantId,
        refundId,
        orderId: refund.orderId,
        paymentId: refund.paymentId,
        amountPaise: refund.amountPaise,
        message:
          "refund is 'processing' with no gateway_refund_id — a previous run died " +
          "between the gateway call and recording the ref; NOT re-calling the " +
          "gateway (it does not dedupe refunds). Reconcile manually against the " +
          "gateway dashboard.",
      }),
    );
    return { status: "needs_reconciliation" };
  }
  // Idempotent replay: only a 'pending' intent goes out. A job retried
  // after the ref was recorded (or racing the processed webhook) no-ops.
  if (refund.status !== "pending") return { status: `already_${refund.status}` };

  if (!refund.account) {
    // Retryable: the merchant may re-enable a gateway; backoff + the
    // retained failed job make the stall visible instead of silent.
    throw new Error(`refund ${refundId}: no enabled payment account for tenant ${tenantId}`);
  }
  if (!refund.gatewayPaymentId) {
    throw new Error(`refund ${refundId}: payment ${refund.paymentId} has no gateway payment id`);
  }

  // Everything that can fail locally (adapter lookup, credential unseal)
  // happens BEFORE the claim, so a local failure stays retryable instead
  // of stranding the row in 'processing'.
  const adapter = getPaymentAdapter(refund.account.providerCode);
  const creds = await unsealGatewayCredentials(tenantId, refund.account);

  // CLAIM (pending → processing) immediately before the outbound call.
  // Zero rows means another run already claimed it — stand down.
  const claimed = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .update(refunds)
      .set({ status: "processing", updatedAt: new Date() })
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.id, refundId),
          eq(refunds.status, "pending"),
        ),
      )
      .returning({ id: refunds.id });
    return rows.length > 0;
  });
  if (!claimed) return { status: "already_claimed" };

  const { gatewayRefundId } = await adapter.refund(creds, {
    gatewayPaymentId: refund.gatewayPaymentId,
    amountPaise: refund.amountPaise,
    // The refund intent's id rides along as the gateway's reference
    // field — traceable at the gateway, but NOT a dedupe key there;
    // the claim above is what makes the call at-most-once.
    idempotencyKey: refundId,
  });

  // Record the ref. Guarded on ref-still-null: the refund.processed
  // webhook matches rows BY gateway ref, so it cannot have touched this
  // row while the ref was unrecorded, and once recorded this write must
  // not clobber a webhook-driven terminal transition's timestamp.
  await withTenant(tenantId, (tx) =>
    tx
      .update(refunds)
      .set({ gatewayRefundId, updatedAt: new Date() })
      .where(
        and(
          eq(refunds.tenantId, tenantId),
          eq(refunds.id, refundId),
          isNull(refunds.gatewayRefundId),
        ),
      ),
  );
  return { status: "processing", gatewayRefundId };
}
