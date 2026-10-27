import { describe, expect, it } from "vitest";
import {
  normalizeMaxHoldings,
  selectMaxPriceMarkets,
  type MaxSnapshot,
} from "../../../src/sources/max/protocol";

const DATE = "2026-10-23";

/** 欄位形狀依 MAX v3 `/wallet/{spot|m}/accounts` 與 `/tickers`；數值為合成資料。 */
const snapshot: MaxSnapshot = {
  spot: [
    { currency: "twd", balance: "50000.0", locked: "1000.0", staked: null },
    { currency: "btc", balance: "0.01", locked: "0.0", staked: "0.0" },
    { currency: "usdt", balance: "10.0", locked: "0.0", staked: "0.0" },
    { currency: "pol", balance: "60.0", locked: "0.0", staked: "40.0" },
    { currency: "max", balance: "1.0", locked: "0.0", staked: "0.0" },
  ],
  m: [
    {
      currency: "btc",
      balance: "0.02",
      locked: "0.0",
      staked: "0.0",
      principal: "0.0",
      interest: "0.0",
    },
    {
      currency: "usdt",
      balance: "0.0",
      locked: "0.0",
      staked: "0.0",
      principal: "500.0",
      interest: "1.5",
    },
  ],
  tickers: [
    { market: "btctwd", last: "2000000.0" },
    { market: "usdttwd", last: "32.5" },
    { market: "polusdt", last: "0.4" },
    { market: "maxtwd", last: "8.0" },
  ],
};

describe("MAX 持倉正規化", () => {
  it("合併現貨與 M 錢包、扣除借款，TWD 以餘額計，無台幣市場時經 USDT 換算", () => {
    const holdings = normalizeMaxHoldings(snapshot, DATE);

    // 手算：
    // BTC  = spot 0.01 + M 0.02 = 0.03；0.03 × 2,000,000 = 60000
    // MAX  = 1 × 8 = 8 → 灰塵，不輸出
    // POL  = 60 + staked 40 = 100；無 poltwd，100 × 0.4 × 32.5 = 1300
    // TWD  = 50000 + 1000 = 51000
    // USDT = spot 10 + M (0 − 500 − 1.5) = −491.5；−491.5 × 32.5 = −15973.75 → −15974
    expect(
      holdings.positions.map(({ sourceId, name, quantity, marketValue }) => ({
        sourceId,
        name,
        quantity,
        marketValue,
      })),
    ).toEqual([
      { sourceId: "BTC", name: "MAX", quantity: 0.03, marketValue: 60000 },
      { sourceId: "POL", name: "MAX", quantity: 100, marketValue: 1300 },
      { sourceId: "TWD", name: "MAX", quantity: 51000, marketValue: 51000 },
      {
        sourceId: "USDT",
        name: "MAX（借款）",
        quantity: -491.5,
        marketValue: -15974,
      },
    ]);
    // 60000 + 1300 + 51000 − 15974 = 96326
    expect(holdings.netWorth).toEqual({
      date: DATE,
      netWorth: 96326,
      assetType: "crypto",
    });
    expect(holdings.positions[0]?.raw).toEqual({
      wallets: { spot: 0.01, m: 0.02 },
      priceTwd: 2000000,
    });
  });

  it("M 錢包未開通時只計現貨；沒有持倉時輸出零值列", () => {
    expect(
      normalizeMaxHoldings(
        { spot: snapshot.spot.slice(0, 2), tickers: snapshot.tickers },
        DATE,
      ).netWorth.netWorth,
    ).toBe(51000 + 20000);
    expect(
      normalizeMaxHoldings({ spot: [], tickers: [] }, DATE).positions,
    ).toMatchObject([
      { sourceId: "empty", name: "MAX（無持倉）", quantity: 0, marketValue: 0 },
    ]);
  });

  it("只查詢存在且持有幣種的 twd／usdt 市場，並固定包含 usdttwd", () => {
    expect(
      selectMaxPriceMarkets(
        [
          {
            id: "btctwd",
            status: "active",
            base_unit: "btc",
            quote_unit: "twd",
          },
          {
            id: "btcusdt",
            status: "active",
            base_unit: "btc",
            quote_unit: "usdt",
          },
          {
            id: "ethtwd",
            status: "active",
            base_unit: "eth",
            quote_unit: "twd",
          },
          {
            id: "polusdt",
            status: "active",
            base_unit: "pol",
            quote_unit: "usdt",
          },
          {
            id: "poltwd",
            status: "inactive",
            base_unit: "pol",
            quote_unit: "twd",
          },
          {
            id: "usdttwd",
            status: "active",
            base_unit: "usdt",
            quote_unit: "twd",
          },
          {
            id: "btceth",
            status: "active",
            base_unit: "btc",
            quote_unit: "eth",
          },
        ],
        ["BTC", "POL", "TWD"],
      ),
    ).toEqual(["btctwd", "btcusdt", "polusdt", "usdttwd"]);
  });
});
