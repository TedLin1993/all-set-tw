import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renewSyncJobLock = vi.hoisted(() => vi.fn());
vi.mock("@taiwan-fin-hub/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@taiwan-fin-hub/db")>()),
  renewSyncJobLock,
}));

import {
  DURABLE_SYNC_LOCK_LEASE_MS,
  startSyncLockHeartbeat,
  SYNC_LOCK_LEASE_MS,
} from "../../../src/features/sync/service";

const db = {} as D1Database;

describe("sync lock heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renewSyncJobLock.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps single-invocation leases short so interrupted runs unblock sooner", () => {
    expect(SYNC_LOCK_LEASE_MS).toBe(10 * 60 * 1000);
    expect(DURABLE_SYNC_LOCK_LEASE_MS).toBe(30 * 60 * 1000);
  });

  it("renews every two minutes with the short lease until stopped", async () => {
    const stop = startSyncLockHeartbeat(db, "esun:all", "run-1");

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
    expect(renewSyncJobLock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renewSyncJobLock).toHaveBeenCalledExactlyOnceWith(db, {
      lockRowId: "esun:all",
      runId: "run-1",
      leaseMs: SYNC_LOCK_LEASE_MS,
    });

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(renewSyncJobLock).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(renewSyncJobLock).toHaveBeenCalledTimes(2);
  });

  it("logs when ownership was lost", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renewSyncJobLock.mockResolvedValueOnce(false);
    const stop = startSyncLockHeartbeat(db, "esun:all", "run-1");

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    stop();

    expect(error).toHaveBeenCalledWith(
      "[sync] lock heartbeat lost for esun:all",
    );
  });
});
