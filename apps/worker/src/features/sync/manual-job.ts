import type { ConnectorId } from "@taiwan-fin-hub/core";
import {
  acquireSyncJobLock,
  markManualSyncFailure,
  markManualSyncSuccess,
  releaseSyncJobLock,
  type SyncStatus,
} from "@taiwan-fin-hub/db";
import type { Env } from "../../platform/env";
import {
  canonicalSyncLockRowId,
  isUserActionError,
  safeErrorMessage,
  startSyncLockHeartbeat,
  SYNC_LOCK_LEASE_MS,
  SyncAlreadyRunningError,
  type SyncOutcome,
  type SyncScope,
} from "./service";

export type ManualSyncJob = {
  runId: string;
  completion: Promise<SyncOutcome>;
};

export async function startManualSyncJob(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: () => Promise<SyncOutcome>,
): Promise<ManualSyncJob> {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope,
    trigger: "manual",
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });

  if (!locked) throw new SyncAlreadyRunningError(connectorId);

  const completion = runManualSyncJob(
    env,
    connectorId,
    scope,
    lockRowId,
    runId,
    task,
  );

  return { runId, completion };
}

async function runManualSyncJob(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  lockRowId: string,
  runId: string,
  task: () => Promise<SyncOutcome>,
) {
  const stopHeartbeat = startSyncLockHeartbeat(env.DB, lockRowId, runId);
  try {
    const outcome = await task();
    await markManualSyncSuccess(env.DB, connectorId, scope);
    return outcome;
  } catch (error) {
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    await markManualSyncFailure(env.DB, connectorId, scope, {
      status,
      errorMessage: safeErrorMessage(error),
    });
    throw error;
  } finally {
    stopHeartbeat();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
