import type { Env, SyncQueueMessage } from "../../../platform/env";
import { isDemoMode } from "../../../platform/http";
import { runSchedulerTick } from "./scheduler";
import { processQueuedManualSync } from "../manual-sync";
import {
  failEinvoiceSyncRun,
  isEinvoiceUserActionError,
  processEinvoiceSyncChunk,
} from "../../../sources/einvoice/sync";
import {
  failTdccSyncRun,
  processTdccSyncChunk,
} from "../../../sources/tdcc/sync";
import { isUserActionError, safeErrorMessage } from "../errors";
import { recoverStalledSyncRuns } from "./recovery";
import {
  AI_CLASSIFICATION_CHAIN_DELAY_SECONDS,
  enqueueAiClassification,
  processAiClassification,
} from "../../classification/ai-service";

const queueController = {
  cron: "queue:scheduled-sync",
} as ScheduledController;

export const SCHEDULED_SYNC_CHAIN_DELAY_SECONDS = 20;
export const EINVOICE_SYNC_CHAIN_DELAY_SECONDS = 1;
export const TDCC_SYNC_CHAIN_DELAY_SECONDS = 1;
const EINVOICE_MAX_QUEUE_ATTEMPTS = 3;
const TDCC_MAX_QUEUE_ATTEMPTS = 3;
const MANUAL_SYNC_MAX_QUEUE_ATTEMPTS = 3;
export const DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS = 60 * 60;

export async function enqueueScheduledSync(env: Env, delaySeconds = 0) {
  // Demo deployments are read-only showcases; never start background syncs.
  if (isDemoMode(env)) return;
  if (delaySeconds === 0)
    await recoverStalledSyncRuns(env).catch((error) => {
      console.error(
        JSON.stringify({
          event: "sync_recovery_failed",
          error: safeErrorMessage(error),
        }),
      );
    });
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

export async function enqueueManualSyncRun(
  env: Env,
  runId: string,
  delaySeconds = 0,
) {
  const message = { type: "run-manual-sync", runId } as const;
  if (delaySeconds > 0) {
    await env.SYNC_QUEUE.send(message, { delaySeconds });
    return;
  }
  await env.SYNC_QUEUE.send(message);
}

export async function consumeScheduledSyncQueue(
  batch: MessageBatch<SyncQueueMessage>,
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
    if (message.body.type === "run-manual-sync") {
      await consumeManualSyncMessage(message, env);
      continue;
    }
    if (message.body.type === "run-ai-classification") {
      await consumeAiClassificationMessage(message, env);
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
// and are dropped; run messages are re-sent later so active runs resume or time
// out once demo mode is turned off instead of staying stuck without a message.
async function parkMessageInDemoMode(
  message: Message<SyncQueueMessage>,
  env: Env,
) {
  const body = message.body;
  const parked =
    body.type === "run-einvoice-chunk" ||
    body.type === "run-tdcc-chunk" ||
    body.type === "run-manual-sync";
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

async function consumeManualSyncMessage(
  message: Message<SyncQueueMessage>,
  env: Env,
) {
  if (message.body.type !== "run-manual-sync") return;
  const { runId } = message.body;
  try {
    const result = await processQueuedManualSync(env, runId);
    if (result.status === "busy") {
      try {
        await enqueueManualSyncRun(env, runId, result.retryAfterSeconds);
        message.ack();
      } catch {
        message.retry({ delaySeconds: result.retryAfterSeconds });
      }
      return;
    }
    message.ack();
  } catch (error) {
    // Redelivery cannot log in twice: a claimed run is no longer queued.
    // Runs left behind are closed by recoverStalledSyncRuns.
    console.error(
      JSON.stringify({
        event: "manual_sync_queue_message_failed",
        runId,
        attempts: message.attempts,
        error: safeErrorMessage(error),
      }),
    );
    if (message.attempts >= MANUAL_SYNC_MAX_QUEUE_ATTEMPTS) {
      message.ack();
      return;
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

async function consumeTdccChunkMessage(
  message: Message<SyncQueueMessage>,
  env: Env,
) {
  if (message.body.type !== "run-tdcc-chunk") return;
  try {
    const result = await processTdccSyncChunk(env, message.body.runId);
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
  message: Message<SyncQueueMessage>,
  env: Env,
) {
  if (message.body.type !== "run-einvoice-chunk") return;
  try {
    const result = await processEinvoiceSyncChunk(env, message.body.runId);
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

// The scan keeps its position in D1, so a failed message is dropped and the
// next Cron tick resumes the scan once it has been idle for 5 minutes.
async function consumeAiClassificationMessage(
  message: Message<SyncQueueMessage>,
  env: Env,
) {
  try {
    const result = await processAiClassification(env);
    if (result.status === "continue")
      await enqueueAiClassification(env, AI_CLASSIFICATION_CHAIN_DELAY_SECONDS);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "ai_classification_queue_message_failed",
        error: safeErrorMessage(error),
      }),
    );
  }
  message.ack();
}
