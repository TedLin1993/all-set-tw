import {
  cryptoEndpointLabel,
  hmacSha256Hex,
  responseEdgeLocation,
} from "../crypto-holdings";
import {
  MAX_API_BASE_URL,
  cryptoRequestSignal,
  fetchUsdtTwdRate,
  type CryptoFetch,
} from "../crypto-prices";
import { reportSyncProgress } from "../sync-progress";
import {
  BINANCE_CREDENTIAL_ERROR_CODES,
  BinanceApiError,
  BinanceCredentialError,
  BinanceRegionBlockedError,
  type BinanceFuturesAccount,
  type BinanceWalletBalance,
  type BinanceFlexiblePosition,
  type BinanceFundingAsset,
  type BinanceLockedPosition,
  type BinanceSnapshot,
  type BinanceSpotAccount,
  type BinanceTickerPrice,
} from "./protocol";

const SPOT_BASE_URL = "https://api.binance.com";
const USDM_BASE_URL = "https://fapi.binance.com";
const COINM_BASE_URL = "https://dapi.binance.com";
/** 一次同步會用到的 API origin（含 MAX 的 `usdttwd`），代發前先開好同源頁面。 */
export const BINANCE_EGRESS_ORIGINS = [
  SPOT_BASE_URL,
  USDM_BASE_URL,
  COINM_BASE_URL,
  MAX_API_BASE_URL,
];
const RECV_WINDOW_MS = 10_000;
const EARN_PAGE_SIZE = 100;
const EARN_MAX_PAGES = 20;
/** 選用錢包回這些 HTTP status 且帶 Binance 錯誤碼時，才視為未開通或無權限。 */
const UNAVAILABLE_WALLET_STATUSES = new Set([400, 401, 403, 404]);
/** 限流、時間差、內部錯誤與逾時等暫時性錯誤碼，即使是 4xx 也不能當成未開通。 */
const TRANSIENT_ERROR_CODES = new Set([
  -1000, -1001, -1003, -1006, -1007, -1008, -1021,
]);

export type BinanceClientOptions = {
  apiKey: string;
  apiSecret: string;
  fetcher?: CryptoFetch;
  signal?: AbortSignal;
  now?: () => number;
};

/** 依官方 SIGNED endpoint 規則，把 HMAC-SHA256 hex 簽章附加在參數字串後。 */
export async function signBinanceParams(
  apiSecret: string,
  params: Record<string, string>,
) {
  const query = new URLSearchParams(params).toString();
  return `${query}&signature=${await hmacSha256Hex(apiSecret, query)}`;
}

