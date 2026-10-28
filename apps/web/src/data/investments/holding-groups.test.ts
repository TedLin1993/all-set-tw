import { describe, expect, it } from "vitest";
import type { InvestmentRow } from "@/data/investments/types";
import {
  groupInvestmentPositions,
  holdingTitle,
  isCryptoPosition,
  listInvestmentHoldings,
  listedHoldingCount,
} from "./holding-groups";

function row(
  partial: Partial<InvestmentRow> &
    Pick<InvestmentRow, "connectorId" | "sourceId" | "assetType">,
): InvestmentRow {
  return {
    id: `${partial.connectorId}:${partial.sourceId}`,
    name: partial.connectorId,
    currency: "TWD",
    asOfDate: "2026-10-23",
    ...partial,
  };
}

const rows: InvestmentRow[] = [
  row({
    connectorId: "binance",
    sourceId: "BTC",
    assetType: "crypto",
    symbol: "BTC",
    marketValue: 28_800,
  }),
  row({
    connectorId: "binance",
    sourceId: "USDT",
    assetType: "crypto",
    symbol: "USDT",
    marketValue: 5_600,
  }),
  row({
    connectorId: "binance",
    sourceId: "SHIB",
    assetType: "crypto",
    symbol: "SHIB",
    marketValue: 6,
  }),
  row({
    connectorId: "binance",
    sourceId: "XYZ",
    assetType: "crypto",
    symbol: "XYZ",
    quantity: 3,
  }),
  row({
    connectorId: "binance",
    sourceId: "futures-usdm",
    assetType: "crypto",
    name: "Binance U 本位合約權益",
    marketValue: 12_816,
  }),
  row({
    connectorId: "binance",
    sourceId: "futures-coinm",
    assetType: "crypto",
    name: "Binance 幣本位合約權益",
    marketValue: 3_840,
  }),
  row({
    connectorId: "max",
    sourceId: "TWD",
    assetType: "crypto",
    symbol: "TWD",
    marketValue: 51_000,
  }),
  row({
    connectorId: "max",
    sourceId: "USDT",
    assetType: "crypto",
    symbol: "USDT",
    name: "MAX（借款）",
    quantity: -491.5,
    marketValue: -15_974,
  }),
  row({
    connectorId: "tdcc",
    sourceId: "2330",
    assetType: "stock",
    symbol: "2330",
    name: "台積電",
    marketValue: 100_000,
  }),
  row({
    connectorId: "tdcc",
    sourceId: "0050",
    assetType: "etf",
    symbol: "0050",
    name: "元大台灣50",
    marketValue: 30_000,
  }),
  row({
    connectorId: "tdcc",
    sourceId: "F1",
    assetType: "fund",
    name: "美元基金",
    marketValue: 100,
    currency: "USD",
  }),
];

describe("投資持倉依機構分組", () => {
  it("機構依小計由大到小，機構內持倉平鋪並依台幣市值排序", () => {
    const groups = groupInvestmentPositions(rows, { USD: 32 });
    // 集保 = 100000 + 30000 + 100 × 32 = 133200
    // Binance = 28800 + 5600 + 6 + 12816 + 3840 = 51062（XYZ 無法估值不計）
    // MAX = 51000 − 15974 = 35026
    expect(
      groups.map(({ key, label, totalTwd }) => ({ key, label, totalTwd })),
    ).toEqual([
      { key: "tdcc", label: "集保 e 存摺", totalTwd: 133_200 },
      { key: "binance", label: "Binance", totalTwd: 51_062 },
      { key: "max", label: "MAX 交易所", totalTwd: 35_026 },
    ]);

    const [tdcc, binance, max] = groups;
    // 不分類型：合約權益與幣種一起依市值排序，SHIB（NT$6）不列出，無法估值的 XYZ 在最後
    expect(binance!.holdings.map(({ row }) => row.sourceId)).toEqual([
      "BTC",
      "futures-usdm",
      "USDT",
      "futures-coinm",
      "XYZ",
    ]);
    expect(binance!.hiddenCount).toBe(1);
    expect(binance!.visibleCount).toBe(5);
    expect(tdcc!.holdings.map(({ row }) => row.sourceId)).toEqual([
      "2330",
      "0050",
      "F1",
    ]);
    expect(tdcc!.holdings[2]!.valueTwd).toBe(3_200);
    // 借款為負值，排在正值之後
    expect(max!.holdings.map(({ row }) => row.sourceId)).toEqual([
      "TWD",
      "USDT",
    ]);
    // 11 筆中 SHIB 低於 NT$10 不列出
    expect(listedHoldingCount(rows, { USD: 32 })).toBe(10);
    // 加密貨幣列不分交易所時同樣依市值排序並隱藏小額
    const cryptoList = listInvestmentHoldings(rows.filter(isCryptoPosition), {
      USD: 32,
    });
    expect(cryptoList.holdings.map(({ row }) => row.id)).toEqual([
      "max:TWD",
      "binance:BTC",
      "binance:futures-usdm",
      "binance:USDT",
      "binance:futures-coinm",
      "max:USDT",
      "binance:XYZ",
    ]);
    expect(cryptoList.hiddenCount).toBe(1);
  });

  it("無持倉零值列不列出；缺少匯率時保留持倉但不估值", () => {
    const groups = groupInvestmentPositions(
      [
        row({
          connectorId: "max",
          sourceId: "empty",
          assetType: "crypto",
          name: "MAX（無持倉）",
          quantity: 0,
          marketValue: 0,
        }),
        row({
          connectorId: "tdcc",
          sourceId: "F1",
          assetType: "fund",
          name: "日圓基金",
          marketValue: 5,
          currency: "JPY",
        }),
      ],
      {},
    );
    const max = groups.find((group) => group.key === "max")!;
    expect(max).toMatchObject({
      holdings: [],
      visibleCount: 0,
      hiddenCount: 0,
      totalTwd: 0,
    });
    const tdcc = groups.find((group) => group.key === "tdcc")!;
    expect(tdcc.holdings[0]!.valueTwd).toBeNull();
    expect(tdcc.visibleCount).toBe(1);
  });

  it("加密貨幣只顯示幣種，借款另外標示", () => {
    expect(holdingTitle(rows[0]!)).toBe("BTC");
    expect(holdingTitle(rows[7]!)).toBe("USDT 借款");
    expect(holdingTitle(rows[4]!)).toBe("U 本位");
    expect(holdingTitle(rows[5]!)).toBe("幣本位");
    expect(holdingTitle(rows[8]!)).toBe("2330 台積電");
  });
});
