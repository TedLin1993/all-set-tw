import type { Env, ScheduledSyncQueueMessage } from "../../platform/env";
import { isDemoMode } from "../../platform/http";
import { runSchedulerTick } from "./scheduler";
import {
  failEinvoiceSyncRun,
  isEinvoiceUserActionError,
  processEinvoiceSyncChunk,
} from "./einvoice-sync-service";
import { failTdccSyncRun, processTdccSyncChunk } from "./tdcc-sync-service";
import { isUserActionError } from "./service";

const queueController = {
  cron: "queue:scheduled-sync",
} as ScheduledController;

export const SCHEDULED_SYNC_CHAIN_DELAY_SECONDS = 20;
export const EINVOICE_SYNC_CHAIN_DELAY_SECONDS = 1;
export const TDCC_SYNC_CHAIN_DELAY_SECONDS = 1;
const EINVOICE_MAX_QUEUE_ATTEMPTS = 3;
const TDCC_MAX_QUEUE_ATTEMPTS = 3;
export const DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS = 60 * 60;

export async function enqueueScheduledSync(env: Env, delaySeconds = 0) {
  // Demo deployments are read-only showcases; never start background syncs.
  if (isDemoMode(env)) return;
  const message = { type: "run-next-scheduled-sync" } as const;
  if (delaySeconds > 0) {
    await env.SYNC_QUEUE.send(message, { delaySeconds });
    return;
  }
  await env.SYNC_QUEUE.send(message);
}

export async function enqueueEinvoiceSyncChunk(
  env: Env,
  runId: string,
  delaySeconds = 0,
) {
  const message = { type: "run-einvoice-chunk", runId } as const;
  if (delaySeconds > 0) {
    await env.SYNC_QUEUE.send(message, { delaySeconds });
    return;
  }
  await env.SYNC_QUEUE.send(message);
}

export async function enqueueTdccSyncChunk(
  env: Env,
  runId: string,
  delaySeconds = 0,
) {
  const message = { type: "run-tdcc-chunk", runId } as const;
  if (delaySeconds > 0) {
    await env.SYNC_QUEUE.send(message, { delaySeconds });
    return;
  }
  await env.SYNC_QUEUE.send(message);
}

export async function consumeScheduledSyncQueue(
  batch: MessageBatch<ScheduledSyncQueueMessage>,
  env: Env,
) {
  if (isDemoMode(env)) {
    for (const message of batch.messages) {
      await parkMessageInDemoMode(message, env);
    }
    return;
  }

  for (const message of batch.messages) {
    if (message.body.type === "run-einvoice-chunk") {
      await consumeEinvoiceChunkMessage(message, env);
      continue;
    }
    if (message.body.type === "run-tdcc-chunk") {
      await consumeTdccChunkMessage(message, env);
      continue;
    }
    if (message.body.type !== "run-next-scheduled-sync") {
      console.error(
        JSON.stringify({
          event: "scheduled_sync_queue_message_rejected",
          messageId: message.id,
        }),
      );
      message.ack();
      continue;
    }

    const processed = await runSchedulerTick(env, queueController);
    if (processed) {
      await enqueueScheduledSync(env, SCHEDULED_SYNC_CHAIN_DELAY_SECONDS);
    }
    message.ack();
  }
}

// Demo mode must not contact external services. Scheduler kicks are stateless
// and are dropped; durable run chunks are re-sent later so active runs resume
// once demo mode is turned off instead of staying stuck without a continuation.
async function parkMessageInDemoMode(
  message: Message<ScheduledSyncQueueMessage>,
  env: Env,
) {
  const body = message.body;
  const parked =
    body.type === "run-einvoice-chunk" || body.type === "run-tdcc-chunk";
  console.info(
    JSON.stringify({
      event: "scheduled_sync_queue_skipped_demo_mode",
      messageId: message.id,
      messageType: body.type,
      parked,
    }),
  );
  if (!parked) {
    message.ack();
    return;
  }
  try {
    await env.SYNC_QUEUE.send(body, {
      delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS,
    });
    message.ack();
  } catch {
    message.retry({ delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS });
  }
}

async function consumeTdccChunkMessage(
  message: Message<ScheduledSyncQueueMessage>,
  env: Env,
) {
  if (message.body.type !== "run-tdcc-chunk") return;
  try {
    const result = await processTdccSyncChunk(
      env,
      message.body.runId,
      message.id,
    );
    if (result.status === "busy") {
      try {
        await enqueueTdccSyncChunk(
          env,
          message.body.runId,
          result.retryAfterSeconds,
        );
        message.ack();
      } catch {
        message.retry({ delaySeconds: result.retryAfterSeconds });
      }
      return;
    }
    if (result.status === "continue") {
      await enqueueTdccSyncChunk(
        env,
        message.body.runId,
        TDCC_SYNC_CHAIN_DELAY_SECONDS,
      );
    }
    message.ack();
  } catch (error) {
    if (
      isUserActionError(error) ||
      message.attempts >= TDCC_MAX_QUEUE_ATTEMPTS
    ) {
      await failTdccSyncRun(
        env,
        message.body.runId,
        error,
        !isUserActionError(error),
      );
      message.ack();
      return;
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

async function consumeEinvoiceChunkMessage(
  message: Message<ScheduledSyncQueueMessage>,
  env: Env,
) {
  if (message.body.type !== "run-einvoice-chunk") return;
  try {
    const result = await processEinvoiceSyncChunk(
      env,
      message.body.runId,
      message.id,
    );
    if (result.status === "busy") {
      try {
        await enqueueEinvoiceSyncChunk(
          env,
          message.body.runId,
          result.retryAfterSeconds,
        );
        message.ack();
      } catch {
        message.retry({ delaySeconds: result.retryAfterSeconds });
      }
      return;
    }
    if (result.status === "continue") {
      await enqueueEinvoiceSyncChunk(
        env,
        message.body.runId,
        EINVOICE_SYNC_CHAIN_DELAY_SECONDS,
      );
    }
    message.ack();
  } catch (error) {
    if (
      isEinvoiceUserActionError(error) ||
      message.attempts >= EINVOICE_MAX_QUEUE_ATTEMPTS
    ) {
      await failEinvoiceSyncRun(
        env,
        message.body.runId,
        error,
        !isEinvoiceUserActionError(error),
      );
      message.ack();
      return;
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

function retryDelaySeconds(attempts: number) {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 5 * 60);
}