function createBinanceClient(options: BinanceClientOptions) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;

  async function request<T>(
    endpoint: string,
    init: {
      baseUrl: string;
      method?: "GET" | "POST";
      params?: Record<string, string>;
      signed?: boolean;
    },
  ): Promise<T> {
    const method = init.method ?? "GET";
    const params = init.signed
      ? {
          ...init.params,
          recvWindow: String(RECV_WINDOW_MS),
          timestamp: String(now()),
        }
      : (init.params ?? {});
    const query = init.signed
      ? await signBinanceParams(options.apiSecret, params)
      : new URLSearchParams(params).toString();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.signed) headers["X-MBX-APIKEY"] = options.apiKey;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const url = `${init.baseUrl}${endpoint}${method === "GET" && query ? `?${query}` : ""}`;
    const response = await fetcher(url, {
      method,
      headers,
      body: method === "POST" ? query : undefined,
      signal: cryptoRequestSignal(options.signal),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const code =
      body && typeof body === "object" && "code" in body
        ? Number((body as { code: unknown }).code)
        : undefined;
    if (!response.ok) {
      if (
        response.status === 451 ||
        (response.status === 403 && code === undefined)
      ) {
        throw new BinanceRegionBlockedError(
          response.status,
          responseEdgeLocation(response),
        );
      }
      if (code !== undefined && BINANCE_CREDENTIAL_ERROR_CODES.has(code)) {
        throw new BinanceCredentialError();
      }
      throw new BinanceApiError(endpoint, response.status, code);
    }
    // 成功狀態卻不是 JSON（例如 HTML 維護頁或空回應）時同步失敗，不可當成沒有資產。
    if (body === undefined) {
      throw new Error(
        `Binance ${cryptoEndpointLabel(endpoint)} 回應格式異常，無法同步`,
      );
    }
    return body as T;
  }

  /**
   * 未開通或此 key 無權限的錢包當成沒有該錢包，而不是整次同步失敗。只接受白名單：
   * 權限錯誤，或 400／401／403／404 帶非暫時性錯誤碼。429、418（IP 封鎖）、
   * 網路錯誤、5xx 與地區封鎖仍向上拋，避免少算資產。
   */
  async function optional<T>(
    label: string,
    task: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await task();
    } catch (error) {
      if (
        error instanceof BinanceCredentialError ||
        (error instanceof BinanceApiError &&
          UNAVAILABLE_WALLET_STATUSES.has(error.status) &&
          error.code !== undefined &&
          !TRANSIENT_ERROR_CODES.has(error.code))
      ) {
        console.warn(`[sync] binance: ${label} unavailable, counted as empty`);
        return undefined;
      }
      throw error;
    }
  }

  async function earnPositions<T>(endpoint: string): Promise<T[]> {
    const rows: T[] = [];
    for (let current = 1; current <= EARN_MAX_PAGES; current += 1) {
      const page = await request<{ rows?: T[]; total?: number }>(endpoint, {
        baseUrl: SPOT_BASE_URL,
        signed: true,
        params: { current: String(current), size: String(EARN_PAGE_SIZE) },
      });
      // 空帳戶若省略 rows，只在 total 明確為 0 時視為沒有部位。
      const pageRows =
        page?.rows === undefined && Number(page?.total) === 0
          ? []
          : requireArray<T>(page?.rows, endpoint);
      rows.push(...pageRows);
      // 缺少 total 時只依本頁筆數判斷，避免第一頁剛好 100 筆時截斷。
      const total = Number(page?.total);
      if (
        pageRows.length < EARN_PAGE_SIZE ||
        (Number.isFinite(total) && rows.length >= total)
      ) {
        return rows;
      }
    }
    // 超過分頁上限仍未取完時不默默截斷，避免少算理財持倉。
    throw new Error(`Binance 理財持倉超過 ${EARN_MAX_PAGES} 頁，無法完整取得`);
  }

  return {
    spotAccount: () =>
      request<BinanceSpotAccount>("/api/v3/account", {
        baseUrl: SPOT_BASE_URL,
        signed: true,
        params: { omitZeroBalances: "true" },
      }),
    fundingAssets: () =>
      optional("funding", () =>
        request<BinanceFundingAsset[]>("/sapi/v1/asset/get-funding-asset", {
          baseUrl: SPOT_BASE_URL,
          method: "POST",
          signed: true,
        }),
      ),
    flexiblePositions: () =>
      optional("earn flexible", () =>
        earnPositions<BinanceFlexiblePosition>(
          "/sapi/v1/simple-earn/flexible/position",
        ),
      ),
    lockedPositions: () =>
      optional("earn locked", () =>
        earnPositions<BinanceLockedPosition>(
          "/sapi/v1/simple-earn/locked/position",
        ),
      ),
    usdmAccount: () =>
      optional("usd-m futures", () =>
        request<BinanceFuturesAccount>("/fapi/v2/account", {
          baseUrl: USDM_BASE_URL,
          signed: true,
        }),
      ),
    coinmAccount: () =>
      optional("coin-m futures", () =>
        request<BinanceFuturesAccount>("/dapi/v1/account", {
          baseUrl: COINM_BASE_URL,
          signed: true,
        }),
      ),
    /** 每個錢包的總值（以 USDT 計價），用來補上沒有逐一串接的帳戶。 */
    walletBalances: () =>
      optional("wallet balance", () =>
        request<BinanceWalletBalance[]>("/sapi/v1/asset/wallet/balance", {
          baseUrl: SPOT_BASE_URL,
          signed: true,
          params: { quoteAsset: "USDT" },
        }),
      ),
    tickerPrices: () =>
      request<BinanceTickerPrice[]>("/api/v3/ticker/price", {
        baseUrl: SPOT_BASE_URL,
      }),
  };
}

/**
 * 回應格式異常時讓同步失敗並保留前一次快照，避免把錢包當成空的、
 * 或整批持倉寫成未估值而覆蓋當天快照。
 */
function requireArray<T>(value: T[] | unknown, endpoint: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Binance ${cryptoEndpointLabel(endpoint)} 回應格式異常，無法同步`,
    );
  }
  return value as T[];
}

/** 選用錢包未開通時為 undefined；有回應時必須是陣列。 */
function optionalArray<T>(value: T[] | undefined, endpoint: string) {
  return value === undefined ? undefined : requireArray<T>(value, endpoint);
}

/** 合約帳戶未開通時為 undefined；有回應時 `assets` 必須是陣列。 */
function optionalFutures(
  value: BinanceFuturesAccount | undefined,
  endpoint: string,
) {
  if (value === undefined) return undefined;
  requireArray(value?.assets, endpoint);
  return value;
}

/**
 * 先以必要的現貨帳戶確認金鑰與地區可用，再平行取得其他錢包與報價。
 * 金鑰錯誤只在現貨帳戶判定；其他端點的權限不足視為未開通。
 */
export async function fetchBinanceSnapshot(
  options: BinanceClientOptions,
): Promise<BinanceSnapshot> {
  const client = createBinanceClient(options);
  const spot = await client.spotAccount();
  reportSyncProgress("fetching");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const [funding, flexible, locked, usdm, coinm, wallets, tickers, usdtTwd] =
    await Promise.all([
      client.fundingAssets(),
      client.flexiblePositions(),
      client.lockedPositions(),
      client.usdmAccount(),
      client.coinmAccount(),
      client.walletBalances(),
      client.tickerPrices(),
      fetchUsdtTwdRate(fetcher, options.signal),
    ]);
  requireArray(spot?.balances, "account");
  return {
    spot,
    funding: optionalArray(funding, "get-funding-asset"),
    flexible,
    locked,
    usdm: optionalFutures(usdm, "fapi account"),
    coinm: optionalFutures(coinm, "dapi account"),
    wallets: optionalArray(wallets, "wallet/balance"),
    tickers: requireArray(tickers, "ticker/price"),
    usdtTwd,
  };
}
