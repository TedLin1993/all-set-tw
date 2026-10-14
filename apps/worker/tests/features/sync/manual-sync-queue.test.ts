import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { acquireSyncJobLock, releaseSyncJobLock } from "../../../src/db";
import {
  ManualCaptchaRequiredError,
  SyncAlreadyRunningError,
} from "../../../src/features/sync/errors";
import { BrowserRunCapacityError } from "../../../src/sources/browser";
import { reportSyncProgress } from "../../../src/sources/sync-progress";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({ runConnectorSync: vi.fn() }));

vi.mock("../../../src/features/sync/registry", () => ({
  runConnectorSync: mocks.runConnectorSync,
  prepareConnectorChallenge: vi.fn(),
}));

import {
  processQueuedManualSync,
  startQueuedManualSync,
} from "../../../src/features/sync/manual-sync";
import {
  claimManualSyncRun,
  getManualSyncRun,
} from "../../../src/features/sync/manual-run-repository";
import { recoverStalledSyncRuns } from "../../../src/features/sync/scheduling/recovery";
import { getSyncJobs } from "../../../src/features/sync/scheduling/service";
import { syncRoutes } from "../../../src/features/sync/route";

const outcome = {
  success: true as const,
  connectorId: "esun" as const,
  scope: "all" as const,
  records: 0,
  newRecords: { invoices: 0, bankTransactions: 0, investmentTransactions: 0 },
  cursorUpdated: true,
};

