import { describe, expect, it } from "vitest";
import type { ActivityItem } from "./types";
import { countPendingActivityItems } from "./pending";

function item(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: "1",
    source: "bank",
    date: "2026-08-01",
    title: "交易",
    subtitle: "",
    amount: -100,
    currency: "TWD",
    category: "未分類",
    categoryId: "other",
    status: "posted",
    ...overrides,
  };
}

describe("countPendingActivityItems", () => {
  it("只計算選定月份的銀行與信用卡待分類活動", () => {
    expect(
      countPendingActivityItems(
        [
          item({ id: "aug-unclassified" }),
          item({
            id: "aug-pending",
            categoryId: "shopping",
            category: "購物",
            status: "pending",
          }),
          item({ id: "jul-unclassified", date: "2026-07-31" }),
          item({
            id: "aug-investment",
            source: "investment",
            status: "pending",
          }),
        ],
        "2026-08",
      ),
    ).toBe(2);
  });
});
