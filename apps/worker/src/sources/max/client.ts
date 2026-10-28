import {
  cryptoEndpointLabel,
  hmacSha256Hex,
  normalizeCryptoQuantity,
  responseEdgeLocation,
} from "../crypto-holdings";
import {
  MAX_API_BASE_URL,
  cryptoRequestSignal,
  fetchMaxMarkets,
  fetchMaxTickers,
  type CryptoFetch,
} from "../crypto-prices";
import { reportSyncProgress } from "../sync-progress";
import {
  MaxAccessBlockedError,
  MaxApiError,
  MaxCredentialError,
  maxWalletBalances,
  selectMaxPriceMarkets,
  type MaxAccount,
  type MaxSnapshot,
} from "./protocol";

/** 一次同步會用到的 API origin，代發前先開好同源頁面。 */
export const MAX_EGRESS_ORIGINS = [MAX_API_BASE_URL];

export type MaxClientOptions = {
  accessKey: string;
  secretKey: string;
  fetcher?: CryptoFetch;
  signal?: AbortSignal;
  now?: () => number;
};

/**
 * v3 認證：payload 為 `{ nonce, ...params, path }` 的 JSON 再 Base64，
 * signature 為以 Secret Key 對 payload 計算的 HMAC-SHA256 hex。
 */
export async function signMaxRequest(
  secretKey: string,
  path: string,
  params: Record<string, string | number>,
) {
  const payload = btoa(JSON.stringify({ ...params, path }));
  return { payload, signature: await hmacSha256Hex(secretKey, payload) };
}

function createMaxClient(options: MaxClientOptions) {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let lastNonce = 0;
  // MAX 拒絕重複 nonce；平行請求需遞增。
  const nextNonce = () => {
    lastNonce = Math.max(now(), lastNonce + 1);
    return lastNonce;
  };

  async function privateGet<T>(path: string): Promise<T> {
    const params = { nonce: nextNonce() };
    const { payload, signature } = await signMaxRequest(
      options.secretKey,
      path,
      params,
    );
    const response = await fetcher(
      `${MAX_API_BASE_URL}${path}?${new URLSearchParams({ nonce: String(params.nonce) })}`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-MAX-ACCESSKEY": options.accessKey,
          "X-MAX-PAYLOAD": payload,
          "X-MAX-SIGNATURE": signature,
        },
        signal: cryptoRequestSignal(options.signal),
      },
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      if (response.status === 401) throw new MaxCredentialError();
      const rawCode =
        body && typeof body === "object" && "error" in body
          ? Number((body as { error?: { code?: unknown } }).error?.code)
          : undefined;
      const code = Number.isFinite(rawCode) ? rawCode : undefined;
      if (
        (response.status === 403 || response.status === 451) &&
        code === undefined
      ) {
        throw new MaxAccessBlockedError(
          response.status,
          responseEdgeLocation(response),
        );
      }
      throw new MaxApiError(path, response.status, code);
    }
    // 成功狀態卻不是 JSON（例如 HTML 維護頁或空回應）時同步失敗，不可當成未開通的錢包。
    if (body === undefined) {
      throw new Error(
        `MAX ${cryptoEndpointLabel(path)} 回應格式異常，無法同步`,
      );
    }
    return body as T;
  }

  return {
    spotAccounts: () =>
      privateGet<MaxAccount[]>("/api/v3/wallet/spot/accounts"),
    /**
     * M 錢包未開通或無權限（400／401／403／404）時視為沒有 M 錢包；
     * 429 限流、網路錯誤與 5xx 仍向上拋，避免漏扣借款而高估資產。
     */
    mAccounts: async () => {
      try {
        return await privateGet<MaxAccount[]>("/api/v3/wallet/m/accounts");
      } catch (error) {
        if (
          (error instanceof MaxApiError &&
            [400, 403, 404].includes(error.status)) ||
          error instanceof MaxCredentialError
        ) {
          console.warn("[sync] max: m-wallet unavailable, counted as empty");
          return undefined;
        }
        throw error;
      }
    },
  };
}

export async function fetchMaxSnapshot(
  options: MaxClientOptions,
): Promise<MaxSnapshot> {
  const client = createMaxClient(options);
  const spot = await client.spotAccounts();
  reportSyncProgress("fetching");
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const [m, markets] = await Promise.all([
    client.mAccounts(),
    fetchMaxMarkets(fetcher, options.signal),
  ]);
  // 格式異常的 200 回應（例如維護頁）不可當成沒有持倉，否則會以零值列覆蓋當天快照。
  if (!Array.isArray(spot)) {
    throw new Error("MAX 現貨帳戶回應格式異常，無法同步");
  }
  if (m !== undefined && !Array.isArray(m)) {
    throw new Error("MAX M 錢包回應格式異常，無法同步");
  }
  const accounts = { spot, m };
  const held = maxWalletBalances(accounts)
    .filter((balance) => normalizeCryptoQuantity(balance.quantity) !== 0)
    .map((balance) => balance.asset);
  const tickers = await fetchMaxTickers(
    fetcher,
    selectMaxPriceMarkets(markets, held),
    options.signal,
  );
  // USDT 與只有 usdt 市場的幣都依賴 usdttwd；取不到時讓同步失敗，保留前一次快照，
  // 不以未估值的列覆蓋當天資料（與 Binance 的 fetchUsdtTwdRate 一致）。
  const usdtTwd = Number(
    tickers.find((ticker) => ticker.market === "usdttwd")?.last,
  );
  if (!Number.isFinite(usdtTwd) || usdtTwd <= 0) {
    throw new Error("MAX usdttwd 報價無效，無法換算台幣");
  }
  return { ...accounts, tickers };
}
