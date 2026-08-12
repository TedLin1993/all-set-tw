import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  acquireEinvoiceRunChunkLease: vi.fn(),
  claimEinvoiceRunSessionRefresh: vi.fn(),
  claimEinvoiceRunItems: vi.fn(),
  decryptJson: vi.fn(),
  encryptJson: vi.fn(),
  fetchEInvoiceInvoiceDetail: vi.fn(),
  getEinvoiceRun: vi.fn(),
  getConnectorSettings: vi.fn(),
  initializeEInvoiceSync: vi.fn(),
  markEinvoiceRunItemsSucceeded: vi.fn(),
  releaseEinvoiceRunClaimForRetry: vi.fn(),
  releaseEinvoiceRunChunkLease: vi.fn(),
  resetEinvoiceRunSession: vi.fn(),
  renewEinvoiceRunChunkLease: vi.fn(),
  transitionEinvoiceRunStatus: vi.fn(),
  holdRunResult: { meta: { changes: 1 } },
}));

vi.mock("@taiwan-fin-hub/connectors", () => ({
  EInvoiceV2Client: class EInvoiceV2Client {},
  fetchEInvoiceInvoiceDetail: mocks.fetchEInvoiceInvoiceDetail,
  initializeEInvoiceSync: mocks.initializeEInvoiceSync,
  parseInvoiceConfig: (config: unknown) => config,
}));

vi.mock("@taiwan-fin-hub/db", () => ({
  getConnectorSettings: mocks.getConnectorSettings,
  nextSyncRunAt: vi.fn(),
}));

vi.mock("../../../src/features/sync/einvoice-run-repository", () => ({
  acquireEinvoiceRunChunkLease: mocks.acquireEinvoiceRunChunkLease,
  claimEinvoiceRunItems: mocks.claimEinvoiceRunItems,
  claimEinvoiceRunSessionRefresh: mocks.claimEinvoiceRunSessionRefresh,
  completeEinvoiceRun: vi.fn(),
  createOrGetActiveEinvoiceRun: vi.fn(),
  getEinvoiceRun: mocks.getEinvoiceRun,
  initializeEinvoiceRun: vi.fn(),
  listCompletedEinvoiceRunItems: vi.fn(),
  markEinvoiceRunItemsSucceeded: mocks.markEinvoiceRunItemsSucceeded,
  releaseEinvoiceRunClaimForRetry: mocks.releaseEinvoiceRunClaimForRetry,
  releaseEinvoiceRunChunkLease: mocks.releaseEinvoiceRunChunkLease,
  renewEinvoiceRunChunkLease: mocks.renewEinvoiceRunChunkLease,
  resetEinvoiceRunSession: mocks.resetEinvoiceRunSession,
  promoteEinvoiceRunRecords: vi.fn(),
  transitionEinvoiceRunStatus: mocks.transitionEinvoiceRunStatus,
}));

vi.mock("../../../src/features/sync/notification-batch-repository", () => ({
  claimCompletedDefaultScheduleBatch: vi.fn(),
}));

vi.mock("../../../src/features/notifications/service", () => ({
  safelySendScheduledSyncSummary: vi.fn(),
  safelySendSyncNotification: vi.fn(),
}));

vi.mock("../../../src/features/sync/schedule-repository", () => ({
  findSyncJob: vi.fn(),
}));

vi.mock("../../../src/platform/crypto", () => ({
  decryptJson: mocks.decryptJson,
  encryptJson: mocks.encryptJson,
}));

import {
  EINVOICE_DETAIL_CHUNK_SIZE,
  processEinvoiceSyncChunk,
} from "../../../src/features/sync/einvoice-sync-service";

const preparedStatements: Array<{
  sql: string;
  bind: ReturnType<typeof vi.fn>;
}> = [];

function env(): Env {
  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        const run = vi.fn().mockResolvedValue(mocks.holdRunResult);
        const bind = vi.fn(() => ({ run }));
        preparedStatements.push({ sql, bind });
        return { bind };
      }),
    } as unknown as D1Database,
    CONFIG_ENCRYPTION_KEY: "test-key",
  } as Env;
}

function claimedItem(index: number) {
  return {
    invoice_source_id: `invoice-${index}`,
    detail_metadata_json: JSON.stringify({ sourceId: `invoice-${index}` }),
  };
}

function detailResult(index: number) {
  return {
    invoice: {
      sourceId: `invoice-${index}`,
      raw: { source: "list" },
    },
    detail: { source: "detail" },
    detailItems: [{ description: `item-${index}` }],
    invoiceLineItems: [{ sourceId: `line-${index}` }],
  };
}

function persistedSessionConfig() {
  return {
    mobile: "0912345678",
    password: "secret",
    sid: "123456789012345678",
    token: "x".repeat(44),
    loginAppId: "app",
    loginLiat: 1,
    loginSsMe: "secret",
    mobileBarcode: "/ABC",
  };
}

