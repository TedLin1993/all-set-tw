import {
  BrowserRunCapacityError,
  type BrowserRunCapacityKind,
} from "../sources/browser";
import {
  CryptoEgressForbiddenError,
  type CryptoBrowserSession,
  type CryptoEgressRequest,
  type CryptoEgressResponse,
} from "../sources/crypto-browser-egress";

/**
 * `CryptoBrowserEgress` Durable Object 的介面：物件的 HTTP 端點、Worker 端與 `fetch`
 * 相同介面的 fetcher，以及亞太被地區封鎖時改用西歐的區域備援。瀏覽器端的工作階段在
 * `sources/crypto-browser-egress.ts`。
 */

export type CryptoEgressFailure =
  | {
      error: "browser_capacity";
      kind: BrowserRunCapacityKind;
      retryAfterSeconds: number;
    }
  | {
      error: "forbidden_target" | "invalid_request" | "browser_failed";
      message: string;
    };

export const CRYPTO_EGRESS_LOCATIONS = ["apac", "weur"] as const;
export type CryptoEgressLocation = (typeof CRYPTO_EGRESS_LOCATIONS)[number];

// 免費方案每 20 秒才能開一個新瀏覽器；改用備援區域前需要等待。
export const CRYPTO_EGRESS_FALLBACK_DELAY_MS = 21_000;
export function parseCryptoEgressRequest(
  value: unknown,
): CryptoEgressRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, method, headers, body } = value as Record<string, unknown>;
  if (typeof url !== "string" || (method !== "GET" && method !== "POST"))
    return undefined;
  if (!headers || typeof headers !== "object") return undefined;
  if (
    Object.values(headers as Record<string, unknown>).some(
      (header) => typeof header !== "string",
    )
  )
    return undefined;
  if (body !== undefined && typeof body !== "string") return undefined;
  return {
    url,
    method,
    headers: headers as Record<string, string>,
    ...(body === undefined ? {} : { body }),
  };
}

export function parseCryptoEgressOrigins(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { origins } = value as Record<string, unknown>;
  if (!Array.isArray(origins) || origins.length === 0) return undefined;
  if (origins.some((origin) => typeof origin !== "string")) return undefined;
  return origins as string[];
}

function errorSummary(error: unknown) {
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 200)
    : "unknown error";
}

function cryptoEgressFailure(error: unknown): {
  status: number;
  failure: CryptoEgressFailure;
} {
  if (error instanceof BrowserRunCapacityError) {
    return {
      status: 503,
      failure: {
        error: "browser_capacity",
        kind: error.kind,
        retryAfterSeconds: error.retryAfterSeconds,
      },
    };
  }
  return {
    status: 502,
    failure: { error: "browser_failed", message: errorSummary(error) },
  };
}

/**
 * Durable Object 的 HTTP 介面：`POST /prepare` 預先開好同源頁面、`POST /request` 代發、
 * `POST /close` 關閉瀏覽器。
 */
export async function handleCryptoEgressRequest(
  request: Request,
  session: () => CryptoBrowserSession,
  dispose: () => Promise<void>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (path === "/close") {
    await dispose();
    return new Response(null, { status: 204 });
  }
  if (path !== "/request" && path !== "/prepare") {
    return new Response(null, { status: 404 });
  }
  const input = await request.json().catch(() => undefined);
  const run =
    path === "/prepare"
      ? prepareRun(session, parseCryptoEgressOrigins(input))
      : requestRun(session, parseCryptoEgressRequest(input));
  if (!run) {
    return Response.json(
      { error: "invalid_request", message: "代發請求格式錯誤" },
      { status: 400 },
    );
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof CryptoEgressForbiddenError) {
      return Response.json(
        { error: "forbidden_target", message: error.message },
        { status: 403 },
      );
    }
    const { status, failure } = cryptoEgressFailure(error);
    return Response.json(failure, { status });
  }
}

function prepareRun(
  session: () => CryptoBrowserSession,
  origins: string[] | undefined,
) {
  if (!origins) return undefined;
  return async () => {
    await session().prepare(origins);
    return new Response(null, { status: 204 });
  };
}

function requestRun(
  session: () => CryptoBrowserSession,
  parsed: CryptoEgressRequest | undefined,
) {
  if (!parsed) return undefined;
  return async () => Response.json(await session().execute(parsed));
}

// 關閉請求最多等待這麼久，避免同步卡在物件回應上。
const CLOSE_TIMEOUT_MS = 10_000;

