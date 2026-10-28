import { describe, expect, it } from "vitest";
import {
  activityAmountTwd,
  activityCashAmountTwd,
  activityCashFlow,
  activityDisplayAmount,
  activityFlowTotalTwd,
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
  it("keeps nonzero foreign amounts unavailable without an exchange rate", () => {
    for (const amount of [100, -100]) {
      expect(
        activityAmountTwd(item({ amount, currency: "HKD" }), {}),
      ).toBeUndefined();
    }
  });

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

  it("退費從同分類支出扣除；只有退費的分類不畫扇形但仍扣減總額", () => {
    const items = [
      item({ source: "card", amount: -1_000, category: "交通" }),
      item({ source: "card", amount: 900, category: "交通", refund: true }),
      item({ source: "card", amount: -500, category: "餐飲" }),
      item({ source: "card", amount: 200, category: "購物", refund: true }),
    ];

    expect(activityCashFlow(items[1])).toBe("expense");
    expect(buildActivityCategorySlices(items, "income", {})).toEqual([]);
    expect(
      buildActivityCategorySlices(items, "expense", {}).map(
        ({ category, amount }) => [category, amount],
      ),
    ).toEqual([
      ["餐飲", 500],
      ["交通", 100],
    ]);
    expect(activityFlowTotalTwd(items, "expense", {})).toBe(400);
    expect(activityFlowTotalTwd(items, "income", {})).toBe(0);
  });

  it("counts manual records in the pie and monthly totals with the same amounts", () => {
    const items = [
      item({ id: "bank", amount: -300, category: "餐飲" }),
      item({ id: "cash", source: "manual", amount: -120, category: "餐飲" }),
      item({ id: "tip", source: "manual", amount: 500, category: "其他收入" }),
      item({
        id: "skipped",
        source: "manual",
        amount: -999,
        category: "餐飲",
        excludedFromCalculation: true,
      }),
    ];
    const expense = buildActivityCategorySlices(items, "expense", {});
    const income = buildActivityCategorySlices(items, "income", {});

    expect(expense).toMatchObject([{ category: "餐飲", amount: 420 }]);
    expect(income).toMatchObject([{ category: "其他收入", amount: 500 }]);
    expect(activityFlowTotalTwd(items, "expense", {})).toBe(420);
    expect(activityFlowTotalTwd(items, "income", {})).toBe(500);
  });
});
