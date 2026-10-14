import type { Env } from "../../platform/env";
import {
  connectorCatalog,
  type ConnectorId,
  type SyncNotificationStatus,
} from "@taiwan-fin-hub/shared";
import { safelySendSyncNotification } from "../notifications/service";
import { type SyncScope, type SyncOutcome, SYNC_SCOPE_ALL } from "./types";
import {
  canonicalSyncLockRowId,
  MANUAL_SYNC_QUEUE_TIMEOUT_MS,
  SYNC_LOCK_LEASE_MS,
} from "./lock";
import { createSyncExecution, type SyncEnv } from "./execution";
import {
  acquireSyncJobLock,
  markManualSyncSuccess,
  markManualSyncFailure,
  releaseSyncJobLock,
} from "../../db";
import {
  SyncAlreadyRunningError,
  isUserActionError,
  safeErrorMessage,
} from "./errors";
import { classifySyncError, syncFailureInput } from "./error-response";
import {
  findLatestRecoverableScheduledBatchId,
  recoverLatestScheduledSyncSource,
} from "./reports/repository";
import { beginActivityRun } from "./reports/activity-detail-repository";
import { runConnectorSync } from "./registry";
import {
  claimManualSyncRun,
  closeQueuedManualSyncRun,
  createOrGetActiveManualSyncRun,
  finishManualSyncRun,
  getManualSyncRun,
  requeueManualSyncRun,
} from "./manual-run-repository";

const MANUAL_SYNC_MAX_CAPACITY_RETRIES = 3;

type ManualSyncOwner = {
  connectorId: ConnectorId;
  scope: SyncScope;
  runId: string;
  lockRowId: string;
};

