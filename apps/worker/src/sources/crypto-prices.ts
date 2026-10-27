import { cryptoEdgeSuffix, responseEdgeLocation } from "./crypto-holdings";

/**
 * 加密貨幣來源共用的 MAX 公開報價。USDT 換台幣一律使用 MAX `usdttwd` 的最新成交價，
 * Binance 與 MAX 的台幣估值因此一致。公開 API 不需要金鑰。
 */

export const MAX_API_BASE_URL = "https://max-api.maicoin.com";
// 第一個請求包含 Durable Object 開 Browser Run 與建立同源頁面，預留較長時間。
export const CRYPTO_REQUEST_TIMEOUT_MS = 45_000;

export type CryptoFetch = typeof fetch;

/** MAX 公開端點拒絕這個出口（HTTP 403／451）；同步會改用備援區域。 */
export class MaxPublicAccessBlockedError extends Error {
  constructor(status: number, edge?: string) {
    super(
      `MAX 公開報價拒絕了這次連線（HTTP ${status}${cryptoEdgeSuffix(edge)}）`,
    );
    this.name = "MaxPublicAccessBlockedError";
  }
}

export type MaxMarket = {
  id: string;
  status?: string;
  base_unit: string;
  quote_unit: string;
};

export type MaxTicker = { market: string; last: string };

export function cryptoRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(CRYPTO_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function getMaxPublic<T>(
  fetcher: CryptoFetch,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetcher(`${MAX_API_BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
    signal: cryptoRequestSignal(signal),
  });
  if (response.status === 403 || response.status === 451) {
    throw new MaxPublicAccessBlockedError(
      response.status,
      responseEdgeLocation(response),
    );
  }
  if (!response.ok) {
    throw new Error(
      `MAX 公開報價取得失敗（HTTP ${response.status}${cryptoEdgeSuffix(responseEdgeLocation(response))}）`,
    );
  }
  return (await response.json()) as T;
}

export async function fetchMaxMarkets(
  fetcher: CryptoFetch,
  signal?: AbortSignal,
): Promise<MaxMarket[]> {
  const markets = await getMaxPublic<unknown>(
    fetcher,
    "/api/v3/markets",
    signal,
  );
  if (!Array.isArray(markets)) {
    throw new Error("MAX 市場清單回應格式異常，無法估值");
  }
  return markets as MaxMarket[];
}

/** `markets` 中任一無效時 MAX 會整批回 400，呼叫端須先以 `/markets` 篩選。 */
export async function fetchMaxTickers(
  fetcher: CryptoFetch,
  markets: readonly string[],
  signal?: AbortSignal,
): Promise<MaxTicker[]> {
  if (markets.length === 0) return [];
  const query = markets
    .map((market) => `markets[]=${encodeURIComponent(market)}`)
    .join("&");
  const tickers = await getMaxPublic<unknown>(
    fetcher,
    `/api/v3/tickers?${query}`,
    signal,
  );
  if (!Array.isArray(tickers)) {
    throw new Error("MAX 報價回應格式異常，無法估值");
  }
  return tickers as MaxTicker[];
}

/**
 * 取不到或報價無效時拋錯讓整次同步失敗：所有非台幣資產都依賴此匯率，
 * 若當成「無報價」繼續寫入，會刪掉當天正確的快照並把淨資產記成 0。
 */
export async function fetchUsdtTwdRate(
  fetcher: CryptoFetch,
  signal?: AbortSignal,
): Promise<number> {
  const ticker = await getMaxPublic<{ last?: unknown }>(
    fetcher,
    "/api/v3/ticker?market=usdttwd",
    signal,
  );
  const rate = Number(ticker?.last);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("MAX usdttwd 報價無效，無法換算台幣");
  }
  return rate;
}
