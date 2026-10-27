import type { Browser, Page } from "@cloudflare/puppeteer";
import {
  BrowserRunCapacityError,
  closeBrowserSession,
  launchBrowserWithRetry,
  type BrowserRunCapacityKind,
} from "./browser";

/**
 * 加密貨幣交易所的對外請求改由 Browser Run 代發。
 *
 * Binance 與 MAX 都拒絕 Cloudflare Workers 的對外連線（Worker fetch 不論機房都回
 * 403／451），但接受 Browser Run 的連線。瀏覽器的位置跟著開啟它的呼叫端，因此由
 * 固定區域的 Durable Object 開瀏覽器：預設亞太（apac），Binance 回地區封鎖時改用
 * 西歐（weur）。請求在 Worker 簽章完成，瀏覽器只在同源頁面內執行 fetch，
 * 不接觸 secret。
 */

/** 允許代發的交易所 API origin，以及建立同源頁面用的輕量公開端點。 */
export const CRYPTO_EGRESS_ORIGINS: Readonly<Record<string, string>> = {
  "https://api.binance.com": "/api/v3/ping",
  "https://fapi.binance.com": "/fapi/v1/ping",
  "https://dapi.binance.com": "/dapi/v1/ping",
  "https://max-api.maicoin.com": "/api/v3/ticker?market=usdttwd",
};

export const CRYPTO_EGRESS_LOCATIONS = ["apac", "weur"] as const;
export type CryptoEgressLocation = (typeof CRYPTO_EGRESS_LOCATIONS)[number];

// 免費方案每 20 秒才能開一個新瀏覽器；改用備援區域前需要等待。
export const CRYPTO_EGRESS_FALLBACK_DELAY_MS = 21_000;
const PAGE_TIMEOUT_MS = 20_000;

/** 回傳給呼叫端、可協助判斷封鎖來源的回應標頭；其他標頭不跨越物件邊界。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cf-ray", "x-amz-cf-pop"];

export type CryptoEgressRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

export type CryptoEgressResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

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

/** 只接受允許清單內的 HTTPS origin；回傳 origin，否則 undefined。 */
export function cryptoEgressOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.origin in CRYPTO_EGRESS_ORIGINS ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

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

type PageLike = Pick<Page, "goto" | "evaluate" | "close">;
type BrowserLike = Pick<Browser, "newPage" | "once">;

// 取得瀏覽器的時間上限，比照共用銀行流程；逾時後晚到的 session 會被關閉。
const CRYPTO_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
// 關閉時最多等待這麼久；啟動中的瀏覽器會在連上後自動關閉。
const DISPOSE_WAIT_MS = 5_000;

export type CryptoBrowserSessionDeps = {
  /** 收到 signal 中止時應停止尚未送出的取得請求。 */
  launch: (signal: AbortSignal) => Promise<BrowserLike>;
  close: (browser: BrowserLike) => Promise<unknown>;
  launchTimeoutMs?: number;
};

class CryptoBrowserLaunchTimeoutError extends Error {
  constructor() {
    super("Cloudflare 瀏覽器啟動逾時，請稍後再試。");
    this.name = "CryptoBrowserLaunchTimeoutError";
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable Object 內的瀏覽器工作階段：第一次請求時開瀏覽器，每個 origin 開一個
 * 同源頁面，之後的請求都在該頁面內以 fetch 執行，避免 CORS 與重複開瀏覽器。
 */
export class CryptoBrowserSession {
  private browser?: Promise<BrowserLike>;
  private readonly pages = new Map<string, Promise<PageLike>>();

  constructor(private readonly deps: CryptoBrowserSessionDeps) {}

  async execute(request: CryptoEgressRequest): Promise<CryptoEgressResponse> {
    const origin = cryptoEgressOrigin(request.url);
    if (!origin) throw new CryptoEgressForbiddenError();
    const page = await this.pageFor(origin);
    return page.evaluate(
      async (input, forwarded) => {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          credentials: "omit",
        });
        const headers: Record<string, string> = {};
        for (const name of forwarded) {
          const value = response.headers.get(name);
          if (value) headers[name] = value;
        }
        return {
          status: response.status,
          headers,
          body: await response.text(),
        };
      },
      request,
      FORWARDED_RESPONSE_HEADERS,
    );
  }

