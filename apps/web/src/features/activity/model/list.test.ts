import { describe, expect, it } from "vitest";
import {
  activityDateKey,
  activityStatusLabel,
  compareActivityItems,
  formatActivityDate,
  formatActivityTime,
  formatActivityDateGroup,
  groupActivitiesByDate,
} from "./list";
import type { ActivityItem } from "./types";

function item(id: string, date: string, dateHasTime = false): ActivityItem {
  return {
    id,
    source: "bank",
    date,
    dateHasTime,
    title: id,
    subtitle: "",
    currency: "TWD",
    category: "未分類",
    status: "posted",
  };
}

describe("activity list", () => {
  it("groups sorted activities by their financial date", () => {
    const groups = groupActivitiesByDate([
      item("a", "2026-07-28T12:00:00+08:00"),
      item("b", "2026-07-28"),
      item("c", "2026-07-27"),
    ]);

    expect(groups.map((group) => [group.dateKey, group.items.length])).toEqual([
      ["2026-07-28", 2],
      ["2026-07-27", 1],
    ]);
  });

  it("uses Taipei date keys and sorts reliable times before date-only items", () => {
    const late = item("late", "2026-07-28T06:00:00Z", true);
    const early = item("early", "2026-07-28T07:00:00+08:00", true);
    const dateOnly = item("date-only", "2026-07-28");
    const items = [
      dateOnly,
      early,
      late,
      item("next-day-utc", "2026-07-28T16:30:00Z", true),
    ].sort(compareActivityItems);
    const groups = groupActivitiesByDate(items);

    expect(groups.map(({ dateKey }) => dateKey)).toEqual([
      "2026-07-29",
      "2026-07-28",
    ]);
    expect(groups[1]?.items.map(({ id }) => id)).toEqual([
      "late",
      "early",
      "date-only",
    ]);
    expect(activityDateKey(late)).toBe("2026-07-28");
    expect(formatActivityTime(late)).toBe("14:00");
    expect(formatActivityDate(late)).toBe("7 月 28 日・週二 · 14:00");
  });

  it("does not infer a bank time from a legacy posted-date midnight", () => {
    const legacy = item("legacy", "2026-07-28T00:00:00.000Z");

    expect(formatActivityTime(legacy)).toBeUndefined();
    expect(formatActivityDate(legacy)).toBe("7 月 28 日・週二");
  });

  it("allows an explicitly marked authorized timestamp", () => {
    const authorized = {
      ...item("authorized", "2026-07-28T01:05:00.000Z"),
      dateHasTime: true,
    };

    expect(formatActivityTime(authorized)).toBe("09:05");
  });

  it("formats date groups and transaction statuses for display", () => {
    expect(formatActivityDateGroup("2026-07-28")).toBe("7 月 28 日・週二");
    expect(formatActivityDateGroup("")).toBe("日期未提供");
    expect(activityStatusLabel(item("pending", "2026-07-28"))).toBe("已入帳");
    expect(
      activityStatusLabel({
        ...item("matched", "2026-07-28"),
        source: "card",
        invoiceId: "invoice-1",
      }),
    ).toBe("已配對發票");
    expect(
      activityStatusLabel({
        ...item("pending", "2026-07-28"),
        status: "pending",
      }),
    ).toBe("待入帳");
    expect(
      activityStatusLabel({
        ...item("complete", "2026-07-28"),
        status: "已完成",
      }),
    ).toBe("已完成");
  });
});
