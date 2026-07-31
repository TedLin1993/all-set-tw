import type { ConnectorId } from "@taiwan-fin-hub/core";
import {
  acquireSyncJobLock,
  completeSyncJob,
  failSyncJob,
  findNextDueSyncJob,
  releaseSyncJobLock,
  type SyncJobRow,
  type SyncStatus,
} from "@taiwan-fin-hub/db";
import type { Env } from "../../platform/env";
import {
  canonicalSyncLockRowId,
  isUserActionError,
  safeErrorMessage,
  startSyncLockHeartbeat,
  SYNC_LOCK_LEASE_MS,
  type SyncScope,
} from "./service";
import { runConnectorSync } from "./registry";
import {
  safelySendScheduledSyncSummary,
  safelySendSyncNotification,
} from "../notifications/service";
import type { SyncNotificationEvent } from "../notifications/payload";
import {
  claimCompletedDefaultScheduleBatch,
  ensureDefaultScheduleBatch,
  finalizeOpenDefaultScheduleBatch,
  findNextDefaultScheduleBatchJob,
  findOpenDefaultScheduleBatchId,
  recordDefaultScheduleBatchResult,
} from "./notification-batch-repository";

export async function runSchedulerTick(
  env: Env,
  controller: ScheduledController,
): Promise<boolean> {
  const pendingSummary = await finalizeOpenDefaultScheduleBatch(env.DB);
  if (pendingSummary) {
    await safelySendScheduledSyncSummary(env, pendingSummary);
  }

  const openBatchId = await findOpenDefaultScheduleBatchId(env.DB);
  if (openBatchId) {
    const batchJob = await findNextDefaultScheduleBatchJob(env.DB, openBatchId);
    if (batchJob) {
      return runDefaultScheduleBatchJob(env, controller, openBatchId, batchJob);
    }

    // A locked batch member should not prevent an unrelated custom schedule
    // from using this invocation.
    const customDue = await findNextDueSyncJob<ConnectorId>(
      env.DB,
      new Date(),
      "custom",
    );
    if (customDue) return runCustomScheduleJob(env, controller, customDue);
    return false;
  }

  const due = await findNextDueSyncJob<ConnectorId>(env.DB);
  if (!due) return false;
  if (due.schedule_mode === "custom") {
    return runCustomScheduleJob(env, controller, due);
  }

  const batchId = await ensureDefaultScheduleBatch(env.DB);
  if (!batchId) return false;
  const batchJob = await findNextDefaultScheduleBatchJob(env.DB, batchId);
  if (batchJob) {
    return runDefaultScheduleBatchJob(env, controller, batchId, batchJob);
  }
  return false;
}

async function runCustomScheduleJob(
  env: Env,
  controller: ScheduledController,
  job: SyncJobRow<ConnectorId>,
) {
  const notification = await runScheduledJob(env, controller, job);
  if (notification) await safelySendSyncNotification(env, notification);
  return notification !== undefined;
}

async function runDefaultScheduleBatchJob(
  env: Env,
  controller: ScheduledController,
  batchId: string,
  job: SyncJobRow<ConnectorId>,
) {
  const notification = await runScheduledJob(
    env,
    controller,
    job,
    async (result) => {
      const recorded = await recordDefaultScheduleBatchResult(env.DB, {
        batchId,
        jobId: job.id,
        notification: result,
      });
      if (!recorded) {
        throw new Error(
          `Default schedule batch member is no longer pending: ${job.id}`,
        );
      }
    },
  );
  if (!notification) return false;

  const summary = await claimCompletedDefaultScheduleBatch(env.DB, batchId);
  if (summary) await safelySendScheduledSyncSummary(env, summary);
  return true;
}

async function runScheduledJob(
  env: Env,
  controller: ScheduledController,
  due: SyncJobRow<ConnectorId>,
  beforeRelease?: (notification: SyncNotificationEvent) => Promise<void>,
) {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(due.connector_id);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: due.scope,
    trigger: "scheduled",
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });
  if (!locked) return;

  const stopHeartbeat = startSyncLockHeartbeat(env.DB, lockRowId, runId);
  const startedAt = Date.now();
  try {
    let notification: SyncNotificationEvent;
    try {
      const outcome = await runDueSyncJob(env, due);
      await completeSyncJob(env.DB, due);
      console.log(
        JSON.stringify({
          event: "sync_run_finished",
          runId,
          cron: controller.cron,
          connectorId: outcome.connectorId,
          scope: outcome.scope,
          trigger: "scheduled",
          status: "success",
          records: outcome.records,
          durationMs: Date.now() - startedAt,
        }),
      );
      notification = {
        connectorId: outcome.connectorId,
        status: "success",
      };
    } catch (error) {
      const status: SyncStatus = isUserActionError(error)
        ? "needs_user_action"
        : "failed";
      await failSyncJob(env.DB, due, {
        status,
        errorMessage: safeErrorMessage(error),
      });
      console.error(
        JSON.stringify({
          event: "sync_run_failed",
          runId,
          cron: controller.cron,
          connectorId: due.connector_id,
          scope: due.scope,
          trigger: "scheduled",
          status,
          message: safeErrorMessage(error),
          durationMs: Date.now() - startedAt,
        }),
      );
      notification = {
        connectorId: due.connector_id,
        status,
      };
    }

    if (beforeRelease) await beforeRelease(notification);
    return notification;
  } finally {
    stopHeartbeat();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

async function runDueSyncJob(env: Env, job: SyncJobRow<ConnectorId>) {
  return runConnectorSync(
    env,
    job.connector_id,
    "scheduled",
    job.scope as SyncScope,
    job.connector_id === "einvoice" ? { fetchDetails: true } : {},
  );
}
