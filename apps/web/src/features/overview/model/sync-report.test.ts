import { describe, expect, it } from "vitest";
import type { ScheduledSyncReport } from "@taiwan-fin-hub/core";
import {
  financialChangeUnavailableMessage,
  signedFinancialChange,
  syncReportStatusPresentation,
  zeroRateCurrenciesMessage,
} from "./sync-report";

function report(input: Partial<ScheduledSyncReport> = {}): ScheduledSyncReport {
  return {
    id: "default:report",
    startedAt: "2026-08-12T22:00:00.000Z",
    completedAt: "2026-08-12T22:05:00.000Z",
    status: "success",
    sources: [],
    sourceSummary: { total: 3, success: 3, failed: 0, needsUserAction: 0 },
    newRecords: {
      invoices: 3,
      bankTransactions: 9,
      investmentTransactions: 1,
    },
    financialChange: {
      assets: 12_340,
      creditCardDebt: -1_200,
      netWorth: 13_540,
    },
    financialChangeUnavailableReason: null,
    missingCurrencies: [],
    ...input,
  };
}

describe("sync report presentation", () => {
  it("summarizes a successful round", () => {
    expect(syncReportStatusPresentation(report())).toEqual({
      label: "同步完成",
      description: "3 個資料來源已完成",
      tone: "success",
    });
  });

  it("does not present a partial round as a complete financial comparison", () => {
    const value = report({
      status: "failed",
      sourceSummary: { total: 3, success: 2, failed: 1, needsUserAction: 0 },
      financialChange: null,
      financialChangeUnavailableReason: "partial_sync",
    });
    expect(syncReportStatusPresentation(value).description).toBe(
      "2 / 3 個來源完成，1 個未更新",
    );
    expect(
      financialChangeUnavailableMessage(value.financialChangeUnavailableReason),
    ).toBe("部分資料來源未更新，暫不計算資產變化。");
  });

  it("explains baseline reports and currencies valued at zero", () => {
    expect(financialChangeUnavailableMessage("baseline")).toContain("資產基準");
    expect(zeroRateCurrenciesMessage(["USD", "EUR"])).toBe(
      "缺少 USD、EUR 匯率，相關資產以 NT$0 計算。",
    );
    expect(zeroRateCurrenciesMessage([])).toBeNull();
  });

  it("keeps the displayed sign separate from the absolute currency value", () => {
    expect(signedFinancialChange(1200)).toEqual({
      sign: "+",
      tone: "positive",
    });
    expect(signedFinancialChange(-1200)).toEqual({
      sign: "−",
      tone: "negative",
    });
    expect(signedFinancialChange(0)).toEqual({ sign: "", tone: "neutral" });
    expect(signedFinancialChange(-1200, false)).toEqual({
      sign: "−",
      tone: "positive",
    });
  });
});
