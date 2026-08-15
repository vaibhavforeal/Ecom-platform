/**
 * Background queue names and job policy.
 *
 * These live here rather than in the worker because a queue has two
 * ends: the console produces jobs, the worker consumes them, and neither
 * may import the other. A queue name that agrees on only one side is a
 * job that is enqueued and never run — with no error anywhere, because
 * Redis is perfectly happy to hold a list nobody is listening to.
 *
 * No BullMQ import here: this is the shared vocabulary, not the client.
 */

export const QUEUE_NAMES = {
  domains: "domains",
  notifications: "notifications",
  media: "media",
  maintenance: "maintenance",
  /** Order domain events + delayed checkout.expire jobs (jobId = order_events.id). */
  orders: "orders",
  /** Outbound gateway work — refunds run here, never in a web request. */
  payments: "payments",
} as const;

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
