import type { ConnectorId } from "@taiwan-fin-hub/core";
import type { SyncJobRow } from "@taiwan-fin-hub/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  acquireSyncJobLock: vi.fn(),
  cancelQueuedEinvoiceSyncRun: vi.fn(),
  cancelQueuedTdccSyncRun: vi.fn(),
  claimCompletedDefaultScheduleBatch: vi.fn(),
  completeSyncJob: vi.fn(),
  ensureDefaultScheduleBatch: vi.fn(),
  failSyncJob: vi.fn(),
  finalizeOpenDefaultScheduleBatch: vi.fn(),
  findNextDefaultScheduleBatchJob: vi.fn(),
  findNextDueSyncJob: vi.fn(),
  findOpenDefaultScheduleBatchId: vi.fn(),
  recordDefaultScheduleBatchResult: vi.fn(),
  releaseSyncJobLock: vi.fn(),
  safelySendScheduledSyncSummary: vi.fn(),
  safelySendSyncNotification: vi.fn(),
  startEinvoiceSyncRun: vi.fn(),
  startTdccSyncRun: vi.fn(),
  startSyncLockHeartbeat: vi.fn(),
  syncCathaybk: vi.fn(),
  syncEsun: vi.fn(),
  syncTaishin: vi.fn(),
  syncSkbank: vi.fn(),
}));

vi.mock("../../../src/features/sync/einvoice-sync-service", () => ({
  cancelQueuedEinvoiceSyncRun: mocks.cancelQueuedEinvoiceSyncRun,
  startEinvoiceSyncRun: mocks.startEinvoiceSyncRun,
}));

vi.mock("../../../src/features/sync/tdcc-sync-service", () => ({
  cancelQueuedTdccSyncRun: mocks.cancelQueuedTdccSyncRun,
  startTdccSyncRun: mocks.startTdccSyncRun,
}));

vi.mock("@taiwan-fin-hub/db", () => ({
  acquireSyncJobLock: mocks.acquireSyncJobLock,
  completeSyncJob: mocks.completeSyncJob,
  failSyncJob: mocks.failSyncJob,
  findNextDueSyncJob: mocks.findNextDueSyncJob,
  releaseSyncJobLock: mocks.releaseSyncJobLock,
}));

vi.mock("../../../src/features/sync/service", () => ({
  canonicalSyncLockRowId: (connectorId: string) => `${connectorId}:all`,
  isUserActionError: () => false,
  NeedsUserActionError: class NeedsUserActionError extends Error {},
  prepareSinopacCaptchaSession: vi.fn(),
  prepareHncbCaptchaSession: vi.fn(),
  prepareTaishinCaptchaSession: vi.fn(),
  prepareObankCaptchaSession: vi.fn(),
  safeErrorLogDetails: (error: unknown) => ({
    errorName: error instanceof Error ? error.name : typeof error,
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  }),
  safeErrorMessage: (error: unknown) =>
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "同步失敗，但未取得錯誤原因。",
  startSyncLockHeartbeat: mocks.startSyncLockHeartbeat,
  syncCathaybk: mocks.syncCathaybk,
  syncEinvoice: vi.fn(),
  syncEsun: mocks.syncEsun,
  syncSinopac: vi.fn(),
  syncObank: vi.fn(),
  syncHncb: vi.fn(),
  syncTaishin: mocks.syncTaishin,
  syncSkbank: mocks.syncSkbank,
  syncTdcc: vi.fn(),
  SYNC_LOCK_LEASE_MS: 30 * 60 * 1000,
}));

vi.mock("../../../src/features/notifications/service", () => ({
  safelySendScheduledSyncSummary: mocks.safelySendScheduledSyncSummary,
  safelySendSyncNotification: mocks.safelySendSyncNotification,
}));

vi.mock("../../../src/features/sync/notification-batch-repository", () => ({
  claimCompletedDefaultScheduleBatch: mocks.claimCompletedDefaultScheduleBatch,
  ensureDefaultScheduleBatch: mocks.ensureDefaultScheduleBatch,
  finalizeOpenDefaultScheduleBatch: mocks.finalizeOpenDefaultScheduleBatch,
  findNextDefaultScheduleBatchJob: mocks.findNextDefaultScheduleBatchJob,
  findOpenDefaultScheduleBatchId: mocks.findOpenDefaultScheduleBatchId,
  recordDefaultScheduleBatchResult: mocks.recordDefaultScheduleBatchResult,
}));

import { runSchedulerTick } from "../../../src/features/sync/scheduler";

const scheduledController = {
  cron: "*/10 * * * *",
} as ScheduledController;

