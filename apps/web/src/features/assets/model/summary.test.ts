import { describe, expect, it } from "vitest";
import { calculateAssetSummary } from "./summary";

describe("calculateAssetSummary", () => {
  it("converts balances, subtracts card debt, and groups deposit accounts", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "deposit",
            connectorId: "esun",
            sourceId: "deposit",
            institutionName: "玉山銀行",
            accountType: "savings",
            balance: 100,
            currency: "USD",
          },
          {
            id: "card",
            connectorId: "sinopac",
            sourceId: "card",
            accountType: "credit",
            balance: -2_000,
            currency: "TWD",
          },
        ],
        transactions: [],
      },
      investments: [
        {
          id: "investment",
          assetType: "stock",
          name: "測試持倉",
          marketValue: 10_000,
          currency: "TWD",
          asOfDate: "2026-07-22",
        },
      ],
      manualAssets: [
        {
          id: "home",
          name: "房屋",
          category: "real_estate",
          note: null,
          currency: "USD",
          createdAt: "2026-07-22",
          value: 200,
        },
      ],
      rates: [{ currency: "USD", rateTwd: 30, updatedAt: "2026-07-22" }],
    });

    expect(summary.bankTotal).toBe(3_000);
    expect(summary.cardDebt).toBe(2_000);
    expect(summary.netWorth).toBe(17_000);
    expect(summary.groupedBanks[0]?.institution).toBe("玉山銀行");
  });
});
