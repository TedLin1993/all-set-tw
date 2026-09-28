import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import {
  editSyncJob,
  getDefaultSyncSchedule,
  getSyncJobs,
  setDefaultSyncSchedule,
} from "../../../src/features/sync/schedule-service";
import { syncScheduleRoutes } from "../../../src/features/sync/schedule-route";

describe("weekly schedule persistence", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  it("persists multiple days, propagates inheritance and retains custom schedules", async () => {
    const db = harness.binding;
    await editSyncJob(db, "obank", "all", {
      scheduleMode: "custom",
      intervalMinutes: 10080,
      preferredWeekdays: [2, 4],
    });
    await setDefaultSyncSchedule(db, {
      intervalMinutes: 10080,
      preferredTime: "06:00",
      preferredWeekday: 1,
      preferredWeekdays: [1, 3, 5],
    });
    expect((await getDefaultSyncSchedule(db)).preferredWeekdays).toEqual([
      1, 3, 5,
    ]);
    const jobs = await getSyncJobs(db);
    expect(
      jobs.find((job) => job.connectorId === "obank")?.preferredWeekdays,
    ).toEqual([2, 4]);
    expect(
      jobs.find((job) => job.connectorId === "esun")?.preferredWeekdays,
    ).toEqual([1, 3, 5]);
    await editSyncJob(db, "obank", "all", { enabled: false });
    expect(
      (await getSyncJobs(db)).find((job) => job.connectorId === "obank")
        ?.preferredWeekdays,
    ).toEqual([2, 4]);
    await editSyncJob(db, "obank", "all", { scheduleMode: "inherit" });
    expect(
      (await getSyncJobs(db)).find((job) => job.connectorId === "obank")
        ?.preferredWeekdays,
    ).toEqual([1, 3, 5]);
  });
  it("rejects empty, duplicate and out-of-range weekdays", async () => {
    for (const preferredWeekdays of [[], [1, 1], [7]]) {
      const response = await syncScheduleRoutes.request(
        "http://test/sync-schedule",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            intervalMinutes: 10080,
            preferredTime: "06:00",
            preferredWeekday: 1,
            preferredWeekdays,
          }),
        },
        { DB: harness.binding } as never,
      );
      expect(response.status).toBe(400);
    }
  });
});
