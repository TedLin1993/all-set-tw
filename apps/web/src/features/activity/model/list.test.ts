import { describe, expect, it } from "vitest";
import {
  activityStatusLabel,
  formatActivityDateGroup,
  groupActivitiesByDate,
} from "./list";
import type { ActivityItem } from "./types";

function item(id: string, date: string): ActivityItem {
  return {
    id,
    source: "bank",
    date,
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