type CryptoBrowserFetcher = {
  fetch: typeof fetch;
  prepare: (origins: readonly string[]) => Promise<void>;
  close: () => Promise<void>;
};

function throwCryptoEgressFailure(failure: CryptoEgressFailure): never {
  if (failure.error === "browser_capacity") {
    throw new BrowserRunCapacityError(failure.kind, failure.retryAfterSeconds);
  }
  throw new Error(`交易所代發失敗：${failure.message}`);
}

async function serializeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<CryptoEgressRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    throw new Error(`交易所代發不支援 ${method} 請求`);
  }
  const body = method === "POST" ? await request.text() : undefined;
  return {
    url: request.url,
    method,
    headers: Object.fromEntries(request.headers.entries()),
    ...(body ? { body } : {}),
  };
}

/**
 * 回傳與 `fetch` 相同介面的 fetcher，請求交由指定名稱與區域的 Durable Object 代發。
 * 取消 signal 不跨越物件邊界，由呼叫端在本地中止等待。
 */
export function createCryptoBrowserFetcher(
  namespace: DurableObjectNamespace,
  name: string,
  location: CryptoEgressLocation,
): CryptoBrowserFetcher {
  // 固定名稱的物件只在首次建立時採用 locationHint，之後留在同一機房。
  const stub = namespace.getByName(`crypto-${name}-${location}`, {
    locationHint: location,
  });
  let closed = false;
  const send = async (input: RequestInfo | URL, init?: RequestInit) => {
    // 關閉後仍在進行的分頁迴圈不得在物件內重新開瀏覽器。
    if (closed) throw new Error("交易所代發已結束，不再送出請求");
    const payload = await serializeRequest(input, init);
    const response = await stub.fetch("https://crypto-egress/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as
      CryptoEgressResponse | CryptoEgressFailure;
    if (!response.ok) throwCryptoEgressFailure(data as CryptoEgressFailure);
    const result = data as CryptoEgressResponse;
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const response = send(input, init);
    if (!signal) return response;
    // 中止後仍在進行的請求結果直接丟棄，避免成為未處理的 rejection。
    response.catch(() => undefined);
    return Promise.race([
      response,
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
    ]);
  }) as typeof fetch;
  return {
    fetch: fetcher,
    prepare: async (origins) => {
      if (closed) throw new Error("交易所代發已結束，不再送出請求");
      const response = await stub.fetch("https://crypto-egress/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origins }),
      });
      if (!response.ok) {
        throwCryptoEgressFailure(
          (await response.json()) as CryptoEgressFailure,
        );
      }
    },
    close: async () => {
      closed = true;
      await stub
        .fetch("https://crypto-egress/close", {
          method: "POST",
          signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
        })
        .catch(() => undefined);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * 先用亞太代發；交易所回地區封鎖時等待新瀏覽器額度，改用西歐再試一次。
 * 其他錯誤（金鑰、網路、額度）直接拋出，不換區域。
 */
export async function runWithCryptoEgressFallback<T>(
  run: (location: CryptoEgressLocation) => Promise<T>,
  isRegionBlocked: (error: unknown) => boolean,
  options: {
    signal?: AbortSignal;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<T> {
  const [primary, fallback] = CRYPTO_EGRESS_LOCATIONS;
  try {
    return await run(primary);
  } catch (error) {
    if (!isRegionBlocked(error)) throw error;
    (options.log ?? console.warn)(
      `[crypto-egress] ${primary} region blocked, retrying via ${fallback}`,
    );
    await (options.wait ?? sleep)(
      CRYPTO_EGRESS_FALLBACK_DELAY_MS,
      options.signal,
    );
    return run(fallback);
  }
}

/**
 * 建立 fetcher、先開好 `origins` 的同源頁面再執行，結束後關閉瀏覽器。
 * 簽章請求在瀏覽器就緒後才產生，避免啟動時間吃掉時間戳記的有效期間。
 */
export async function withCryptoBrowserFetcher<T>(
  namespace: DurableObjectNamespace,
  name: string,
  location: CryptoEgressLocation,
  origins: readonly string[],
  task: (fetcher: typeof fetch) => Promise<T>,
): Promise<T> {
  const fetcher = createCryptoBrowserFetcher(namespace, name, location);
  try {
    await fetcher.prepare(origins);
    return await task(fetcher.fetch);
  } finally {
    await fetcher.close();
  }
}
