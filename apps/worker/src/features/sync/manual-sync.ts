import type { Env } from "../../platform/env";
import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { type SyncScope, type SyncOutcome, SYNC_SCOPE_ALL } from "./types";
import { canonicalSyncLockRowId, SYNC_LOCK_LEASE_MS } from "./lock";
import { createSyncExecution, type SyncEnv } from "./execution";
import {
  acquireSyncJobLock,
  markManualSyncSuccess,
  type SyncStatus,
  markManualSyncFailure,
  releaseSyncJobLock,
} from "../../db";
import {
  SyncAlreadyRunningError,
  isUserActionError,
  safeErrorMessage,
} from "./errors";
import {
  findLatestRecoverableScheduledBatchId,
  recoverLatestScheduledSyncSource,
} from "./reports/repository";
import { beginActivityRun } from "./reports/activity-detail-repository";

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
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    await markManualSyncFailure(
      env.DB,
      connectorId,
      scope,
      {
        status,
        errorMessage: safeErrorMessage(error),
      },
      runId,
    );
    throw error;
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
