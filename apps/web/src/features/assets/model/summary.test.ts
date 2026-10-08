import { describe, expect, it } from "vitest";
import { calculateAssetSummary } from "./summary";
import { formatCurrency } from "@/shared/format/financial";

describe("calculateAssetSummary", () => {
  it("counts credit-card overpayments toward net worth instead of debt", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "credit",
            sourceId: "credit",
            connectorId: "sinopac",
            accountType: "credit",
            balance: 137,
            currency: "TWD",
          },
          {
            id: "debt",
            sourceId: "debt",
            connectorId: "esun",
            accountType: "credit",
            balance: -1000,
            currency: "TWD",
          },
        ],
        transactions: [],
      },
      investments: [],
      manualAssets: [],
      rates: [],
    });
    expect(summary.cardDebt).toBe(863);
    expect(summary.netWorth).toBe(-863);
    expect(
      summary.institutionGroups.find((group) => group.cards[0]?.id === "credit")
        ?.debtTotalTwd,
    ).toBe(-137);
  });
  it("converts balances and groups accounts and cards by institution", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "deposit",
            connectorId: "esun",
            sourceId: "deposit",
            institutionName: "玉山銀行",
            bankCode: "808",
            accountType: "savings",
            balance: 100,
            currency: "USD",
          },
          {
            id: "card",
            connectorId: "esun",
            sourceId: "card",
            institutionName: "玉山銀行",
            bankCode: "808",
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
    expect(summary.institutionGroups).toHaveLength(1);
    expect(summary.institutionGroups[0]).toMatchObject({
      key: "bank:808",
      institution: "玉山銀行",
      assetTotalTwd: 3_000,
      debtTotalTwd: 2_000,
    });
    expect(summary.institutionGroups[0]?.accounts).toHaveLength(1);
    expect(summary.institutionGroups[0]?.cards).toHaveLength(1);
    expect(summary.missingCurrencies).toEqual([]);
  });

  it("reports currencies omitted from TWD totals when exchange rates are missing", () => {
    const summary = calculateAssetSummary({
      bank: {
        accounts: [
          {
            id: "foreign",
            connectorId: "obank",
            sourceId: "foreign",
            accountType: "savings",
            balance: 100,
            currency: "USD",
          },
        ],
        transactions: [],
      },
      investments: [],
      manualAssets: [
        {
          id: "yen",
          name: "日圓資產",
          category: "other",
          note: null,
          currency: "JPY",
          createdAt: "2026-08-09",
          value: 10_000,
        },
      ],
      rates: [],
    });

    expect(summary.grossAssets).toBe(0);
    expect(summary.missingCurrencies).toEqual(["JPY", "USD"]);
  });

  it.each([
    { amount: 0, missingCurrencies: [] },
    { amount: 0.03, missingCurrencies: ["AUD", "CHF", "GBP", "HKD"] },
    { amount: 1, missingCurrencies: ["AUD", "CHF", "GBP", "HKD"] },
  ])(
    "reports missing rates for actual nonzero foreign amounts ($amount)",
    ({ amount, missingCurrencies }) => {
      const summary = calculateAssetSummary({
        bank: {
          accounts: [
            {
              id: "foreign",
              connectorId: "obank",
              sourceId: "foreign",
              accountType: "savings",
              balance: amount,
              currency: "HKD",
            },
            {
              id: "card",
              connectorId: "esun",
              sourceId: "card",
              accountType: "credit",
              balance: -amount,
              currency: "CHF",
            },
          ],
          transactions: [],
        },
        investments: [
          {
            id: "investment",
            assetType: "stock",
            name: "外幣持倉",
            marketValue: 0,
            cashBalance: amount,
            currency: "GBP",
            asOfDate: "2026-10-08",
          },
        ],
        manualAssets: [
          {
            id: "manual",
            name: "外幣資產",
            category: "other",
            note: null,
            currency: "AUD",
            createdAt: "2026-10-08",
            value: amount,
          },
        ],
        rates: [],
      });

      expect(summary.netWorth).toBe(0);
      expect(summary.missingCurrencies).toEqual(missingCurrencies);
      expect(formatCurrency(amount, "HKD")).toBe(`HKD ${amount}`);
    },
  );
});
