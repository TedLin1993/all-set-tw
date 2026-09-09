import { render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import ActivityAmount from "./ActivityAmount.svelte";
import { moneyState } from "@/shared/state/money-visibility.svelte";
import type { ActivityItem } from "../model/types";
import { activityCashAmountTwd } from "../model/chart";

const item: ActivityItem = {
  id: "foreign",
  source: "card",
  date: "2026-09-04",
  title: "消費",
  subtitle: "",
  amount: -5500,
  currency: "JPY",
  category: "餐飲",
  status: "posted",
};
afterEach(() => {
  moneyState.hidden = false;
});
describe("activity amounts in TWD", () => {
  it("uses the same conversion as charts and retains original currency and rate details", () => {
    render(ActivityAmount, {
      item,
      rates: { JPY: 0.2 },
      detail: true,
      exchangeRates: [
        { currency: "JPY", rateTwd: 0.2, updatedAt: "2026-09-09T00:00:00Z" },
      ],
    });
    expect(screen.getByText("約 −NT$1,100")).toBeInTheDocument();
    expect(screen.getByText("原幣 −JP¥5,500")).toBeInTheDocument();
    expect(screen.getByText(/1 JPY = 0.2 TWD/)).toBeInTheDocument();
    expect(activityCashAmountTwd(item, { JPY: 0.2 })).toBe(-1100);
  });
  it("shows a missing rate instead of zero", () => {
    render(ActivityAmount, { item, rates: {} });
    expect(screen.getByText("台幣金額暫無法換算")).toBeInTheDocument();
    expect(screen.getByText("原幣 −JP¥5,500")).toBeInTheDocument();
    expect(screen.queryByText(/NT\$0/)).not.toBeInTheDocument();
  });
  it("keeps TWD refunds exact and positive", () => {
    render(ActivityAmount, {
      item: { ...item, currency: "TWD", amount: 63 },
      rates: {},
    });
    expect(screen.getByText("+NT$63")).toBeInTheDocument();
    expect(screen.queryByText(/原幣|約/)).not.toBeInTheDocument();
  });
  it("hides both converted and original amounts", () => {
    moneyState.hidden = true;
    render(ActivityAmount, { item, rates: { JPY: 0.2 } });
    expect(screen.getByText("••••••")).toBeInTheDocument();
    expect(screen.getByText("原幣 ••••••")).toBeInTheDocument();
    expect(screen.queryByText(/5,500|1,100/)).not.toBeInTheDocument();
  });
});
