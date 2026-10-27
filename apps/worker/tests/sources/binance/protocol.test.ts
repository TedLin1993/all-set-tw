import { describe, expect, it } from "vitest";
import {
  createBinanceUsdtPricer,
  normalizeBinanceHoldings,
} from "../../../src/sources/binance/protocol";
import { binanceSnapshot } from "./fixtures/snapshot";

const DATE = "2026-10-23";

describe("Binance 持倉正規化", () => {
  it("跨錢包合併同幣種、略過理財憑證與灰塵幣，合約只取權益", () => {
    const holdings = normalizeBinanceHoldings(binanceSnapshot, DATE);

    // 手算（USDT→TWD = 32）：
    // BTC  = 0.01 + 0.005 = 0.015；0.015 × 60000 × 32 = 28800
    // ETH  = funding 0.1 + locked earn 0.2 = 0.3；0.3 × 2500 × 32 = 24000
    // LDO  = 2；2 × 1.5 × 32 = 96
    // USDT = spot 100 + funding (20 + 5) + flexible 50 = 175（LDUSDT 不計）；175 × 32 = 5600
    // SHIB = 1000 × 0.00001 × 32 = 0.32 → 灰塵，不輸出
    // XYZ  = 3，無報價 → 保留數量、不估值
    // U 本位 = USDT 300.5 × 32 + USDC 100 × 1 × 32 = 9616 + 3200 = 12816
    // 幣本位 = 0.002 BTC × 60000 × 32 = 3840（marginBalance 已含未實現損益）
    expect(
      holdings.positions.map(({ sourceId, symbol, quantity, marketValue }) => ({
        sourceId,
        symbol,
        quantity,
        marketValue,
      })),
    ).toEqual([
      { sourceId: "BTC", symbol: "BTC", quantity: 0.015, marketValue: 28800 },
      { sourceId: "ETH", symbol: "ETH", quantity: 0.3, marketValue: 24000 },
      { sourceId: "LDO", symbol: "LDO", quantity: 2, marketValue: 96 },
      { sourceId: "USDT", symbol: "USDT", quantity: 175, marketValue: 5600 },
      { sourceId: "XYZ", symbol: "XYZ", quantity: 3, marketValue: undefined },
      {
        sourceId: "futures-usdm",
        symbol: undefined,
        quantity: undefined,
        marketValue: 12816,
      },
      {
        sourceId: "futures-coinm",
        symbol: undefined,
        quantity: undefined,
        marketValue: 3840,
      },
    ]);
    expect(
      holdings.positions.every(
        (position) =>
          position.assetType === "crypto" &&
          position.currency === "TWD" &&
          position.asOfDate === DATE,
      ),
    ).toBe(true);
    expect(holdings.positions.find((p) => p.sourceId === "USDT")?.raw).toEqual({
      wallets: { spot: 100, funding: 25, earnFlexible: 50 },
      priceTwd: 32,
    });
    // 28800 + 24000 + 96 + 5600 + 12816 + 3840 = 75152
    expect(holdings.netWorth).toEqual({
      date: DATE,
      netWorth: 75152,
      assetType: "crypto",
    });
    expect(holdings.unpricedAssets).toEqual(["XYZ"]);
  });

  it("未開通的錢包不輸出列；合約含無報價資產時權益不估值、不當成 0", () => {
    const holdings = normalizeBinanceHoldings(
      {
        spot: { balances: [{ asset: "BTC", free: "0.1", locked: "0" }] },
        usdm: {
          assets: [
            { asset: "USDT", marginBalance: "12.5" },
            { asset: "XYZ", marginBalance: "4" },
          ],
        },
        tickers: binanceSnapshot.tickers,
        usdtTwd: 32,
      },
      DATE,
    );
    // BTC 0.1 × 60000 × 32 = 192000；U 本位含 XYZ 無報價 → 整筆不估值
    expect(holdings.positions).toMatchObject([
      { sourceId: "BTC", quantity: 0.1, marketValue: 192000 },
      { sourceId: "futures-usdm", marketValue: undefined },
    ]);
    expect(holdings.unpricedAssets).toEqual(["futures-usdm", "XYZ"]);
    expect(holdings.netWorth.netWorth).toBe(192000);
  });

  it("全部低於灰塵門檻時輸出零值列", () => {
    const holdings = normalizeBinanceHoldings(
      {
        spot: { balances: [{ asset: "USDT", free: "0.2", locked: "0" }] },
        tickers: [],
        usdtTwd: 32,
      },
      DATE,
    );
    // 0.2 × 32 = 6.4 → 6 < 10
    expect(holdings.positions).toEqual([
      {
        sourceId: "empty",
        assetType: "crypto",
        name: "Binance（無持倉）",
        quantity: 0,
        marketValue: 0,
        currency: "TWD",
        asOfDate: DATE,
        raw: {},
      },
    ]);
    expect(holdings.netWorth.netWorth).toBe(0);
  });

  it("報價依序使用 XUSDT、USDTX 反向、XBTC × BTCUSDT", () => {
    const price = createBinanceUsdtPricer([
      { symbol: "BTCUSDT", price: "60000" },
      { symbol: "USDTTRY", price: "40" },
      { symbol: "ABCBTC", price: "0.0001" },
    ]);
    expect(price("USDT")).toBe(1);
    expect(price("BTC")).toBe(60000);
    expect(price("TRY")).toBe(0.025);
    expect(price("ABC")).toBeCloseTo(6, 10);
    expect(price("NOPE")).toBeUndefined();
  });

  it("沒有逐一串接的錢包各列一筆帳戶總值，已串接的錢包不重複計入", () => {
    const holdings = normalizeBinanceHoldings(
      {
        spot: { balances: [] },
        funding: [],
        flexible: [],
        locked: [],
        usdm: { assets: [] },
        coinm: { assets: [] },
        wallets: [
          // 已逐一串接，不可再計入
          { activate: true, balance: "100", walletName: "Spot" },
          { activate: true, balance: "100", walletName: "Funding" },
          { activate: true, balance: "100", walletName: "Earn" },
          { activate: true, balance: "100", walletName: "USDⓈ-M Futures" },
          { activate: true, balance: "100", walletName: "COIN-M Futures" },
          // 其他帳戶
          { activate: true, balance: "250.5", walletName: "Trading Bots" },
          { activate: true, balance: "10", walletName: "Options" },
          { activate: true, balance: "3", walletName: "New Product" },
          // 未開通、零餘額、灰塵不列出
          { activate: false, balance: "999", walletName: "Copy Trading" },
          { activate: true, balance: "0", walletName: "Cross Margin" },
          { activate: true, balance: "0.2", walletName: "Isolated Margin" },
        ],
        tickers: [],
        usdtTwd: 32,
      },
      DATE,
    );
    // Trading Bots 250.5 × 32 = 8016；Options 10 × 32 = 320；New Product 3 × 32 = 96；
    // Isolated Margin 0.2 × 32 = 6.4 → 灰塵
    expect(
      holdings.positions.map(({ sourceId, name, marketValue }) => ({
        sourceId,
        name,
        marketValue,
      })),
    ).toEqual([
      { sourceId: "wallet-tradingbots", name: "交易機器人", marketValue: 8016 },
      { sourceId: "wallet-options", name: "期權", marketValue: 320 },
      { sourceId: "wallet-newproduct", name: "New Product", marketValue: 96 },
    ]);
    expect(holdings.netWorth.netWorth).toBe(8016 + 320 + 96);
  });

  it("逐一端點未開通或無權限時改用錢包總值，不讓兩邊都漏掉", () => {
    const holdings = normalizeBinanceHoldings(
      {
        spot: { balances: [] },
        // 活期有取得、定期無權限：Earn 總值已含活期，仍不補，避免重複計入
        flexible: [],
        wallets: [
          { activate: true, balance: "100", walletName: "Spot" },
          { activate: true, balance: "20", walletName: "Funding" },
          { activate: true, balance: "30", walletName: "Earn" },
          { activate: true, balance: "40", walletName: "USDⓈ-M Futures" },
          { activate: true, balance: "50", walletName: "COIN-M Futures" },
        ],
        tickers: [],
        usdtTwd: 32,
      },
      DATE,
    );
    // Funding 20 × 32 = 640；U 本位 40 × 32 = 1280；幣本位 50 × 32 = 1600
    expect(
      holdings.positions.map(({ sourceId, name, marketValue }) => ({
        sourceId,
        name,
        marketValue,
      })),
    ).toEqual([
      { sourceId: "wallet-funding", name: "資金帳戶", marketValue: 640 },
      { sourceId: "wallet-usdmfutures", name: "U 本位合約", marketValue: 1280 },
      {
        sourceId: "wallet-coinmfutures",
        name: "幣本位合約",
        marketValue: 1600,
      },
    ]);
    expect(holdings.netWorth.netWorth).toBe(640 + 1280 + 1600);
  });
});
