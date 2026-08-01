import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ScheduledSyncQueueMessage } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  runSchedulerTick: vi.fn(),
}));

vi.mock("../../../src/features/sync/scheduler", () => ({
  runSchedulerTick: mocks.runSchedulerTick,
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
});
