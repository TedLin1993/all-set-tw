import { describe, expect, it } from "vitest";
import { buildStockCostHistory } from "../../../src/features/net-worth/service";

type Inputs = Parameters<typeof buildStockCostHistory>[0];

const base: Inputs = {
  positions: [
    {
      date: "2026-11-10",
      foreign_market: 0,
      currency: "TWD",
      cost: 900_000,
      missing: 0,
    },
  ],
  trades: [],
  foreignTrades: [],
  uncoveredTdccHoldings: 0,
  foreignStartDate: null,
  ratesToTwd: {},
};

const costs = (inputs: Inputs) =>
  buildStockCostHistory(inputs).map(({ date, netWorth }) => [date, netWorth]);

describe("股票投入成本回推", () => {
  it("以最新成本為基準往回扣買進、加回賣出部位的原始成本", () => {
    expect(
      costs({
        ...base,
        trades: [
          // 快照之後的成交尚未反映在基準成本，不得回推。
          { date: "2026-11-11", code: "B", amount: -9_999, realizedCost: null },
          {
            date: "2026-11-04",
            code: "B",
            amount: -20_000,
            realizedCost: null,
          },
          {
            date: "2026-10-01",
            code: "S",
            amount: 70_000,
            realizedCost: 50_000,
          },
          {
            date: "2026-10-01",
            code: "B",
            amount: -10_000,
            realizedCost: null,
          },
        ],
      }),
    ).toEqual([
      // 10/01 之前：880,000 − 10,000 + 50,000；最早成交以前沿用（查詢年限以前的持股）。
      ["1900-01-01", 920_000],
      ["2026-10-01", 880_000],
      ["2026-11-04", 900_000],
      ["2026-11-10", 900_000],
    ]);
  });

  it("賣出的原始成本為 0（券商查不到）時同樣不再往前推", () => {
    expect(
      costs({
        ...base,
        trades: [
          { date: "2026-09-01", code: "S", amount: 30_000, realizedCost: 0 },
          { date: "2026-08-01", code: "B", amount: -5_000, realizedCost: null },
        ],
      }),
    ).toEqual([
      ["2026-09-01", 900_000],
      ["2026-11-10", 900_000],
    ]);
  });

  it("賣出缺少原始成本時不再往前推", () => {
    expect(
      costs({
        ...base,
        trades: [
          {
            date: "2026-11-04",
            code: "B",
            amount: -20_000,
            realizedCost: null,
          },
          { date: "2026-09-01", code: "S", amount: 30_000, realizedCost: null },
          { date: "2026-08-01", code: "B", amount: -5_000, realizedCost: null },
        ],
      }),
    ).toEqual([
      ["2026-09-01", 880_000],
      ["2026-11-04", 900_000],
      ["2026-11-10", 900_000],
    ]);
  });

  it("海外成本以匯率換算，從海外市值進入走勢那天起才計入", () => {
    expect(
      costs({
        ...base,
        positions: [
          {
            date: "2026-11-08",
            foreign_market: 0,
            currency: "TWD",
            cost: 900_000,
            missing: 0,
          },
          {
            date: "2026-11-08",
            foreign_market: 1,
            currency: "USD",
            cost: 3_000,
            missing: 0,
          },
          {
            date: "2026-11-10",
            foreign_market: 0,
            currency: "TWD",
            cost: 900_000,
            missing: 0,
          },
          {
            date: "2026-11-10",
            foreign_market: 1,
            currency: "USD",
            cost: 3_100,
            missing: 0,
          },
        ],
        foreignStartDate: "2026-11-10",
        ratesToTwd: { USD: 32 },
      }),
    ).toEqual([
      ["1900-01-01", 900_000],
      ["2026-11-10", 900_000 + 3_100 * 32],
    ]);
  });

  describe("海外市值進入走勢以前，依海外成交回推到買進日", () => {
    const foreign: Inputs = {
      ...base,
      positions: [
        ...base.positions,
        {
          date: "2026-11-10",
          foreign_market: 1,
          currency: "USD",
          cost: 3_100,
          missing: 0,
        },
      ],
      foreignStartDate: "2026-11-10",
      ratesToTwd: { USD: 32 },
    };
    const buy = (date: string, amount: number) => ({
      date,
      code: "B",
      amount,
      currency: "USD",
    });
    const series = (inputs: Inputs) =>
      buildStockCostHistory(inputs).map(({ date, netWorth, assetType }) => [
        date,
        netWorth,
        assetType,
      ]);

    it("成交能完整解釋第一個點的成本時回補，另外輸出其中尚無市值的海外成本", () => {
      expect(
        series({
          ...foreign,
          foreignTrades: [
            buy("2025-02-06", -3_000),
            buy("2025-06-01", -100),
            // 第一個點之後的成交已反映在之後的快照，不參與回推。
            buy("2026-11-12", -50),
          ],
        }),
      ).toEqual([
        // 第一筆買進以前沒有海外成本。
        ["1900-01-01", 900_000, "stock_cost"],
        ["1900-01-01", 0, "stock_cost_unvalued"],
        // 成本線含海外買進；算未實現損益時扣掉尚無市值的部分，台股損益照常計算。
        ["2025-02-06", 900_000 + 3_000 * 32, "stock_cost"],
        ["2025-02-06", 3_000 * 32, "stock_cost_unvalued"],
        ["2025-06-01", 900_000 + 3_100 * 32, "stock_cost"],
        ["2025-06-01", 3_100 * 32, "stock_cost_unvalued"],
        // 海外市值進入走勢那天起歸零，前端不再沿用回補的值。
        ["2026-11-10", 900_000 + 3_100 * 32, "stock_cost"],
        ["2026-11-10", 0, "stock_cost_unvalued"],
      ]);
    });

    it("有海外賣出、缺匯率，或有成交以外取得的持股時不回補", () => {
      const unchanged = [
        ["1900-01-01", 900_000, "stock_cost"],
        ["2026-11-10", 900_000 + 3_100 * 32, "stock_cost"],
      ];
      for (const foreignTrades of [
        // 海外賣出沒有原始成本，無法回推。
        [
          buy("2025-02-06", -3_100),
          { date: "2025-03-01", code: "S", amount: 500, currency: "USD" },
        ],
        [{ ...buy("2025-02-06", -3_100), currency: "HKD" }],
        // 成交只解釋 3,000 USD：另外 100 USD 的持股不知道何時取得。
        [buy("2025-02-06", -3_000)],
      ])
        expect(series({ ...foreign, foreignTrades })).toEqual(unchanged);
    });
  });

  it("以台幣計價的海外持倉不併入台股基準，海外市值開始前的日期不含其成本", () => {
    expect(
      costs({
        ...base,
        positions: [
          {
            date: "2026-11-10",
            foreign_market: 0,
            currency: "TWD",
            cost: 900_000,
            missing: 0,
          },
          {
            date: "2026-11-10",
            foreign_market: 1,
            currency: "TWD",
            cost: 50_000,
            missing: 0,
          },
        ],
        foreignStartDate: "2026-11-10",
      }),
    ).toEqual([
      ["1900-01-01", 900_000],
      ["2026-11-10", 950_000],
    ]);
  });

  it("成本無法對應市值線時不輸出：集保有其他券商持股、缺成本或缺匯率", () => {
    expect(costs({ ...base, uncoveredTdccHoldings: 1 })).toEqual([]);
    expect(
      costs({
        ...base,
        positions: [
          {
            date: "2026-11-10",
            foreign_market: 0,
            currency: "TWD",
            cost: 900_000,
            missing: 1,
          },
        ],
      }),
    ).toEqual([]);
    expect(
      costs({
        ...base,
        positions: [
          ...base.positions,
          {
            date: "2026-11-10",
            foreign_market: 1,
            currency: "USD",
            cost: 3_000,
            missing: 0,
          },
        ],
        foreignStartDate: "2026-11-10",
      }),
    ).toEqual([]);
  });
});
