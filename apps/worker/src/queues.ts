import { Queue } from "bullmq";
import Redis from "ioredis";

import { QUEUE_NAMES, defaultJobOptions } from "@platform/core";

/**
 * Queue definitions.
 *
 * THE CONTRACT: every job payload carries `tenantId`, and every handler's
 * first act is withTenant(job.data.tenantId, …). A job that infers its
 * tenant from anything else — a lookup, a default, "the only tenant" —
 * is a cross-tenant bug waiting for a busy Diwali evening.
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

export async function closeQueues(): Promise<void> {
  await domainsQueue.close();
  await mediaQueue.close();
  await connection.quit();
}
