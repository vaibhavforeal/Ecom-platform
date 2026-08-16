import { expireCheckout } from "@platform/core/checkout/server";
import type { OrderDomainEvent } from "@platform/core/orders";
import { and, eq, orders, withTenant } from "@platform/db";

import { ordersQueue } from "../queues";

/**
 * Orders-queue consumer (spec §5.2 + §4.6).
 *
 * Two job shapes ride this queue:
 *  · `checkout.expire` — the delayed per-order expiry driver (D10's
 *    precision half; the scheduled sweep is the backstop). The handler's
 *    first act is tenant-scoped work via expireCheckout's withTenant.
 *  · every `order.*` / `payment.*` / `promotion.*` domain event
 *    (jobId = order_events.id, D11) — Phase 2's consumer is a
 *    structured-log seam; Phase 3/4 messaging and analytics hang off it.
 */

export type CheckoutExpireJob = { tenantId: string; orderId: string };

type OrdersJob = {
  name: string;
  data: CheckoutExpireJob | OrderDomainEvent;
};

export async function handleOrdersJob(job: OrdersJob): Promise<Record<string, unknown>> {
  if (job.name === "checkout.expire") {
    const { tenantId, orderId } = job.data as CheckoutExpireJob;
    const { outcome } = await expireCheckout({ tenantId }, orderId);

    if (outcome === "still_pending") {
      // A payment retry extended expires_at — re-enqueue at the new
      // expiry (§4.6). The jobId carries the instant, so extensions are
      // fresh jobs rather than Redis-deduped ghosts.
      const expiresAt = await withTenant(tenantId, async (tx) => {
        const [row] = await tx
          .select({ expiresAt: orders.expiresAt })
          .from(orders)
          .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
          .limit(1);
        return row?.expiresAt ?? null;
      });
      if (expiresAt) {
        const delay = Math.max(expiresAt.getTime() - Date.now(), 0) + 5 * 60_000;
        await ordersQueue.add(
          "checkout.expire",
          { tenantId, orderId },
          { delay, jobId: `checkout-expire:${orderId}:${expiresAt.getTime()}` },
        );
      }
    }
    return { kind: "checkout.expire", tenantId, orderId, outcome };
  }

  // Domain-event log seam: the order_events row is the durable record;
  // this consumer just makes the delivery visible per tenant.
  const event = job.data as OrderDomainEvent;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "order.domain_event",
      tenantId: event.tenantId,
      orderId: event.orderId,
      name: event.event,
      orderEventId: event.orderEventId,
      occurredAt: event.occurredAt,
    }),
  );
  return { kind: "domain_event", name: event.event, tenantId: event.tenantId };
}
