import { resolve } from "node:path";

import { Worker } from "bullmq";
import { config } from "dotenv";

import { closeRedis } from "@platform/core";
import { closeConnections } from "@platform/db";

import { verifyDomain } from "./jobs/verify-domain";
import type { VerifyDomainJob } from "./jobs/verify-domain";
import { QUEUE_NAMES, closeQueues, connection } from "./queues";

config({ path: resolve(import.meta.dirname, "../../../.env") });

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
