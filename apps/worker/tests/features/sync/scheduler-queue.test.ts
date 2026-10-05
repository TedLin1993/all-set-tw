import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledSyncQueueMessage } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  failEinvoiceSyncRun: vi.fn(),
  failTdccSyncRun: vi.fn(),
  isEinvoiceUserActionError: vi.fn(),
  processEinvoiceSyncChunk: vi.fn(),
  processTdccSyncChunk: vi.fn(),
  runSchedulerTick: vi.fn(),
  recoverStalledSyncRuns: vi.fn(),
}));

vi.mock("../../../src/features/sync/scheduling/scheduler", () => ({
  runSchedulerTick: mocks.runSchedulerTick,
}));
vi.mock("../../../src/features/sync/scheduling/recovery", () => ({
  recoverStalledSyncRuns: mocks.recoverStalledSyncRuns,
}));

vi.mock("../../../src/sources/einvoice/sync", () => ({
  failEinvoiceSyncRun: mocks.failEinvoiceSyncRun,
  isEinvoiceUserActionError: mocks.isEinvoiceUserActionError,
  processEinvoiceSyncChunk: mocks.processEinvoiceSyncChunk,
}));

vi.mock("../../../src/sources/tdcc/sync", () => ({
  failTdccSyncRun: mocks.failTdccSyncRun,
  processTdccSyncChunk: mocks.processTdccSyncChunk,
}));
import {
  consumeScheduledSyncQueue,
  DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS,
  enqueueScheduledSync,
} from "../../../src/features/sync/scheduling/queue";

function queueMessage(body: ScheduledSyncQueueMessage) {
  return {
    id: "message-1",
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<ScheduledSyncQueueMessage>;
}

function queueBatch(message: Message<ScheduledSyncQueueMessage>) {
  return {
    queue: "taiwan-fin-hub-sync",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<ScheduledSyncQueueMessage>;
}

function env(send = vi.fn().mockResolvedValue(undefined)) {
  return {
    DB: {} as D1Database,
    SYNC_QUEUE: { send } as unknown as Queue<ScheduledSyncQueueMessage>,
  } as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEinvoiceUserActionError.mockReturnValue(false);
  mocks.recoverStalledSyncRuns.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduled sync queue", () => {
  it("停滯恢復失敗仍會送出 scheduler kick", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mocks.recoverStalledSyncRuns.mockRejectedValueOnce(
      new Error("synthetic recovery failure"),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await enqueueScheduledSync(env(send));
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "run-next-scheduled-sync",
    });
  });
  it("does not enqueue the scheduler kick in demo mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await enqueueScheduledSync({ ...env(send), DEMO_MODE: "true" } as Env);

    expect(send).not.toHaveBeenCalled();
  });

  it("parks durable run chunks without running them in demo mode", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const kick = queueMessage({ type: "run-next-scheduled-sync" });
    const tdcc = queueMessage({ type: "run-tdcc-chunk", runId: "tdcc-run-1" });
    const einvoice = queueMessage({
      type: "run-einvoice-chunk",
      runId: "einvoice-run-1",
    });
    const batch = {
      ...queueBatch(kick),
      messages: [kick, tdcc, einvoice],
    } as unknown as MessageBatch<ScheduledSyncQueueMessage>;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await consumeScheduledSyncQueue(batch, {
      ...env(send),
      DEMO_MODE: "true",
    } as Env);

    for (const message of [kick, tdcc, einvoice]) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      { type: "run-tdcc-chunk", runId: "tdcc-run-1" },
      { delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS },
    );
    expect(send).toHaveBeenCalledWith(
      { type: "run-einvoice-chunk", runId: "einvoice-run-1" },
      { delaySeconds: DEMO_MODE_PARKED_CHUNK_DELAY_SECONDS },
    );
    expect(mocks.runSchedulerTick).not.toHaveBeenCalled();
    expect(mocks.processTdccSyncChunk).not.toHaveBeenCalled();
    expect(mocks.processEinvoiceSyncChunk).not.toHaveBeenCalled();
  });
});
