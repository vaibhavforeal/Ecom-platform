import { Queue } from "bullmq";
import Redis from "ioredis";

/**
 * Queue definitions.
 *
 * THE CONTRACT: every job payload carries `tenantId`, and every handler's
 * first act is withTenant(job.data.tenantId, …). A job that infers its
 * tenant from anything else — a lookup, a default, "the only tenant" —
 * is a cross-tenant bug waiting for a busy Diwali evening.
 *
 * `TenantJob` makes that contract a type error to break.
 */

export type TenantJob<T = Record<string, unknown>> = T & { tenantId: string };

export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // BullMQ requires this
});

/**
 * Defaults chosen for external-API work, which is most of what this
 * fleet does. Exponential backoff with a long tail rides out a courier
 * or gateway outage; failed jobs are RETAINED so a human can inspect the
 * dead letters rather than discovering the loss from a customer.
 */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: false,
};

export const QUEUE_NAMES = {
  domains: "domains",
  notifications: "notifications",
} as const;

export const domainsQueue = new Queue<TenantJob<{ domainId: string }>>(
  QUEUE_NAMES.domains,
  { connection, defaultJobOptions },
);

export async function closeQueues(): Promise<void> {
  await domainsQueue.close();
  await connection.quit();
}
