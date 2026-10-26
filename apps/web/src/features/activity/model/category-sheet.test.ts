import { describe, expect, it } from "vitest";
import { buildActivityCategorySlices } from "./chart";
import {
  activityCategoryItemsForMonth,
  activityCategorySixMonthSeries,
} from "./category-sheet";
import type { ActivityItem } from "./types";

function item(overrides: Partial<ActivityItem>): ActivityItem {
  return {
    id: "1",
    source: "bank",
    date: "2026-07-01",
    title: "交易",
    subtitle: "",
    amount: 0,
    currency: "TWD",
    category: "未分類",
    status: "posted",
    ...overrides,
  };
}

describe("category sheet data", () => {
  it("sums to the matching slice amount, including a refund, a foreign amount and excluded items", () => {
    const items = [
      item({ id: "1", source: "card", amount: -1_000, category: "交通" }),
      item({
        id: "2",
        source: "card",
        amount: 300,
        category: "交通",
        refund: true,
      }),
      item({
        id: "3",
        source: "card",
        amount: -10,
        currency: "USD",
        category: "交通",
      }),
      item({ id: "4", source: "invoice", amount: 200, category: "交通" }),
      item({ id: "5", source: "card", amount: -500, category: "餐飲" }),
      // 不計入統計、非銀行／信用卡／發票來源：圓餅與清單都不計
      item({
        id: "6",
        source: "card",
        amount: -400,
        category: "交通",
        excludedFromCalculation: true,
      }),
      item({ id: "7", source: "investment", amount: -600, category: "交通" }),
    ];
    const rates = { USD: 32 };

    const rows = activityCategoryItemsForMonth(
      items,
      "expense",
      "交通",
      "2026-07",
      rates,
    );
    const slice = buildActivityCategorySlices(items, "expense", rates).find(
      (candidate) => candidate.category === "交通",
    );

    // 退款在支出端為負數；外幣 10 USD 以匯率 32 換算成 320
    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([
      -300, 200, 320, 1_000,
    ]);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(1_220);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(slice?.amount);
  });

  it("builds a six month series aligned to the given month keys, zero when empty", () => {
    const monthKeys = [
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ];
    const series = activityCategorySixMonthSeries(
      [
        item({ id: "1", date: "2026-05-10", category: "餐飲", amount: -100 }),
        item({ id: "2", date: "2026-06-10", category: "餐飲", amount: -300 }),
        item({
          id: "3",
          source: "card",
          date: "2026-06-12",
          category: "餐飲",
          amount: 50,
          refund: true,
        }),
        item({ id: "4", date: "2026-06-15", category: "交通", amount: -50 }),
        item({
          id: "5",
          date: "2026-07-10",
          category: "餐飲",
          amount: -200,
          excludedFromCalculation: true,
        }),
        item({ id: "6", date: "2026-07-11", category: "餐飲", amount: -250 }),
      ],
      "expense",
      "餐飲",
      monthKeys,
      {},
    );

    expect(series.map((point) => point.month)).toEqual(monthKeys);
    expect(series.map((point) => point.amount)).toEqual([
      0, 0, 0, 100, 250, 250,
    ]);
  });
});
