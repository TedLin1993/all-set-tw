import { renewSyncJobLock } from "../../db";
import type { ConnectorId } from "@taiwan-fin-hub/shared";

export const SYNC_LOCK_LEASE_MS = 10 * 60 * 1000;
export const SYNC_MAX_DURATION_MS = 10 * 60 * 1000;

const SYNC_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;

export function startSyncLockHeartbeat(
  db: D1Database,
  lockRowId: string,
  runId: string,
  onLost: (error: Error) => void,
) {
  const timer = setInterval(() => {
    void renewSyncJobLock(db, { lockRowId, runId, leaseMs: SYNC_LOCK_LEASE_MS })
      .then((renewed) => {
        if (!renewed) onLost(new Error("同步鎖已失效，請重新同步。"));
      })
      .catch(() => onLost(new Error("同步鎖續租失敗，請重新同步。")));
  }, SYNC_LOCK_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

export function canonicalSyncLockRowId(connectorId: ConnectorId) {
  return `${connectorId}:all`;
}