describe("背景手動同步（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let env: Env;
  beforeAll(async () => {
    harness = await createTestD1();
    env = { DB: harness.binding } as Env;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    const db = harness.binding;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("DELETE FROM manual_sync_runs"),
      db.prepare("DELETE FROM sync_jobs"),
      db
        .prepare(
          `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at)
           VALUES ('esun:all', 'esun', 'all', 1440, ?, ?, ?)`,
        )
        .bind(now, now, now),
    ]);
    mocks.runConnectorSync.mockReset();
  });

  async function syncJob(id = "esun:all") {
    return harness.binding
      .prepare(
        "SELECT locked_by, lock_phase, enabled, schedule_mode, interval_minutes, preferred_time, preferred_weekdays, last_status, last_error, last_error_code FROM sync_jobs WHERE id = ?",
      )
      .bind(id)
      .first();
  }

  async function insertSyncJob(connectorId: string, enabled: number) {
    const now = new Date().toISOString();
    await harness.binding
      .prepare(
        `INSERT INTO sync_jobs (id, connector_id, scope, enabled, interval_minutes, next_run_at, created_at, updated_at)
         VALUES (?, ?, 'all', ?, 1440, ?, ?, ?)`,
      )
      .bind(`${connectorId}:all`, connectorId, enabled, now, now, now)
      .run();
  }

  it("沒有輸入的手動同步回 202 並只排入一次；帶驗證碼的接續在 request 內完成", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queueEnv = { ...env, SYNC_QUEUE: { send } } as unknown as Env;
    const post = (path: string, body?: unknown) =>
      syncRoutes.request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        },
        queueEnv,
      );

    const first = await post("/connectors/esun/sync");
    expect(first.status).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    const again = await post("/connectors/esun/sync");
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ runId });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ type: "run-manual-sync", runId });
    expect(mocks.runConnectorSync).not.toHaveBeenCalled();
    expect(
      (await getSyncJobs(env.DB)).find((job) => job.id === "esun:all"),
    ).toMatchObject({ running: true, phase: "queued", runId });

    await processQueuedManualSync(queueEnv, runId);
    send.mockRejectedValueOnce(new Error("queue unavailable"));
    expect((await post("/connectors/esun/sync")).status).toBe(500);
    expect(
      await harness.binding
        .prepare(
          "SELECT COUNT(*) AS active FROM manual_sync_runs WHERE status IN ('queued', 'running')",
        )
        .first(),
    ).toMatchObject({ active: 0 });

    await insertSyncJob("sinopac", 0);
    mocks.runConnectorSync.mockResolvedValue({
      ...outcome,
      connectorId: "sinopac",
    });
    const inline = await post("/connectors/sinopac/sync", {
      captcha: "123456",
    });
    expect(inline.status).toBe(200);
    expect(await syncJob("sinopac:all")).toMatchObject({ enabled: 1 });
    expect(mocks.runConnectorSync).toHaveBeenLastCalledWith(
      expect.anything(),
      "sinopac",
      "manual",
      "all",
      { captcha: "123456" },
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { connectorId: "sinopac", scheduleMode: "inherit" },
    { connectorId: "ctbc", scheduleMode: "custom" },
  ] as const)(
    "$connectorId 首次成功啟用排程並保留 $scheduleMode 設定，之後關閉不再自動啟用",
    async ({ connectorId, scheduleMode }) => {
      const jobId = `${connectorId}:all`;
      await insertSyncJob(connectorId, 0);
      await harness.binding
        .prepare(
          `UPDATE sync_jobs SET schedule_mode = ?, interval_minutes = 10080,
           preferred_time = '09:30', preferred_weekdays = '[1,3,5]' WHERE id = ?`,
        )
        .bind(scheduleMode, jobId)
        .run();
      const schedule = {
        schedule_mode: scheduleMode,
        interval_minutes: 10080,
        preferred_time: "09:30",
        preferred_weekdays: "[1,3,5]",
      };
      mocks.runConnectorSync.mockResolvedValue({ ...outcome, connectorId });
      const first = await startQueuedManualSync(env, connectorId);
      await processQueuedManualSync(env, first.run.id);
      expect(await syncJob(jobId)).toMatchObject({
        ...schedule,
        enabled: 1,
        last_status: "success",
      });

      await harness.binding
        .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = ?")
        .bind(jobId)
        .run();
      const second = await startQueuedManualSync(env, connectorId);
      await processQueuedManualSync(env, second.run.id);
      expect(await syncJob(jobId)).toMatchObject({ ...schedule, enabled: 0 });
    },
  );

  it("來源已有其他同步時拒絕手動同步；搶輸 lock 的 run 取消且不釋放對方的鎖", async () => {
    const lock = {
      lockRowId: "esun:all",
      scope: "all",
      trigger: "scheduled" as const,
      runId: "scheduled-run",
      leaseMs: 60_000,
    };
    expect(await acquireSyncJobLock(env.DB, lock)).toBe(true);
    await expect(startQueuedManualSync(env, "esun")).rejects.toBeInstanceOf(
      SyncAlreadyRunningError,
    );
    await releaseSyncJobLock(env.DB, lock.lockRowId, lock.runId);

    const raced = await startQueuedManualSync(env, "esun");
    expect(await acquireSyncJobLock(env.DB, lock)).toBe(true);
    expect(await processQueuedManualSync(env, raced.run.id)).toEqual({
      status: "done",
    });
    expect(mocks.runConnectorSync).not.toHaveBeenCalled();
    expect(await getManualSyncRun(env.DB, raced.run.id)).toMatchObject({
      status: "cancelled",
      errorCode: "SYNC_ALREADY_RUNNING",
    });
    expect(await syncJob()).toMatchObject({ locked_by: "scheduled-run" });
    await releaseSyncJobLock(env.DB, lock.lockRowId, lock.runId);
    expect((await startQueuedManualSync(env, "esun")).created).toBe(true);
  });

  it("重複點擊只排一個 run；重送訊息不會再次登入；執行中回報目前階段", async () => {
    mocks.runConnectorSync.mockImplementation(async () => {
      reportSyncProgress("fetching");
      await vi.waitFor(async () => {
        expect(
          (await getSyncJobs(env.DB)).find((job) => job.id === "esun:all"),
        ).toMatchObject({ running: true, phase: "fetching" });
      });
      return outcome;
    });
    const first = await startQueuedManualSync(env, "esun");
    const second = await startQueuedManualSync(env, "esun");
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { id: first.run.id } });

    expect(await processQueuedManualSync(env, first.run.id)).toEqual({
      status: "done",
    });
    expect(await processQueuedManualSync(env, first.run.id)).toEqual({
      status: "done",
    });
    expect(mocks.runConnectorSync).toHaveBeenCalledOnce();
    expect(await getManualSyncRun(env.DB, first.run.id)).toMatchObject({
      status: "completed",
      errorCode: null,
    });
    expect(await syncJob()).toMatchObject({
      locked_by: null,
      lock_phase: null,
      last_status: "success",
    });
    expect((await startQueuedManualSync(env, "esun")).created).toBe(true);
  });

  it("需要使用者處理時保存錯誤代碼；Browser 容量不足在登入前放回佇列，不記為失敗", async () => {
    await harness.binding
      .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = 'esun:all'")
      .run();
    mocks.runConnectorSync.mockRejectedValueOnce(
      new ManualCaptchaRequiredError("請輸入驗證碼。"),
    );
    const captcha = await startQueuedManualSync(env, "esun");
    await processQueuedManualSync(env, captcha.run.id);
    expect(await getManualSyncRun(env.DB, captcha.run.id)).toMatchObject({
      status: "needs_user_action",
      errorCode: "MANUAL_CAPTCHA_REQUIRED",
      lastError: "請輸入驗證碼。",
    });
    expect(await syncJob()).toMatchObject({
      enabled: 0,
      locked_by: null,
      last_status: "needs_user_action",
      last_error_code: "MANUAL_CAPTCHA_REQUIRED",
    });
    expect(
      (await getSyncJobs(env.DB)).find((job) => job.id === "esun:all"),
    ).toMatchObject({
      running: false,
      lastErrorCode: "MANUAL_CAPTCHA_REQUIRED",
      manualRun: { id: captcha.run.id, status: "needs_user_action" },
    });

    mocks.runConnectorSync.mockRejectedValue(
      new BrowserRunCapacityError("rate_limit", 45),
    );
    const busy = await startQueuedManualSync(env, "esun");
    expect(await processQueuedManualSync(env, busy.run.id)).toEqual({
      status: "busy",
      retryAfterSeconds: 45,
    });
    expect(await getManualSyncRun(env.DB, busy.run.id)).toMatchObject({
      status: "queued",
      retryCount: 1,
    });
    expect(await syncJob()).toMatchObject({
      locked_by: null,
      last_status: "needs_user_action",
    });

    await processQueuedManualSync(env, busy.run.id);
    expect(await processQueuedManualSync(env, busy.run.id)).toEqual({
      status: "done",
    });
    expect(await getManualSyncRun(env.DB, busy.run.id)).toMatchObject({
      status: "failed",
      errorCode: "BROWSER_BUSY",
    });
    expect(await syncJob()).toMatchObject({
      enabled: 0,
      last_status: "failed",
      last_error_code: "BROWSER_BUSY",
    });
  });

  it("放回佇列後、釋放自己的 lock 前，重送訊息不會取消此 run", async () => {
    mocks.runConnectorSync.mockResolvedValue(outcome);
    const requeued = await startQueuedManualSync(env, "esun");
    const ownLock = {
      lockRowId: "esun:all",
      scope: "all",
      trigger: "manual" as const,
      runId: requeued.run.id,
      leaseMs: 60_000,
    };
    expect(await acquireSyncJobLock(env.DB, ownLock)).toBe(true);

    expect(await processQueuedManualSync(env, requeued.run.id)).toEqual({
      status: "done",
    });
    expect(await getManualSyncRun(env.DB, requeued.run.id)).toMatchObject({
      status: "queued",
    });

    await harness.binding
      .prepare("UPDATE manual_sync_runs SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 31 * 60_000).toISOString(), requeued.run.id)
      .run();
    await processQueuedManualSync(env, requeued.run.id);
    await recoverStalledSyncRuns(env);
    expect(await getManualSyncRun(env.DB, requeued.run.id)).toMatchObject({
      status: "queued",
    });
    expect(mocks.runConnectorSync).not.toHaveBeenCalled();

    await releaseSyncJobLock(env.DB, ownLock.lockRowId, ownLock.runId);
    await processQueuedManualSync(env, requeued.run.id);
    expect(await getManualSyncRun(env.DB, requeued.run.id)).toMatchObject({
      status: "failed",
      errorCode: "SYNC_QUEUE_TIMEOUT",
    });
  });

  it("容量等待超過剩餘排隊時間時直接失敗，不重新排隊", async () => {
    mocks.runConnectorSync.mockRejectedValue(
      new BrowserRunCapacityError("daily_quota", 12 * 60 * 60),
    );
    const exhausted = await startQueuedManualSync(env, "esun");
    expect(await processQueuedManualSync(env, exhausted.run.id)).toEqual({
      status: "done",
    });
    expect(await getManualSyncRun(env.DB, exhausted.run.id)).toMatchObject({
      status: "failed",
      errorCode: "BROWSER_BUSY",
      retryCount: 0,
    });
    expect(await syncJob()).toMatchObject({
      last_status: "failed",
      last_error_code: "BROWSER_BUSY",
    });
  });

  it("中斷與排隊逾時的 run 由 recovery 結案，之後可以重新排入", async () => {
    const interrupted = await startQueuedManualSync(env, "esun");
    await acquireSyncJobLock(env.DB, {
      lockRowId: "esun:all",
      scope: "all",
      trigger: "manual",
      runId: interrupted.run.id,
      leaseMs: 60_000,
    });
    expect(await claimManualSyncRun(env.DB, interrupted.run.id)).toBe(true);
    await harness.binding
      .prepare("UPDATE sync_jobs SET locked_until = ? WHERE id = 'esun:all'")
      .bind(new Date(Date.now() - 1_000).toISOString())
      .run();
    await recoverStalledSyncRuns(env);
    expect(await getManualSyncRun(env.DB, interrupted.run.id)).toMatchObject({
      status: "failed",
      errorCode: "SYNC_INTERRUPTED",
    });
    expect(await syncJob()).toMatchObject({
      locked_by: null,
      last_status: "failed",
    });

    const stale = await startQueuedManualSync(env, "esun");
    await harness.binding
      .prepare("UPDATE manual_sync_runs SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 31 * 60_000).toISOString(), stale.run.id)
      .run();
    await recoverStalledSyncRuns(env);
    expect(await getManualSyncRun(env.DB, stale.run.id)).toMatchObject({
      status: "failed",
      errorCode: "SYNC_QUEUE_TIMEOUT",
    });
    expect((await startQueuedManualSync(env, "esun")).created).toBe(true);
    expect(mocks.runConnectorSync).not.toHaveBeenCalled();
  });
});
