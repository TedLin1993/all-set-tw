import { describe, expect, it } from "vitest";
import {
  formatInvestmentCurrency,
  formatInvestmentQuantity,
  formatPositionQuantity,
  hasInvestmentPerformance,
  tradeAmountText,
  tradeRealizedPnl,
  tradeSummary,
} from "./investment-display";

describe("投資持倉顯示格式", () => {
  it("保留美股碎股精度，整數不補無意義的小數", () => {
    expect(formatInvestmentQuantity(12)).toBe("12");
    expect(formatInvestmentQuantity(1.23456789)).toBe("1.23456789");
    expect(
      formatPositionQuantity({ assetType: "stock", quantity: 0.125 }),
    ).toBe("0.125");
  });

  it("USD 市值、成本與損益固定顯示兩位小數，未知不轉成零", () => {
    expect(formatInvestmentCurrency(1234.5, "USD")).toBe("US$1,234.50");
    expect(formatInvestmentCurrency(-12.3, "USD")).toBe("−US$12.30");
    expect(formatInvestmentCurrency(4453.13708, "USD")).toBe("US$4,453.14");
    expect(formatInvestmentCurrency(1422.13708, "USD")).toBe("US$1,422.14");
    expect(formatInvestmentCurrency(null, "USD")).toBe("—");
    expect(formatInvestmentCurrency(undefined, "USD")).toBe("—");
  });

  it("可辨識後端已提供但值未知的績效欄位", () => {
    expect(hasInvestmentPerformance({})).toBe(false);
    expect(hasInvestmentPerformance({ costBasis: null })).toBe(true);
    expect(hasInvestmentPerformance({ unrealizedPnl: null })).toBe(true);
  });
});

describe("投資交易紀錄顯示", () => {
  const buy = {
    transactionName: "買進",
    transactionCode: "B",
    tradeDate: "2026-01-15",
    quantity: 68,
    price: 141.22,
    amount: -9604,
    currency: "TWD",
    realizedPnl: null,
  };

  it("副標列出買賣別、日期、股數與成交價；金額帶正負號", () => {
    expect(tradeSummary(buy)).toMatch(/^買進 · .+ · 68 股 · 成交價 141\.22$/);
    expect(tradeAmountText(buy)).toBe("−NT$9,604");
    expect(
      tradeSummary({ ...buy, quantity: 1.2346, price: 10, currency: "USD" }),
    ).toMatch(/ · 1\.2346 股 · 成交價 10$/);
  });

  it("集保只有股數：成交價占位值 1 與缺值都不顯示，也不當成金額", () => {
    const tdcc = {
      transactionName: "買進",
      tradeDate: "2026-01-15",
      quantity: 100,
      price: 1,
      currency: "TWD",
    };
    expect(tradeSummary(tdcc)).toMatch(/^買進 · .+ · 100 股$/);
    expect(tradeAmountText({ ...tdcc, amount: 100 })).toBe("金額未提供");
    expect(tradeAmountText(tdcc)).toBe("金額未提供");
  });

  it("已實現損益只在賣出顯示；未提供時不顯示成 0，買進不顯示這一行", () => {
    const sell = { ...buy, transactionCode: "S", transactionName: "賣出" };
    expect(tradeRealizedPnl({ ...sell, realizedPnl: 97 })).toEqual({
      text: "已實現損益 NT$97",
      tone: "gain",
    });
    expect(tradeRealizedPnl({ ...sell, realizedPnl: -1250.5 })).toEqual({
      text: "已實現損益 −NT$1,251",
      tone: "loss",
    });
    expect(
      tradeRealizedPnl({ ...sell, currency: "USD", realizedPnl: 3 }),
    ).toEqual({
      text: "已實現損益 US$3.00",
      tone: "gain",
    });
    expect(tradeRealizedPnl(sell)).toEqual({
      text: "損益未提供",
      tone: "unknown",
    });
    expect(tradeRealizedPnl(buy)).toBeNull();
  });
});
