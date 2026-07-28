import { describe, expect, it } from "vitest";
import {
  activityCashAmountTwd,
  activityCashFlow,
  activityDisplayAmount,
  buildActivityCategorySlices,
} from "./chart";
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

describe("activity category chart", () => {
  it("converts cash flow to TWD and keeps invoices as expenses", () => {
    expect(
      activityCashAmountTwd(item({ amount: 10, currency: "USD" }), { USD: 32 }),
    ).toBe(320);
    expect(
      activityCashAmountTwd(item({ source: "card", amount: -500 }), {}),
    ).toBe(-500);
    expect(
      activityCashAmountTwd(item({ source: "invoice", amount: 500 }), {}),
    ).toBe(-500);
    expect(activityCashFlow(item({ source: "invoice", amount: 500 }))).toBe(
      "expense",
    );
  });

  it("treats a positive card discount as income in display and totals", () => {
    const discount = item({
      source: "card",
      amount: 63,
      category: "購物",
      title: "信用卡消費折抵_樂購蝦皮－daniel0329",
    });

    expect(activityDisplayAmount(discount)).toBe(63);
    expect(activityCashAmountTwd(discount, {})).toBe(63);
    expect(activityCashFlow(discount)).toBe("income");
    expect(buildActivityCategorySlices([discount], "expense", {})).toEqual([]);
    expect(buildActivityCategorySlices([discount], "income", {})).toEqual([
      {
        category: "購物",
        amount: 63,
        percentage: 100,
        color: "#3e6f7c",
      },
    ]);
  });

  it("groups categories and sorts them by amount descending", () => {
    const slices = buildActivityCategorySlices(
      [
        item({ amount: -100, category: "餐飲" }),
        item({ id: "2", amount: -300, category: "交通" }),
        item({ id: "3", amount: -50, category: "餐飲" }),
        item({ id: "4", amount: 900, category: "薪資" }),
      ],
      "expense",
      {},
    );

    expect(
      slices.map(({ category, amount }) => ({ category, amount })),
    ).toEqual([
      { category: "交通", amount: 300 },
      { category: "餐飲", amount: 150 },
    ]);
    expect(slices[0]?.percentage).toBeCloseTo(66.67, 1);
  });

  it("keeps excluded categories selectable without counting their amount", () => {
    const excluded = item({ amount: -500, excludedFromCalculation: true });

    expect(activityCashAmountTwd(excluded, {})).toBe(0);
    expect(activityCashFlow(excluded)).toBe("expense");
    expect(buildActivityCategorySlices([excluded], "expense", {})).toEqual([
      {
        category: "未分類",
        amount: 0,
        percentage: 0,
        color: "#3e6f7c",
      },
    ]);
  });

  it("sorts zero-value excluded categories after counted categories", () => {
    const slices = buildActivityCategorySlices(
      [
        item({ amount: -500, category: "餐飲" }),
        item({
          id: "2",
          amount: -300,
          category: "未分類",
          excludedFromCalculation: true,
        }),
      ],
      "expense",
      {},
    );

    expect(
      slices.map(({ category, amount, percentage }) => ({
        category,
        amount,
        percentage,
      })),
    ).toEqual([
      { category: "餐飲", amount: 500, percentage: 100 },
      { category: "未分類", amount: 0, percentage: 0 },
    ]);
  });
});