function syncJob(
  scheduleMode: "inherit" | "custom" = "inherit",
  connectorId: ConnectorId = "esun",
): SyncJobRow<ConnectorId> {
  return {
    id: `${connectorId}:all`,
    connector_id: connectorId,
    scope: "all",
    enabled: 1,
    interval_minutes: 60,
    next_run_at: "2026-07-23T00:00:00.000Z",
    schedule_mode: scheduleMode,
    preferred_time: "06:00",
    preferred_weekday: 1,
    locked_until: null,
    locked_by: null,
    lock_trigger: null,
    lock_scope: null,
    last_run_at: null,
    last_success_at: null,
    last_status: null,
    last_error: null,
    created_at: "2026-07-22T00:00:00.000Z",
    updated_at: "2026-07-22T00:00:00.000Z",
  };
}

function env(send = vi.fn().mockResolvedValue(undefined)) {
  return {
    DB: {} as D1Database,
    SYNC_QUEUE: { send } as unknown as Queue,
  } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finalizeOpenDefaultScheduleBatch.mockResolvedValue(null);
  mocks.acquireSyncJobLock.mockResolvedValue(true);
  mocks.completeSyncJob.mockResolvedValue(undefined);
  mocks.releaseSyncJobLock.mockResolvedValue(undefined);
  mocks.startSyncLockHeartbeat.mockReturnValue(vi.fn());
  mocks.startEinvoiceSyncRun.mockResolvedValue({
    run: { id: "einvoice-run-1" },
    created: true,
  });
  mocks.cancelQueuedEinvoiceSyncRun.mockResolvedValue(undefined);
  mocks.startTdccSyncRun.mockResolvedValue({
    run: { id: "tdcc-run-1" },
    created: true,
  });
  mocks.cancelQueuedTdccSyncRun.mockResolvedValue(undefined);
  mocks.syncEsun.mockResolvedValue({
    connectorId: "esun",
    scope: "all",
    records: 1,
    newRecords: {
      invoices: 0,
      bankTransactions: 1,
      investmentTransactions: 0,
    },
  });
  mocks.syncTaishin.mockResolvedValue({
    connectorId: "taishin",
    scope: "all",
    records: 2,
    newRecords: {
      invoices: 0,
      bankTransactions: 2,
      investmentTransactions: 0,
    },
  });
  mocks.syncCathaybk.mockResolvedValue({
    connectorId: "cathaybk",
    scope: "all",
    records: 2,
    newRecords: {
      invoices: 0,
      bankTransactions: 2,
      investmentTransactions: 0,
    },
  });
  mocks.recordDefaultScheduleBatchResult.mockResolvedValue(true);
  mocks.claimCompletedDefaultScheduleBatch.mockResolvedValue([
    { connectorId: "esun", status: "success" },
  ]);
});