export async function withManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: (env: SyncEnv) => Promise<SyncOutcome>,
) {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope,
    trigger: "manual",
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });

  if (!locked) {
    throw new SyncAlreadyRunningError(connectorId);
  }

  try {
    return await runLockedManualSync(
      env,
      { connectorId, scope, runId, lockRowId },
      task,
    );
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

/** 呼叫端已取得 connector lock；這裡負責執行期限、結果狀態與報告修復。 */
async function runLockedManualSync(
  env: Env,
  owner: ManualSyncOwner,
  task: (env: SyncEnv) => Promise<SyncOutcome>,
  options: { recordFailure?: (error: unknown) => boolean } = {},
) {
  const { connectorId, scope, runId, lockRowId } = owner;
  const execution = createSyncExecution(env, { lockRowId, runId });
  let recoveryBatchId: string | null = null;
  try {
    return await execution.run(async (syncEnv) => {
      recoveryBatchId =
        connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL
          ? await findLatestRecoverableScheduledBatchId(env.DB, connectorId)
          : null;
      await beginActivityRun(syncEnv.DB, runId, recoveryBatchId, connectorId);
      const outcome = await task(syncEnv);
      await markManualSyncSuccess(syncEnv.DB, connectorId, scope, runId);
      if (connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL) {
        await recoverLatestScheduledSyncSource(syncEnv.DB, {
          connectorId,
          newRecords: outcome.newRecords,
          batchId: recoveryBatchId,
          runId,
        }).catch((error) => {
          // A report repair must never turn an otherwise successful manual sync
          // into a failed sync response.
          console.error(
            "[sync] failed to recover latest scheduled report",
            error,
          );
        });
      }
      return outcome;
    });
  } catch (error) {
    if (options.recordFailure?.(error) ?? true) {
      await markManualSyncFailure(
        env.DB,
        connectorId,
        scope,
        syncFailureInput(error),
        runId,
      );
    }
    throw error;
  } finally {
    execution.stop();
  }
}

/** 電子發票與集保已有各自的 durable run，不走一般背景手動同步。 */
function supportsQueuedManualSync(connectorId: ConnectorId) {
  return connectorId !== "einvoice" && connectorId !== "tdcc";
}

/**
 * 建立或取得進行中的背景手動同步；呼叫端負責在新建時 enqueue。
 * 來源正被排程或其他同步占用時直接拒絕，不排在其後。
 */
export async function startQueuedManualSync(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope = SYNC_SCOPE_ALL,
) {
  if (!supportsQueuedManualSync(connectorId)) {
    throw new Error(
      `${connectorId} sync must be started through its durable Queue flow.`,
    );
  }
  const supportedScopes: readonly string[] =
    connectorCatalog[connectorId].scopes;
  if (!supportedScopes.includes(scope)) {
    throw new Error(`${connectorId} sync scope is not supported: ${scope}`);
  }
  const result = await createOrGetActiveManualSyncRun(env.DB, {
    connectorId,
    scope,
  });
  if (result.status === "connector_busy")
    throw new SyncAlreadyRunningError(connectorId);
  return { run: result.run, created: result.status === "created" };
}

export async function cancelQueuedManualSync(
  env: Env,
  runId: string,
  error: unknown,
) {
  await closeQueuedManualSyncRun(env.DB, runId, {
    status: "cancelled",
    errorCode: "SYNC_ENQUEUE_FAILED",
    lastError: safeErrorMessage(error),
  });
}

export type QueuedManualSyncResult =
  { status: "done" } | { status: "busy"; retryAfterSeconds: number };

/**
 * Queue consumer 執行背景手動同步。只做一次登入嘗試：
 * 銀行的登入失敗可能累計鎖定，除了登入前的 Browser 容量不足外不自動重試。
 */
export async function processQueuedManualSync(
  env: Env,
  runId: string,
): Promise<QueuedManualSyncResult> {
  const run = await getManualSyncRun(env.DB, runId);
  if (!run || run.status !== "queued") return { status: "done" };
  if (Date.parse(run.createdAt) + MANUAL_SYNC_QUEUE_TIMEOUT_MS <= Date.now()) {
    await closeQueuedManualSyncRun(env.DB, run.id, {
      status: "failed",
      errorCode: "SYNC_QUEUE_TIMEOUT",
      lastError: "同步排隊逾時，請重新同步。",
    });
    return { status: "done" };
  }

  const owner: ManualSyncOwner = {
    connectorId: run.connectorId,
    scope: run.scope as SyncScope,
    runId: run.id,
    lockRowId: canonicalSyncLockRowId(run.connectorId),
  };
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId: owner.lockRowId,
    scope: owner.scope,
    trigger: "manual",
    runId: owner.runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });
  if (!locked) {
    await closeQueuedManualSyncRun(env.DB, run.id, {
      status: "cancelled",
      errorCode: "SYNC_ALREADY_RUNNING",
      lastError: "此來源已有其他同步正在進行，請待完成後再同步。",
    });
    return { status: "done" };
  }

  let notification: SyncNotificationStatus | null = null;
  try {
    if (!(await claimManualSyncRun(env.DB, run.id))) return { status: "done" };
    const canRetryCapacity =
      run.retryCount + 1 < MANUAL_SYNC_MAX_CAPACITY_RETRIES;
    // 每日額度的等待可達數小時，超過 30 分鐘排隊上限時直接以容量錯誤結案。
    const queueDeadline =
      Date.parse(run.createdAt) + MANUAL_SYNC_QUEUE_TIMEOUT_MS;
    const isCapacityRetry = (error: unknown) => {
      const retryAfter = classifySyncError(error).retryAfterSeconds;
      return (
        canRetryCapacity &&
        retryAfter !== undefined &&
        Date.now() + retryAfter * 1_000 < queueDeadline
      );
    };
    try {
      await runLockedManualSync(
        env,
        owner,
        (syncEnv) =>
          runConnectorSync(syncEnv, owner.connectorId, "manual", owner.scope),
        { recordFailure: (error) => !isCapacityRetry(error) },
      );
      if (await finishManualSyncRun(env.DB, run.id, { status: "completed" }))
        notification = "success";
      return { status: "done" };
    } catch (error) {
      const classified = classifySyncError(error);
      if (
        isCapacityRetry(error) &&
        (await requeueManualSyncRun(env.DB, run.id))
      )
        return {
          status: "busy",
          retryAfterSeconds: classified.retryAfterSeconds!,
        };
      const status = isUserActionError(error) ? "needs_user_action" : "failed";
      if (
        await finishManualSyncRun(env.DB, run.id, {
          status,
          errorCode: classified.code,
          lastError: classified.message,
        })
      )
        notification = status;
      return { status: "done" };
    }
  } finally {
    await releaseSyncJobLock(env.DB, owner.lockRowId, owner.runId);
    if (notification)
      await safelySendSyncNotification(env, {
        connectorId: owner.connectorId,
        status: notification,
        trigger: "manual",
      });
  }
}
