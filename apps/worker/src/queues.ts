import { Queue } from "bullmq";
import Redis from "ioredis";

import { QUEUE_NAMES, defaultJobOptions } from "@platform/core";

/**
 * Queue definitions.
 *
 * THE CONTRACT: every job payload carries `tenantId`, and every handler's
 * first act is withTenant(job.data.tenantId, …). A job that infers its
 * tenant from anything else — a lookup, a default, "the only tenant" —
 * is a cross-tenant bug waiting for a busy Diwali evening. The single
 * exception is the maintenance queue, whose jobs are platform-wide by
 * design and carry no tenantId.
 *
 * `TenantJob` makes that contract a type error to break.
 *
 * The names and retry policy live in `@platform/core` because producers
 * (the console) and this consumer must agree on them without importing
 * each other.
 */

export type TenantJob<T = Record<string, unknown>> = T & { tenantId: string };

export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // BullMQ requires this
});

export { QUEUE_NAMES, defaultJobOptions };

export const domainsQueue = new Queue<TenantJob<{ domainId: string }>>(
  QUEUE_NAMES.domains,
  { connection, defaultJobOptions },
);

export const mediaQueue = new Queue<TenantJob<{ mediaId: string }>>(
  QUEUE_NAMES.media,
  { connection, defaultJobOptions },
);

/**
 * Platform maintenance — the ONE queue whose jobs carry no tenantId.
 * A sweep fans out across tenants itself (withTenant per tenant); see
 * jobs/sweep-reservations.ts for why a cross-tenant query cannot work.
 */
export const maintenanceQueue = new Queue<Record<string, never>>(
  QUEUE_NAMES.maintenance,
  { connection, defaultJobOptions },
);

/**
 * Order domain events (jobId = order_events.id, D11) + the delayed
 * `checkout.expire` jobs. The worker also PRODUCES onto this queue: a
 * still-pending expiry re-enqueues itself at the extended expires_at.
 */
export const ordersQueue = new Queue<TenantJob<Record<string, unknown>>>(
  QUEUE_NAMES.orders,
  { connection, defaultJobOptions },
);

/** Outbound gateway work — refunds run here, never in a web request. */
export const paymentsQueue = new Queue<TenantJob<{ refundId: string }>>(
  QUEUE_NAMES.payments,
  { connection, defaultJobOptions },
);

export async function closeQueues(): Promise<void> {
  await domainsQueue.close();
  await mediaQueue.close();
  await maintenanceQueue.close();
  await ordersQueue.close();
  await paymentsQueue.close();
  await connection.quit();
}
