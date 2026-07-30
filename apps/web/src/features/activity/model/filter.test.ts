import { describe, expect, it } from "vitest";
import { filterActivities, type ActivityListFilters } from "./filter";
import type { ActivityItem } from "./types";

function item(id: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    source: "bank",
    date: "2026-07-15",
    title: id,
    subtitle: "",
    amount: 0,
    currency: "TWD",
    category: "未分類",
    status: "posted",
    ...overrides,
  };
}

const defaultFilters: ActivityListFilters = {
  month: "2026-07",
  flow: "all",
  source: "all",
  search: "",
  category: null,
};

describe("activity filters", () => {
  it("filters normalized income and expense flows", () => {
    const items = [
      item("salary", { amount: 50_000, category: "薪資" }),
      item("rent", { amount: -18_000, category: "居住" }),
      item("invoice", {
        source: "invoice",
        amount: 600,
        category: "發票",
      }),
      item("investment", {
        source: "investment",
        amount: -10_000,
        category: "投資",
      }),
      item("zero", { amount: 0 }),
    ];

    expect(
      filterActivities(items, { ...defaultFilters, flow: "income" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["salary"]);
    expect(
      filterActivities(items, { ...defaultFilters, flow: "expense" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["rent", "invoice"]);
    expect(filterActivities(items, defaultFilters)).toHaveLength(5);
  });

  it("keeps excluded activities in their flow without counting semantics", () => {
    const excludedRefund = item("refund", {
      source: "card",
      amount: 300,
      excludedFromCalculation: true,
    });

    expect(
      filterActivities([excludedRefund], {
        ...defaultFilters,
        flow: "income",
      }),
    ).toEqual([excludedRefund]);
  });

  it("combines month, source, search, and category filters", () => {
    const matchedCardInvoice = item("matched", {
      source: "card",
      title: "Good Food 好食餐廳",
      institutionName: "測試銀行",
      amount: -860,
      category: "餐飲",
      invoiceId: "invoice-1",
    });
    const standaloneInvoice = item("standalone", {
      source: "invoice",
      title: "便利商店",
      amount: 100,
      category: "發票",
    });
    const previousMonth = item("old", {
      date: "2026-06-15",
      title: "Good Food 好食餐廳",
      amount: -500,
      category: "餐飲",
      invoiceId: "invoice-old",
    });

    expect(
      filterActivities([matchedCardInvoice, standaloneInvoice, previousMonth], {
        ...defaultFilters,
        flow: "expense",
        source: "invoice",
        search: "  GOOD FOOD  ",
        category: { flow: "expense", category: "餐飲" },
      }),
    ).toEqual([matchedCardInvoice]);
  });
});