  /**
   * 先開瀏覽器並建立各 origin 的同源頁面。簽章含時間戳記（Binance recvWindow、
   * MAX nonce），在瀏覽器就緒後才簽章，啟動較慢時請求才不會過期。
   */
  async prepare(origins: readonly string[]) {
    const allowed = origins.map((origin) => cryptoEgressOrigin(origin));
    if (allowed.some((origin) => origin === undefined)) {
      throw new CryptoEgressForbiddenError();
    }
    await Promise.all(allowed.map((origin) => this.pageFor(origin!)));
  }

  private launch() {
    const controller = new AbortController();
    let stopped = false;
    const acquisition = this.deps.launch(controller.signal).then((browser) => {
      if (stopped) {
        // 逾時或已關閉後才連上的 session 直接關掉，不留給之後的請求。
        void this.deps.close(browser).catch(() => undefined);
        throw new CryptoBrowserLaunchTimeoutError();
      }
      browser.once("disconnected", () => {
        if (this.browser === launched) this.reset();
      });
      return browser;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launched: Promise<BrowserLike> = Promise.race([
      acquisition,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopped = true;
          controller.abort();
          reject(new CryptoBrowserLaunchTimeoutError());
        }, this.deps.launchTimeoutMs ?? CRYPTO_BROWSER_LAUNCH_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    // 啟動失敗時清掉快取，讓之後的請求可以重新嘗試。
    launched.catch(() => {
      if (this.browser === launched) this.reset();
    });
    return launched;
  }

  private reset() {
    this.browser = undefined;
    this.pages.clear();
  }

  private pageFor(origin: string) {
    const existing = this.pages.get(origin);
    if (existing) return existing;
    const page = (async () => {
      this.browser ??= this.launch();
      const browser = await this.browser;
      const page = await browser.newPage();
      // 同源頁面讓後續 fetch 可以帶自訂標頭；端點回 4xx（例如地區封鎖）仍會停在該 origin。
      await page.goto(`${origin}${CRYPTO_EGRESS_ORIGINS[origin]}`, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MS,
      });
      return page;
    })();
    this.pages.set(origin, page);
    page.catch(() => {
      if (this.pages.get(origin) === page) this.pages.delete(origin);
    });
    return page;
  }

  /** 最多等待 5 秒；啟動尚未完成時，逾時後於連上時再關閉。 */
  async dispose() {
    const browser = this.browser;
    this.reset();
    if (!browser) return;
    const closing = browser
      .then((instance) => this.deps.close(instance))
      .catch(() => undefined);
    await Promise.race([closing, delay(DISPOSE_WAIT_MS)]);
  }
}

export class CryptoEgressForbiddenError extends Error {
  constructor() {
    super("目的地不在交易所代發的允許清單內");
    this.name = "CryptoEgressForbiddenError";
  }
}

/** 由 Durable Object 的 Browser binding 建立工作階段。 */
export function createCryptoBrowserSession(binding: Fetcher) {
  // Browser binding 是 RPC stub，讀取任何屬性都會得到非空值；包成一般物件，
  // 避免共用 launch 誤把 `syncSignal` 當成取消 signal。
  const plainBinding = { fetch: binding.fetch.bind(binding) };
  return new CryptoBrowserSession({
    launch: (signal) =>
      launchBrowserWithRetry(
        { ...plainBinding, syncSignal: signal },
        { keep_alive: 60_000 },
      ),
    close: (browser) => closeBrowserSession(plainBinding, browser as Browser),
  });
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