describe("e-invoice chunk sync service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preparedStatements.length = 0;
    mocks.getConnectorSettings.mockResolvedValue({
      encrypted_config: "encrypted",
      sync_cursor: null,
      updated_at: "2026-08-12T00:00:00.000Z",
    });
    mocks.acquireEinvoiceRunChunkLease.mockResolvedValue(true);
    mocks.claimEinvoiceRunSessionRefresh.mockResolvedValue(false);
    mocks.decryptJson.mockResolvedValue(persistedSessionConfig());
    mocks.encryptJson.mockResolvedValue("refreshed-encrypted-config");
    mocks.initializeEInvoiceSync.mockResolvedValue({
      configUpdates: {},
      headers: [],
      detailTasks: [],
    });
    mocks.releaseEinvoiceRunChunkLease.mockResolvedValue(true);
    mocks.resetEinvoiceRunSession.mockResolvedValue({
      settingsUpdated: true,
      transitioned: true,
    });
    mocks.renewEinvoiceRunChunkLease.mockResolvedValue(true);
    mocks.transitionEinvoiceRunStatus.mockResolvedValue(true);
    mocks.getEinvoiceRun.mockResolvedValue({
      id: "run-1",
      trigger: "manual",
      status: "processing",
      settings_version: "2026-08-12T00:00:00.000Z",
      total_item_count: 36,
      pending_item_count: 36,
      processing_item_count: 0,
      done_item_count: 0,
      promoted_at: null,
    });
    mocks.claimEinvoiceRunItems.mockResolvedValue([]);
    mocks.fetchEInvoiceInvoiceDetail.mockImplementation(
      async (_session, task: { sourceId: string }) =>
        detailResult(Number(task.sourceId.replace("invoice-", ""))),
    );
    mocks.markEinvoiceRunItemsSucceeded.mockResolvedValue(0);
    mocks.releaseEinvoiceRunClaimForRetry.mockResolvedValue(0);
  });

  it("claims no more than the configured safe detail batch size", async () => {
    await expect(processEinvoiceSyncChunk(env(), "run-1")).resolves.toEqual({
      status: "continue",
    });

    expect(mocks.claimEinvoiceRunItems).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: "run-1",
        limit: EINVOICE_DETAIL_CHUNK_SIZE,
      }),
    );
    expect(EINVOICE_DETAIL_CHUNK_SIZE).toBe(35);
  });

  it("renews the run lease at indexes 0, 5, and 10 before set-based completion", async () => {
    const order: string[] = [];
    const claimed = Array.from({ length: 11 }, (_, index) =>
      claimedItem(index),
    );
    mocks.claimEinvoiceRunItems.mockResolvedValue(claimed);
    mocks.renewEinvoiceRunChunkLease.mockImplementation(async () => {
      order.push("renew");
      return true;
    });
    mocks.fetchEInvoiceInvoiceDetail.mockImplementation(
      async (_session, task: { sourceId: string }) => {
        const index = Number(task.sourceId.replace("invoice-", ""));
        order.push(`fetch-${index}`);
        return detailResult(index);
      },
    );
    mocks.markEinvoiceRunItemsSucceeded.mockImplementation(async () => {
      order.push("mark");
      return claimed.length;
    });

    await expect(
      processEinvoiceSyncChunk(env(), "run-1", "queue-message-1"),
    ).resolves.toEqual({ status: "continue" });

    const claimToken = mocks.claimEinvoiceRunItems.mock.calls[0]![1].claimToken;
    expect(order).toEqual([
      "renew",
      "fetch-0",
      "fetch-1",
      "fetch-2",
      "fetch-3",
      "fetch-4",
      "renew",
      "fetch-5",
      "fetch-6",
      "fetch-7",
      "fetch-8",
      "fetch-9",
      "renew",
      "fetch-10",
      "mark",
    ]);
    expect(mocks.renewEinvoiceRunChunkLease).toHaveBeenCalledTimes(3);
    for (let call = 1; call <= 3; call += 1) {
      expect(mocks.renewEinvoiceRunChunkLease).toHaveBeenNthCalledWith(
        call,
        expect.anything(),
        {
          runId: "run-1",
          owner: "queue-message-1",
          leaseMs: 3 * 60 * 1000,
        },
      );
    }
    expect(mocks.markEinvoiceRunItemsSucceeded).toHaveBeenCalledOnce();
    expect(mocks.markEinvoiceRunItemsSucceeded.mock.calls[0]![1]).toMatchObject(
      {
        runId: "run-1",
        claimToken,
        items: claimed.map((item) => ({
          invoiceSourceId: item.invoice_source_id,
        })),
      },
    );
    expect(mocks.releaseEinvoiceRunClaimForRetry).not.toHaveBeenCalled();
  });

  it("releases the whole claim and skips completion when a renewal is lost", async () => {
    const claimed = Array.from({ length: 11 }, (_, index) =>
      claimedItem(index),
    );
    mocks.claimEinvoiceRunItems.mockResolvedValue(claimed);
    mocks.renewEinvoiceRunChunkLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      processEinvoiceSyncChunk(env(), "run-1", "queue-message-1"),
    ).rejects.toThrow("Electronic invoice detail chunk lease was lost.");

    const claimToken = mocks.claimEinvoiceRunItems.mock.calls[0]![1].claimToken;
    expect(mocks.fetchEInvoiceInvoiceDetail).toHaveBeenCalledTimes(5);
    expect(mocks.releaseEinvoiceRunClaimForRetry).toHaveBeenCalledWith(
      expect.anything(),
      {
        runId: "run-1",
        claimToken,
        error: "Electronic invoice detail chunk lease was lost.",
      },
    );
    expect(mocks.markEinvoiceRunItemsSucceeded).not.toHaveBeenCalled();
  });

  it("continues with the pinned settings version and updates progress without changing updated_at", async () => {
    await expect(
      processEinvoiceSyncChunk(env(), "run-1", "queue-message-1"),
    ).resolves.toEqual({ status: "continue" });

    expect(mocks.getConnectorSettings).toHaveBeenCalledWith(
      expect.anything(),
      "einvoice",
    );
    const progressStatement = preparedStatements.find(({ sql }) =>
      sql.includes("UPDATE connector_settings SET sync_cursor"),
    );
    expect(progressStatement).toBeDefined();
    const normalizedSql = progressStatement!.sql.replace(/\s+/g, " ").trim();
    expect(normalizedSql.split(" WHERE ")[0]).toBe(
      "UPDATE connector_settings SET sync_cursor = ?",
    );
    const [cursor, expectedVersion, pinnedVersion] =
      progressStatement!.bind.mock.calls[0]!;
    expect(JSON.parse(cursor as string)).toMatchObject({
      activeRunId: "run-1",
      phase: "processing",
    });
    expect(expectedVersion).toBe("2026-08-12T00:00:00.000Z");
    expect(pinnedVersion).toBe("2026-08-12T00:00:00.000Z");
  });

  it("refreshes one expired persisted session while initializing headers", async () => {
    mocks.getEinvoiceRun.mockResolvedValueOnce({
      id: "run-1",
      trigger: "manual",
      status: "queued",
      settings_version: null,
      total_item_count: 0,
      pending_item_count: 0,
      processing_item_count: 0,
      done_item_count: 0,
      promoted_at: null,
    });
    mocks.initializeEInvoiceSync.mockRejectedValueOnce(new Error("HTTP 401"));
    mocks.claimEinvoiceRunSessionRefresh.mockResolvedValueOnce(true);

    await expect(
      processEinvoiceSyncChunk(env(), "run-1", "queue-message-1"),
    ).resolves.toEqual({ status: "continue" });

    expect(mocks.transitionEinvoiceRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { runId: "run-1", from: "queued", to: "initializing" },
    );
    expect(mocks.initializeEInvoiceSync).toHaveBeenCalledOnce();
    expect(mocks.claimEinvoiceRunSessionRefresh).toHaveBeenCalledOnce();
    expect(mocks.claimEinvoiceRunSessionRefresh).toHaveBeenCalledWith(
      expect.anything(),
      { runId: "run-1", maxRefreshes: 1 },
    );
    expect(mocks.resetEinvoiceRunSession).toHaveBeenCalledWith(
      expect.anything(),
      {
        runId: "run-1",
        encryptedConfig: "refreshed-encrypted-config",
        expectedSettingsUpdatedAt: "2026-08-12T00:00:00.000Z",
      },
    );
    expect(mocks.claimEinvoiceRunItems).not.toHaveBeenCalled();
  });

  it("does not auto-refresh a fresh login failure without a persisted session", async () => {
    mocks.getEinvoiceRun.mockResolvedValueOnce({
      id: "run-1",
      trigger: "manual",
      status: "queued",
      settings_version: null,
      total_item_count: 0,
      pending_item_count: 0,
      processing_item_count: 0,
      done_item_count: 0,
      promoted_at: null,
    });
    mocks.decryptJson.mockResolvedValueOnce({
      mobile: "0912345678",
      password: "secret",
      mobileBarcode: "/ABC",
    });
    mocks.initializeEInvoiceSync.mockRejectedValueOnce(new Error("HTTP 401"));

    await expect(
      processEinvoiceSyncChunk(env(), "run-1", "queue-message-1"),
    ).rejects.toThrow("HTTP 401");

    expect(mocks.transitionEinvoiceRunStatus).toHaveBeenCalledWith(
      expect.anything(),
      { runId: "run-1", from: "queued", to: "initializing" },
    );
    expect(mocks.claimEinvoiceRunSessionRefresh).not.toHaveBeenCalled();
    expect(mocks.resetEinvoiceRunSession).not.toHaveBeenCalled();
    expect(mocks.claimEinvoiceRunItems).not.toHaveBeenCalled();
  });
});
