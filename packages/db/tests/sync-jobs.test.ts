import { describe, expect, it } from "vitest";
import { nextSyncRunAt } from "../src/sync-jobs";

describe("nextSyncRunAt", () => {
  it("keeps a daily schedule anchored to Asia/Taipei time", () => {
    expect(
      nextSyncRunAt(
        1440,
        "06:50",
        new Date("2026-07-17T00:05:00.000Z"),
        "2026-07-16T22:50:00.000Z",
      ),
    ).toBe("2026-07-17T22:50:00.000Z");
  });

  it("does not postpone an already-future anchored run after manual sync", () => {
    expect(
      nextSyncRunAt(
        1440,
        "06:50",
        new Date("2026-07-17T07:00:00.000Z"),
        "2026-07-17T22:50:00.000Z",
      ),
    ).toBe("2026-07-17T22:50:00.000Z");
  });

  it("uses rolling intervals for sub-daily schedules", () => {
    expect(
      nextSyncRunAt(360, "06:50", new Date("2026-07-17T00:00:00.000Z")),
    ).toBe("2026-07-17T06:00:00.000Z");
  });

  it("anchors weekly schedules to the selected Taipei weekday", () => {
    expect(
      nextSyncRunAt(
        10080,
        "06:50",
        new Date("2026-07-17T00:00:00.000Z"),
        undefined,
        1,
      ),
    ).toBe("2026-07-19T22:50:00.000Z");
  });
});

describe("weekly multiple days", () => {
  it("selects the next day across Taipei midnight and skips the exact run time", () => {
    expect(
      nextSyncRunAt(
        10080,
        "06:00",
        new Date("2026-09-27T22:00:00Z"),
        undefined,
        1,
        [1, 3, 5],
      ),
    ).toBe("2026-09-29T22:00:00.000Z");
    expect(
      nextSyncRunAt(
        10080,
        "06:00",
        new Date("2026-10-02T22:00:00Z"),
        undefined,
        1,
        [1, 3, 5],
      ),
    ).toBe("2026-10-04T22:00:00.000Z");
    expect(
      nextSyncRunAt(
        10080,
        "06:00",
        new Date("2026-09-27T21:59:00Z"),
        undefined,
        1,
        [1, 3, 5],
      ),
    ).toBe("2026-09-27T22:00:00.000Z");
  });
});
