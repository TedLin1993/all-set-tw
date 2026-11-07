import { and, eq, isNotNull, lte } from "drizzle-orm";
import {
  createDrizzle,
  nextRunAtAfterManualFailure,
  sanitizeDatabaseError,
  syncJobSelection,
  syncJobs,
} from "../../../db";
import type { Env } from "../../../platform/env";
import { getActiveEinvoiceRun } from "../../../sources/einvoice/run-repository";
import { getActiveTdccRun } from "../../../sources/tdcc/run-repository";
import { failEinvoiceSyncRun } from "../../../sources/einvoice/sync";
import { failTdccSyncRun } from "../../../sources/tdcc/sync";
import { durableRunState } from "../run-state";
import { SyncTimeoutError } from "../execution";
import { safeErrorMessage } from "../errors";
import { MANUAL_SYNC_QUEUE_TIMEOUT_MS } from "../lock";
import {
  deleteFinishedManualSyncRuns,
  expireQueuedManualSyncRuns,
  failInterruptedManualSyncRuns,
} from "../manual-run-repository";

/** 前端只需要最近一次結果；舊的背景手動同步紀錄定期清除。 */
const MANUAL_SYNC_RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Cron 補送無有效 chunk 租約且停止更新的 run；逾時者結案，並關閉中斷或排隊逾時的背景手動同步。 */
export async function recoverStalledSyncRuns(env: Env) {
  const [einvoice, tdcc] = await Promise.all([
    getActiveEinvoiceRun(env.DB),
    getActiveTdccRun(env.DB),
  ]);
  for (const [connectorId, run] of [
    ["einvoice", einvoice],
    ["tdcc", tdcc],
  ] as const) {
    if (!run) continue;
    const state = durableRunState(run);
    if (!state.stalled) continue;
    try {
      if (state.expired) {
        const finalized =
          connectorId === "einvoice"
            ? await failEinvoiceSyncRun(
                env,
                run.id,
                new SyncTimeoutError(),
                true,
              )
            : await failTdccSyncRun(env, run.id, new SyncTimeoutError(), true);
        if (!finalized) continue;
      } else {
        await env.SYNC_QUEUE.send({
          type:
            connectorId === "einvoice"
              ? "run-einvoice-chunk"
              : "run-tdcc-chunk",
          runId: run.id,
        });
      }
      console.info(
        JSON.stringify({
          event: "sync_run_recovered",
          connectorId,
          runId: run.id,
          action: state.expired ? "timed_out" : "requeued",
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "sync_run_recovery_failed",
          connectorId,
          runId: run.id,
          error: safeErrorMessage(error),
        }),
      );
    }
  }
  try {
    await expireQueuedManualSyncRuns(env.DB, {
      createdBefore: new Date(
        Date.now() - MANUAL_SYNC_QUEUE_TIMEOUT_MS,
      ).toISOString(),
      errorCode: "SYNC_QUEUE_TIMEOUT",
      lastError: "同步排隊逾時，請重新同步。",
    });
    await failInterruptedManualSyncRuns(env.DB, {
      errorCode: "SYNC_INTERRUPTED",
      lastError: "同步已中斷或逾時，請重新同步。",
    });
    await deleteFinishedManualSyncRuns(
      env.DB,
      new Date(Date.now() - MANUAL_SYNC_RUN_RETENTION_MS).toISOString(),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "manual_sync_recovery_failed",
        error: safeErrorMessage(error),
      }),
    );
  }
  const recoveredAt = new Date();
  const now = recoveredAt.toISOString();
  const interruptedLock = `locked_by IS NOT NULL AND locked_until <= ?
      AND NOT EXISTS (SELECT 1 FROM einvoice_sync_runs WHERE id = sync_jobs.locked_by AND status IN ('queued', 'initializing', 'processing'))
      AND NOT EXISTS (SELECT 1 FROM tdcc_sync_runs WHERE id = sync_jobs.locked_by AND status IN ('queued', 'initializing', 'processing', 'promoting'))`;
  // 中斷的手動同步比照手動失敗：needs_user_action 期間停在過去的到期時間一併推進，
  // 避免下一次 tick 因殘留時間觸發整輪預設排程。排程同步中斷則保留原值，
  // 由同一輪批次或下一次 tick 重試。
  const interruptedManualJobs = await createDrizzle(env.DB)
    .select(syncJobSelection)
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.lockTrigger, "manual"),
        isNotNull(syncJobs.lockedBy),
        lte(syncJobs.lockedUntil, now),
        lte(syncJobs.nextRunAt, now),
      ),
    )
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  // 普通同步停止續租後，清理原 owner 的殘留鎖並保留最後成功時間。
  // durable run 由上面的結案流程處理，不能只清除 connector lock。
  await env.DB.batch([
    ...interruptedManualJobs.map((job) =>
      env.DB.prepare(
        `UPDATE sync_jobs SET next_run_at = ?
        WHERE id = ? AND locked_by = ? AND lock_trigger = 'manual'
          AND next_run_at <= ? AND ${interruptedLock}`,
      ).bind(
        nextRunAtAfterManualFailure(job, "failed", recoveredAt),
        job.id,
        job.locked_by,
        now,
        now,
      ),
    ),
    env.DB.prepare(
      `UPDATE sync_jobs
    SET last_status = 'failed', last_error = '同步已中斷或逾時，請重新同步。',
        last_error_code = 'SYNC_INTERRUPTED',
        last_run_at = ?, locked_by = NULL, locked_until = NULL,
        lock_trigger = NULL, lock_scope = NULL, updated_at = ?
    WHERE ${interruptedLock}`,
    ).bind(now, now, now),
  ]);
}
