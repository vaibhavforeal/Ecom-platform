import { Queue } from "bullmq";

import { QUEUE_NAMES, defaultJobOptions, redis } from "@platform/core";

/**
 * The console's end of the job queues.
 *
 * Constructed lazily, and never at module scope: `next build` imports
 * every route module to read its config, and a Queue built at import
 * time opens a Redis connection during the build — which then keeps the
 * build process alive after it has finished its work.
 *
 * The connection is the shared `redis()` client from @platform/core,
 * which is already configured with the `maxRetriesPerRequest: null`
 * BullMQ requires. Passing an existing client also means BullMQ will not
 * close it out from under the rest of the app.
 */

export type MediaJobPayload = { tenantId: string; mediaId: string };

let queue: Queue<MediaJobPayload> | undefined;

function mediaQueue(): Queue<MediaJobPayload> {
  queue ??= new Queue<MediaJobPayload>(QUEUE_NAMES.media, {
    connection: redis(),
    defaultJobOptions,
  });
  return queue;
}

export async function enqueueMediaProcessing(payload: MediaJobPayload): Promise<void> {
  await mediaQueue().add("process", payload);
}
