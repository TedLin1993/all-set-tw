import type { Env } from "../../../platform/env";
import { getActiveEinvoiceRun } from "../../../sources/einvoice/run-repository";
import { getActiveTdccRun } from "../../../sources/tdcc/run-repository";
import { failEinvoiceSyncRun } from "../../../sources/einvoice/sync";
import { failTdccSyncRun } from "../../../sources/tdcc/sync";
import { durableRunState } from "../run-state";
import { SyncTimeoutError } from "../execution";
import { safeErrorMessage } from "../errors";

/** Cron 補送無有效 chunk 租約且停止更新的 run；逾時者結案。 */
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
  const now = new Date().toISOString();
  // 普通同步停止續租後，清理原 owner 的殘留鎖並保留最後成功時間。
  // durable run 由上面的結案流程處理，不能只清除 connector lock。
  await env.DB.prepare(
    `UPDATE sync_jobs
    SET last_status = 'failed', last_error = '同步已中斷或逾時，請重新同步。',
        last_run_at = ?, locked_by = NULL, locked_until = NULL,
        lock_trigger = NULL, lock_scope = NULL, updated_at = ?
    WHERE locked_by IS NOT NULL AND locked_until <= ?
      AND NOT EXISTS (SELECT 1 FROM einvoice_sync_runs WHERE id = sync_jobs.locked_by AND status IN ('queued', 'initializing', 'processing'))
      AND NOT EXISTS (SELECT 1 FROM tdcc_sync_runs WHERE id = sync_jobs.locked_by AND status IN ('queued', 'initializing', 'processing', 'promoting'))`,
  )
    .bind(now, now, now)
    .run();
}