describe("scheduled sync rounds", () => {
  it("persists a fallback and logs diagnostic details for an empty error", async () => {
    const job = syncJob("custom");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);
    mocks.syncEsun.mockRejectedValueOnce(new Error(""));

    await runSchedulerTick(env(), scheduledController);

    expect(mocks.failSyncJob).toHaveBeenCalledWith(expect.anything(), job, {
      status: "failed",
      errorMessage: "同步失敗，但未取得錯誤原因。",
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "sync_run_failed",
      connectorId: "esun",
      status: "failed",
      message: "同步失敗，但未取得錯誤原因。",
      errorName: "Error",
      stack: expect.stringContaining("Error"),
    });
  });

  it("records a default-round result before releasing the connector lock", async () => {
    const order: string[] = [];
    const job = syncJob();
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue("default:round");
    mocks.findNextDefaultScheduleBatchJob.mockResolvedValue(job);
    mocks.recordDefaultScheduleBatchResult.mockImplementation(async () => {
      order.push("record");
      return true;
    });
    mocks.releaseSyncJobLock.mockImplementation(async () => {
      order.push("release");
    });
    mocks.claimCompletedDefaultScheduleBatch.mockImplementation(async () => {
      order.push("claim");
      return [{ connectorId: "esun", status: "success" }];
    });

    await runSchedulerTick(env(), scheduledController);

    expect(order).toEqual(["record", "release", "claim"]);
    expect(mocks.findNextDueSyncJob).not.toHaveBeenCalled();
    expect(mocks.safelySendScheduledSyncSummary).toHaveBeenCalledOnce();
    expect(mocks.safelySendSyncNotification).not.toHaveBeenCalled();
  });

  it("starts one fixed default round when an inherited job becomes due", async () => {
    const job = syncJob();
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);
    mocks.ensureDefaultScheduleBatch.mockResolvedValue("default:new-round");
    mocks.findNextDefaultScheduleBatchJob.mockResolvedValue(job);

    await runSchedulerTick(env(), scheduledController);

    expect(mocks.ensureDefaultScheduleBatch).toHaveBeenCalledOnce();
    expect(mocks.recordDefaultScheduleBatchResult).toHaveBeenCalledWith(
      expect.anything(),
      {
        batchId: "default:new-round",
        jobId: job.id,
        notification: { connectorId: "esun", status: "success" },
        newRecords: {
          invoices: 0,
          bankTransactions: 1,
          investmentTransactions: 0,
        },
      },
    );
  });

  it("runs a due custom job when every open-round member is locked", async () => {
    const customJob = syncJob("custom");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue("default:round");
    mocks.findNextDefaultScheduleBatchJob.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(customJob);

    await runSchedulerTick(env(), scheduledController);

    expect(mocks.findNextDueSyncJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Date),
      "custom",
    );
    expect(mocks.safelySendSyncNotification).toHaveBeenCalledWith(
      expect.anything(),
      { connectorId: "esun", status: "success" },
    );
    expect(mocks.recordDefaultScheduleBatchResult).not.toHaveBeenCalled();
  });

  it("dispatches a scheduled Taishin job through the connector sync", async () => {
    const job = syncJob("custom", "taishin");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);

    await runSchedulerTick(env(), scheduledController);

    expect(mocks.syncTaishin).toHaveBeenCalledWith(
      expect.anything(),
      "scheduled",
      {},
    );
  });

  it("dispatches a scheduled Cathay job without OTP overrides", async () => {
    const job = syncJob("custom", "cathaybk");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);

    await runSchedulerTick(env(), scheduledController);

    expect(mocks.syncCathaybk).toHaveBeenCalledWith(
      expect.anything(),
      "scheduled",
      {},
    );
  });

  it("starts and enqueues a newly-created custom e-invoice durable run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const job = syncJob("custom", "einvoice");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);

    await expect(
      runSchedulerTick(env(send), scheduledController),
    ).resolves.toBe(true);

    expect(mocks.startEinvoiceSyncRun).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
    });
    expect(send).toHaveBeenCalledWith({
      type: "run-einvoice-chunk",
      runId: "einvoice-run-1",
    });
  });

  it("does not enqueue a reused custom e-invoice run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const job = syncJob("custom", "einvoice");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);
    mocks.startEinvoiceSyncRun.mockResolvedValueOnce({
      run: { id: "einvoice-running" },
      created: false,
    });

    await expect(
      runSchedulerTick(env(send), scheduledController),
    ).resolves.toBe(true);

    expect(send).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedEinvoiceSyncRun).not.toHaveBeenCalled();
  });

  it("requeues a reused custom TDCC run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const job = syncJob("custom", "tdcc");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);
    mocks.startTdccSyncRun.mockResolvedValueOnce({
      run: { id: "tdcc-running" },
      created: false,
    });

    await expect(
      runSchedulerTick(env(send), scheduledController),
    ).resolves.toBe(true);

    expect(send).toHaveBeenCalledWith({
      type: "run-tdcc-chunk",
      runId: "tdcc-running",
    });
    expect(mocks.cancelQueuedTdccSyncRun).not.toHaveBeenCalled();
  });

  it("preserves the default batch ID when starting an e-invoice durable run", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const job = syncJob("inherit", "einvoice");
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue(null);
    mocks.findNextDueSyncJob.mockResolvedValue(job);
    mocks.ensureDefaultScheduleBatch.mockResolvedValue("default:einvoice");
    mocks.findNextDefaultScheduleBatchJob.mockResolvedValue(job);

    await expect(
      runSchedulerTick(env(send), scheduledController),
    ).resolves.toBe(true);

    expect(mocks.startEinvoiceSyncRun).toHaveBeenCalledWith(expect.anything(), {
      trigger: "scheduled",
      scheduledBatchId: "default:einvoice",
    });
    expect(send).toHaveBeenCalledWith({
      type: "run-einvoice-chunk",
      runId: "einvoice-run-1",
    });
  });

  it("reports whether a job was processed so the queue can continue", async () => {
    const job = syncJob();
    mocks.findOpenDefaultScheduleBatchId.mockResolvedValue("default:round");
    mocks.findNextDefaultScheduleBatchJob.mockResolvedValue(job);

    await expect(runSchedulerTick(env(), scheduledController)).resolves.toBe(
      true,
    );

    mocks.acquireSyncJobLock.mockResolvedValue(false);
    await expect(runSchedulerTick(env(), scheduledController)).resolves.toBe(
      false,
    );
  });
});
