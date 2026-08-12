import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledSyncQueueMessage } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  failEinvoiceSyncRun: vi.fn(),
  isEinvoiceUserActionError: vi.fn(),
  processEinvoiceSyncChunk: vi.fn(),
  runSchedulerTick: vi.fn(),
}));

vi.mock("../../../src/features/sync/scheduler", () => ({
  runSchedulerTick: mocks.runSchedulerTick,
}));

vi.mock("../../../src/features/sync/einvoice-sync-service", () => ({
  failEinvoiceSyncRun: mocks.failEinvoiceSyncRun,
  isEinvoiceUserActionError: mocks.isEinvoiceUserActionError,
  processEinvoiceSyncChunk: mocks.processEinvoiceSyncChunk,
}));

import {
  consumeScheduledSyncQueue,
  enqueueScheduledSync,
} from "../../../src/features/sync/scheduler-queue";

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
});

describe("scheduled sync queue", () => {
  it("enqueues the scheduler kick message", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    await enqueueScheduledSync(env(send));

    expect(send).toHaveBeenCalledWith({ type: "run-next-scheduled-sync" });
  });

  it("delays the next invocation after processing a job", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage({ type: "run-next-scheduled-sync" });
    mocks.runSchedulerTick.mockResolvedValue(true);

    await consumeScheduledSyncQueue(queueBatch(message), env(send));

    expect(mocks.runSchedulerTick).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      { type: "run-next-scheduled-sync" },
      { delaySeconds: 20 },
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("ends the queue chain when no job was processed", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage({ type: "run-next-scheduled-sync" });
    mocks.runSchedulerTick.mockResolvedValue(false);

    await consumeScheduledSyncQueue(queueBatch(message), env(send));

    expect(send).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("sends the next e-invoice chunk before acknowledging the current one", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => order.push("send"));
    const message = queueMessage({
      type: "run-einvoice-chunk",
      runId: "run-1",
    });
    message.ack = vi.fn(() => order.push("ack"));
    mocks.processEinvoiceSyncChunk.mockResolvedValue({ status: "continue" });

    await consumeScheduledSyncQueue(queueBatch(message), env(send));

    expect(mocks.processEinvoiceSyncChunk).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      "message-1",
    );
    expect(send).toHaveBeenCalledWith(
      { type: "run-einvoice-chunk", runId: "run-1" },
      { delaySeconds: 1 },
    );
    expect(order).toEqual(["send", "ack"]);
  });

  it("retries transient e-invoice failures with a delay", async () => {
    const message = queueMessage({
      type: "run-einvoice-chunk",
      runId: "run-1",
    });
    mocks.processEinvoiceSyncChunk.mockRejectedValue(new Error("HTTP 503"));

    await consumeScheduledSyncQueue(queueBatch(message), env());

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 15 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(mocks.failEinvoiceSyncRun).not.toHaveBeenCalled();
  });

  it("marks an exhausted e-invoice message failed before acknowledging it", async () => {
    const message = {
      ...queueMessage({ type: "run-einvoice-chunk", runId: "run-1" }),
      attempts: 3,
    } as unknown as Message<ScheduledSyncQueueMessage>;
    mocks.processEinvoiceSyncChunk.mockRejectedValue(new Error("HTTP 503"));

    await consumeScheduledSyncQueue(queueBatch(message), env());

    expect(mocks.failEinvoiceSyncRun).toHaveBeenCalledWith(
      expect.anything(),
      "run-1",
      expect.any(Error),
      true,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate chunk that cannot acquire the run lease", async () => {
    const message = queueMessage({
      type: "run-einvoice-chunk",
      runId: "run-1",
    });
    mocks.processEinvoiceSyncChunk.mockResolvedValue({ status: "terminal" });

    await consumeScheduledSyncQueue(queueBatch(message), env());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mocks.failEinvoiceSyncRun).not.toHaveBeenCalled();
  });

  it("requeues an active chunk after its run lease expires", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => order.push("send"));
    const message = queueMessage({
      type: "run-einvoice-chunk",
      runId: "run-1",
    });
    message.ack = vi.fn(() => order.push("ack"));
    mocks.processEinvoiceSyncChunk.mockResolvedValue({
      status: "busy",
      retryAfterSeconds: 42,
    });

    await consumeScheduledSyncQueue(queueBatch(message), env(send));

    expect(send).toHaveBeenCalledWith(
      { type: "run-einvoice-chunk", runId: "run-1" },
      { delaySeconds: 42 },
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mocks.failEinvoiceSyncRun).not.toHaveBeenCalled();
    expect(order).toEqual(["send", "ack"]);
  });

  it("retries the original busy message when delayed requeue fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const message = queueMessage({
      type: "run-einvoice-chunk",
      runId: "run-1",
    });
    mocks.processEinvoiceSyncChunk.mockResolvedValue({
      status: "busy",
      retryAfterSeconds: 42,
    });

    await consumeScheduledSyncQueue(queueBatch(message), env(send));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 42 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(mocks.failEinvoiceSyncRun).not.toHaveBeenCalled();
  });
});
