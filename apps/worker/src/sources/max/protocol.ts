import { z } from "zod";
import {
  buildCryptoHoldings,
  cryptoEdgeSuffix,
  cryptoEndpointLabel,
  parseCryptoAmount,
  type CryptoHoldings,
  type CryptoWalletBalance,
} from "../crypto-holdings";
import type { MaxMarket, MaxTicker } from "../crypto-prices";

/** MAX API 設定。兩個欄位都由 Worker 加密保存。 */
export const maxConfigSchema = z.object({
  accessKey: z.string().min(1).max(256).optional(),
  secretKey: z.string().min(1).max(256).optional(),
});

export type MaxConfig = z.infer<typeof maxConfigSchema>;

export function parseMaxConfig(config: unknown): MaxConfig {
  return maxConfigSchema.parse(config);
}

export class MaxApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(
      `MAX API 回應錯誤（${cryptoEndpointLabel(endpoint)}，HTTP ${status}${code === undefined ? "" : `，代碼 ${code}`}）`,
    );
    this.name = "MaxApiError";
  }
}

export class MaxCredentialError extends Error {
  constructor() {
    super(
      "MAX 拒絕此 API 金鑰：請確認 Access Key 與 Secret Key 正確、已開啟讀取權限，且未限制 IP 白名單。",
    );
    this.name = "MaxCredentialError";
  }
}

/**
 * MAX 前端的 Cloudflare 防火牆拒絕連線（HTTP 403／451 且沒有 MAX 錯誤碼），
 * 通常是連線所在地區或來源網段被擋，與金鑰無關。
 */
export class MaxAccessBlockedError extends Error {
  constructor(
    status: number,
    readonly edge?: string,
  ) {
    super(
      `MAX 拒絕了這次連線（HTTP ${status}${cryptoEdgeSuffix(edge)}），回應沒有 MAX API 的錯誤代碼，與 API 金鑰無關。請求由亞太與西歐的 Cloudflare Browser Run 代發，兩個區域都被拒絕時無法同步，請稍後再試。`,
    );
    this.name = "MaxAccessBlockedError";
  }
}

/** v3 `/wallet/{spot|m}/accounts`；`principal`、`interest` 只在 M 錢包回傳。 */
export type MaxAccount = {
  currency?: string;
  balance?: string;
  locked?: string;
  staked?: string | null;
  principal?: string;
  interest?: string;
};

export type MaxSnapshot = {
  spot: MaxAccount[];
  /** M 錢包未開通或無權限時為 undefined。 */
  m?: MaxAccount[];
  tickers: MaxTicker[];
};

/** 依持有幣種挑出存在的 `xxxtwd`、`xxxusdt` 市場與 `usdttwd`，避免無效 market 讓整批報價失敗。 */
export function selectMaxPriceMarkets(
  markets: MaxMarket[],
  currencies: Iterable<string>,
) {
  const held = new Set(
    [...currencies].map((currency) => currency.toLowerCase()),
  );
  held.add("usdt");
  return markets
    .filter(
      (market) =>
        (market.status === undefined || market.status === "active") &&
        held.has(market.base_unit) &&
        (market.quote_unit === "twd" || market.quote_unit === "usdt"),
    )
    .map((market) => market.id)
    .sort();
}

/** 先用 `xxxtwd` 直接換台幣，沒有時走 `xxxusdt` × `usdttwd`。 */
export function createMaxTwdPricer(tickers: MaxTicker[]) {
  const prices = new Map<string, number>();
  for (const ticker of tickers) {
    const price = parseCryptoAmount(ticker.last);
    if (ticker.market && price > 0) prices.set(ticker.market, price);
  }
  const usdtTwd = prices.get("usdttwd");
  return (asset: string): number | undefined => {
    const currency = asset.toLowerCase();
    if (currency === "twd") return 1;
    const direct = prices.get(`${currency}twd`);
    if (direct !== undefined) return direct;
    const viaUsdt = prices.get(`${currency}usdt`);
    return viaUsdt !== undefined && usdtTwd !== undefined
      ? viaUsdt * usdtTwd
      : undefined;
  };
}

export function maxWalletBalances(snapshot: Pick<MaxSnapshot, "spot" | "m">) {
  const balances: CryptoWalletBalance[] = [];
  for (const account of snapshot.spot) {
    balances.push({
      asset: account.currency ?? "",
      wallet: "spot",
      quantity:
        parseCryptoAmount(account.balance) +
        parseCryptoAmount(account.locked) +
        parseCryptoAmount(account.staked),
    });
  }
  for (const account of snapshot.m ?? []) {
    balances.push({
      asset: account.currency ?? "",
      wallet: "m",
      // M 錢包淨額扣除借款本金與利息；借款大於持有時為負數。
      quantity:
        parseCryptoAmount(account.balance) +
        parseCryptoAmount(account.locked) +
        parseCryptoAmount(account.staked) -
        parseCryptoAmount(account.principal) -
        parseCryptoAmount(account.interest),
    });
  }
  return balances;
}

export function normalizeMaxHoldings(
  snapshot: MaxSnapshot,
  asOfDate: string,
): CryptoHoldings {
  return buildCryptoHoldings({
    exchangeName: "MAX",
    asOfDate,
    balances: maxWalletBalances(snapshot),
    priceTwd: createMaxTwdPricer(snapshot.tickers),
  });
}
