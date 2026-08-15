// MUST stay the first import: everything below reads process.env at
// module scope, and ESM evaluates imports before this file's own body.
import "./env";

import { Worker } from "bullmq";

import { closeRedis } from "@platform/core";
import { closeConnections } from "@platform/db";

import { processGatewayRefund } from "./jobs/gateway-refund";
import type { GatewayRefundJob } from "./jobs/gateway-refund";
import { handleOrdersJob } from "./jobs/order-events";
import { processMedia } from "./jobs/process-media";
import type { ProcessMediaJob } from "./jobs/process-media";
import { sweepCheckouts } from "./jobs/sweep-checkouts";
import { sweepReservations } from "./jobs/sweep-reservations";
import { verifyDomain } from "./jobs/verify-domain";
import type { VerifyDomainJob } from "./jobs/verify-domain";
import { QUEUE_NAMES, closeQueues, connection, maintenanceQueue } from "./queues";

/**
 * Worker entrypoint.
 *
 * Long-running and external-facing work lives here, never in a web
 * request. A courier or gateway API that hangs for 30 seconds must not
 * be able to hold a customer's checkout open — or exhaust the web
 * process's database pool while it waits (PLATFORM_BLUEPRINT.md §5.3).
 */

function log(event: string, data: Record<string, unknown> = {}): void {
  // Structured from line one. `tenantId` on every record is what makes
  // per-merchant debugging possible once there are hundreds of them.
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

const workers = [
  new Worker<VerifyDomainJob>(
    QUEUE_NAMES.domains,
    async (job) => {
      log("job.start", { queue: job.queueName, jobId: job.id, tenantId: job.data.tenantId });
      const result = await verifyDomain(job.data);
      log("job.done", { jobId: job.id, tenantId: job.data.tenantId, ...result });
      return result;
    },
    { connection, concurrency: 5 },
  ),

  /**
   * Image processing is CPU-bound, unlike everything else here, which
   * waits on someone else's API. Five concurrent encodes would pin
   * every core and starve the I/O-bound queues sharing this process, so
   * this one runs deliberately narrow.
   */
  new Worker<ProcessMediaJob>(
    QUEUE_NAMES.media,
    async (job) => {
      log("job.start", { queue: job.queueName, jobId: job.id, tenantId: job.data.tenantId });
      const result = await processMedia(job.data);
      log("job.done", { jobId: job.id, tenantId: job.data.tenantId, ...result });
      return result;
    },
    { connection, concurrency: 2 },
  ),

  new Worker(
    QUEUE_NAMES.maintenance,
    async (job) => {
      log("job.start", { queue: job.queueName, jobId: job.id, name: job.name });
      const result =
        job.name === "sweep-checkouts" ? await sweepCheckouts() : await sweepReservations();
      log("job.done", { jobId: job.id, name: job.name, ...result });
      return result;
    },
    { connection, concurrency: 1 },
  ),

  /**
   * Order domain events + delayed checkout expiry. The log seam is
   * cheap, but expiry does real (idempotent) database work per order —
   * a modest concurrency keeps a burst of expiries from starving the
   * pool.
   */
  new Worker(
    QUEUE_NAMES.orders,
    async (job) => {
      log("job.start", {
        queue: job.queueName,
        jobId: job.id,
        name: job.name,
        tenantId: (job.data as { tenantId?: string }).tenantId,
      });
      const result = await handleOrdersJob({ name: job.name, data: job.data });
      log("job.done", { jobId: job.id, name: job.name, ...result });
      return result;
    },
    { connection, concurrency: 5 },
  ),

  /**
   * Outbound gateway refunds (spec §4.7.2): external-API work, so it
   * runs narrow and leans on the queue's exponential backoff + retained
   * dead letters rather than in-process retry loops.
   */
  new Worker<GatewayRefundJob>(
    QUEUE_NAMES.payments,
    async (job) => {
      log("job.start", { queue: job.queueName, jobId: job.id, tenantId: job.data.tenantId });
      const result = await processGatewayRefund(job.data);
      log("job.done", { jobId: job.id, tenantId: job.data.tenantId, ...result });
      return result;
    },
    { connection, concurrency: 2 },
  ),
];

for (const w of workers) {
  w.on("failed", (job, err) => {
    log("job.failed", {
      queue: w.name,
      jobId: job?.id,
      tenantId: job?.data?.tenantId,
      attempt: job?.attemptsMade,
      error: err.message,
    });
  });
  w.on("error", (err) => log("worker.error", { queue: w.name, error: err.message }));
}

log("worker.started", { queues: workers.map((w) => w.name) });

// Daily reservation GC. upsertJobScheduler is idempotent across
// restarts — one scheduler, however many times the worker boots.
maintenanceQueue
  .upsertJobScheduler("sweep-reservations", { every: 86_400_000 })
  .then(() => log("scheduler.registered", { job: "sweep-reservations" }))
  .catch((err) => log("worker.error", { queue: "maintenance", error: (err as Error).message }));

// Abandoned-checkout backstop sweep, every 10 minutes (D10). The
// explicit job-name template is what the maintenance handler switches
// on.
maintenanceQueue
  .upsertJobScheduler("sweep-checkouts", { every: 600_000 }, { name: "sweep-checkouts" })
  .then(() => log("scheduler.registered", { job: "sweep-checkouts" }))
  .catch((err) => log("worker.error", { queue: "maintenance", error: (err as Error).message }));

/**
 * Graceful shutdown. `Worker.close()` waits for in-flight jobs to finish
 * rather than killing them mid-flight, which matters once jobs are
 * calling payment and courier APIs — a job killed after the outbound
 * call but before the state write is exactly the inconsistency that
 * makes reconciliation miserable.
 */
async function shutdown(signal: string): Promise<void> {
  log("worker.shutdown", { signal });
  try {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeRedis();
    await closeConnections();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
