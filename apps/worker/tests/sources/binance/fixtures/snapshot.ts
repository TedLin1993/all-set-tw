import type { BinanceSnapshot } from "../../../../src/sources/binance/protocol";

/**
 * 去識別化的合成回應，欄位形狀依 Binance 官方文件（spot account、funding asset、
 * simple earn flexible／locked position、fapi v2 account、dapi v1 account、ticker price）。
 * U 本位在單資產模式下 `totalMarginBalance` 只計 USDT，所以以 `assets[]` 為準。
 * 數量與價格為測試用整數倍，方便手算預期值。
 */
export const binanceSnapshot: BinanceSnapshot = {
  spot: {
    balances: [
      { asset: "BTC", free: "0.01000000", locked: "0.00500000" },
      { asset: "USDT", free: "100.00000000", locked: "0.00000000" },
      // 活期理財憑證，與 flexible 的 USDT 重複，不可再計入。
      { asset: "LDUSDT", free: "50.00000000", locked: "0.00000000" },
      // 真實幣種 LDO，不是理財憑證。
      { asset: "LDO", free: "2.00000000", locked: "0.00000000" },
      { asset: "SHIB", free: "1000.00", locked: "0.00" },
      { asset: "XYZ", free: "3.00000000", locked: "0.00000000" },
    ],
  },
  funding: [
    {
      asset: "USDT",
      free: "20",
      locked: "0",
      freeze: "5",
      withdrawing: "0",
    },
    { asset: "ETH", free: "0.1", locked: "0", freeze: "0", withdrawing: "0" },
  ],
  flexible: [{ asset: "USDT", totalAmount: "50.00000000" }],
  locked: [{ asset: "ETH", amount: "0.20000000" }],
  usdm: {
    assets: [
      { asset: "USDT", marginBalance: "300.50000000" },
      { asset: "USDC", marginBalance: "100.00000000" },
      { asset: "BNB", marginBalance: "0.00000000" },
    ],
  },
  coinm: {
    assets: [
      { asset: "BTC", marginBalance: "0.00200000" },
      { asset: "ETH", marginBalance: "0.00000000" },
    ],
  },
  tickers: [
    { symbol: "BTCUSDT", price: "60000.00" },
    { symbol: "ETHUSDT", price: "2500.00" },
    { symbol: "LDOUSDT", price: "1.50" },
    { symbol: "USDCUSDT", price: "1.0000" },
    { symbol: "SHIBUSDT", price: "0.00001000" },
    { symbol: "ETHBTC", price: "0.04" },
  ],
  usdtTwd: 32,
};
