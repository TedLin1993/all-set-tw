import type { CDPSession, Page } from "@cloudflare/puppeteer";

// 台北富邦網銀會重設 Browser Run 出口的連線（net::ERR_CONNECTION_RESET），
// 因此登入頁與內容頁框的網銀請求都在瀏覽器端以 CDP Fetch 攔截，改由 FubonEgress
// Durable Object 以 Worker fetch() 代發，再把狀態碼、標頭與內容回填給瀏覽器。
// 其他網站（分析、客服等）與字型、媒體、非驗證碼圖片一律中止，以控制子請求數。
//
// 直接使用 CDP（而非 page.setRequestInterception）是為了以原生 Buffer 做 base64：
// puppeteer 的 respond() 逐位元組組字串，載入一次登入頁就要數百毫秒 CPU。

export const FUBON_EGRESS_ORIGIN = "https://ebank.taipeifubon.com.tw";
const FUBON_HOST = new URL(FUBON_EGRESS_ORIGIN).hostname;
const CAPTCHA_PATH = "/B2C/captchaImage";
const CLICK_TRACKING_PATH = "/B2C/click";
export const FUBON_LOGIN_SERVLET_PATH = "/B2C/B2CLoginServlet";
export const FUBON_LOGOUT_AJAX_ACTION = "doLogoutAction";
const SERVLET_JSON_MAX_BYTES = 64 * 1024;
const EXCHANGE_LOG_LIMIT = 64;

/**
 * 經代發的關鍵網銀 POST（B2CLoginServlet 與官方登出 doLogoutAction）。
 * 登入成功後頁面會立即離開登入頁，puppeteer 已無法讀取該 XHR 的內容，因此在
 * 回填給瀏覽器之前先於記憶體保留（只在當次同步內使用，不寫入記錄）。
 */
export type FubonExchange = {
  seq: number;
  path: string;
  /** 表單參數 action（B2CLoginServlet）或 ajaxAction（JSF 頁面）。 */
  action: string;
  status: number;
  /** 只保留 B2CLoginServlet 的 JSON 回應。 */
  json?: Record<string, unknown>;
};

type ExchangeListener = (exchange: FubonExchange) => void;

export class FubonExchangeLog {
  private entries: FubonExchange[] = [];
  private seq = 0;
  private listeners = new Set<ExchangeListener>();

  /** 目前序號；之後的 waitFor 只接受比它新的紀錄。 */
  mark() {
    return this.seq;
  }

  record(exchange: Omit<FubonExchange, "seq">) {
    this.seq += 1;
    const entry = { ...exchange, seq: this.seq };
    this.entries.push(entry);
    if (this.entries.length > EXCHANGE_LOG_LIMIT) this.entries.shift();
    for (const listener of [...this.listeners]) listener(entry);
  }

  find(predicate: (exchange: FubonExchange) => boolean, since: number) {
    return this.entries.find((entry) => entry.seq > since && predicate(entry));
  }

  waitFor(
    predicate: (exchange: FubonExchange) => boolean,
    since: number,
    timeoutMs: number,
  ): Promise<FubonExchange | undefined> {
    const existing = this.find(predicate, since);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const listener: ExchangeListener = (entry) => {
        if (entry.seq <= since || !predicate(entry)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(entry);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      this.listeners.add(listener);
    });
  }
}

/** 由表單內容取得 action／ajaxAction；不是表單或沒有時回傳 undefined。 */
export function exchangeAction(body: Buffer | string | undefined) {
  if (body === undefined) return undefined;
  const text = typeof body === "string" ? body : body.toString("utf8");
  if (!text || text.length > SERVLET_JSON_MAX_BYTES) return undefined;
  try {
    const params = new URLSearchParams(text);
    return params.get("action") ?? params.get("ajaxAction") ?? undefined;
  } catch {
    return undefined;
  }
}

/** 決定是否保留此筆交換紀錄；只保留登入 servlet 與官方登出。 */
export function exchangeToRecord(
  url: string,
  method: string,
  requestBody: Buffer | string | undefined,
  status: number,
  responseBody: Buffer,
): Omit<FubonExchange, "seq"> | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const action = exchangeAction(requestBody);
  if (!action) return undefined;
  if (path === FUBON_LOGIN_SERVLET_PATH) {
    let json: Record<string, unknown> | undefined;
    if (status === 200 && responseBody.length <= SERVLET_JSON_MAX_BYTES) {
      try {
        const parsed: unknown = JSON.parse(responseBody.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          json = parsed as Record<string, unknown>;
      } catch {
        // 非 JSON（例如錯誤頁）；只保留狀態碼。
      }
    }
    return { path, action, status, json };
  }
  if (action === FUBON_LOGOUT_AJAX_ACTION) return { path, action, status };
  return undefined;
}

/** 轉送給 FubonEgress 的請求；不跟隨轉址，3xx 交回瀏覽器處理。 */
export type FubonEgressFetch = (request: Request) => Promise<Response>;

export type FubonEgressStats = {
  /** 經 Durable Object 代發的請求數（即內部子請求數）。 */
  proxied: number;
  /** 由 isolate 內靜態快取直接回應的請求數。 */
  cached: number;
  /** 經代發但由 FubonEgress 儲存的靜態快取回應（未向銀行請求）。 */
  egressCached: number;
  aborted: number;
  failed: number;
  byType: Record<string, number>;
};

const PROXIED_TYPES = new Set([
  "document",
  "script",
  "xhr",
  "fetch",
  "stylesheet",
]);
const ALLOWED_METHODS = new Set(["GET", "POST"]);

// 瀏覽器自行處理或由連接器重新產生的標頭，不轉送給銀行。
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "accept-encoding",
]);
// Worker fetch() 已解壓縮內容，編碼與長度標頭必須移除；Set-Cookie 另外逐筆處理。
const EGRESS_CACHE_HEADER = "x-all-set-egress-cache";
const DROPPED_RESPONSE_HEADERS = new Set([
  EGRESS_CACHE_HEADER,
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "alt-svc",
]);

type HeaderEntry = { name: string; value: string };

// 同一個 isolate 內重複載入的網銀靜態腳本／樣式直接由記憶體回應，避免重複的
// Durable Object 請求（瀏覽器 HTTP 快取只在同一個 Browser session 內有效）。
// 只快取無 Set-Cookie、狀態 200 且未標示 no-store 的 .js／.css GET 回應。
type CachedResponse = { status: number; headers: HeaderEntry[]; body: string };
const STATIC_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const staticCache = new Map<string, CachedResponse>();
let staticCacheBytes = 0;

export function createFubonEgressStats(): FubonEgressStats {
  return {
    proxied: 0,
    cached: 0,
    egressCached: 0,
    aborted: 0,
    failed: 0,
    byType: {},
  };
}

/** 決定攔截到的請求要代發或中止；只代發網銀 host 的必要請求。 */
export function classifyFubonRequest(
  url: string,
  resourceType: string,
  method: string,
): "proxy" | "abort" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "abort";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== FUBON_HOST ||
    (parsed.port !== "" && parsed.port !== "443")
  ) {
    return "abort";
  }
  if (!ALLOWED_METHODS.has(method.toUpperCase())) return "abort";
  const type = resourceType.toLowerCase();
  if (type === "image") {
    return parsed.pathname === CAPTCHA_PATH ? "proxy" : "abort";
  }
  return PROXIED_TYPES.has(type) ? "proxy" : "abort";
}

export function isFubonClickTracking(url: string, method: string) {
  try {
    const parsed = new URL(url);
    return (
      method.toUpperCase() === "POST" &&
      parsed.hostname === FUBON_HOST &&
      parsed.pathname === CLICK_TRACKING_PATH
    );
  } catch {
    return false;
  }
}

export function isStaticCacheable(
  url: string,
  resourceType: string,
  method: string,
) {
  const type = resourceType.toLowerCase();
  if (method.toUpperCase() !== "GET") return false;
  if (type !== "script" && type !== "stylesheet") return false;
  try {
    return /\.(?:js|css)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function buildForwardHeaders(
  headers: Record<string, string>,
  cookie: string,
) {
  const forwarded = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(key) || key.startsWith(":")) continue;
    forwarded.set(key, value);
  }
  if (cookie) forwarded.set("cookie", cookie);
  return forwarded;
}

/** 回填給瀏覽器的標頭；多筆 Set-Cookie 逐筆保留，交由瀏覽器 cookie 儲存處理。 */
export function buildBrowserResponseHeaders(response: Response): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  response.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(key)) return;
    entries.push({ name: key, value });
  });
  for (const value of response.headers.getSetCookie()) {
    entries.push({ name: "set-cookie", value });
  }
  return entries;
}

export function cookieHeader(
  cookies: ReadonlyArray<{ name: string; value: string; path?: string }>,
) {
  // 與瀏覽器相同：path 較長者在前。
  return [...cookies]
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

type PausedRequest = {
  requestId: string;
  resourceType: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    hasPostData?: boolean;
    postDataEntries?: Array<{ bytes?: string }>;
  };
};

export function pausedRequestBody(request: PausedRequest["request"]) {
  if (request.postDataEntries?.length) {
    return Buffer.concat(
      request.postDataEntries.map((entry) =>
        Buffer.from(entry.bytes ?? "", "base64"),
      ),
    );
  }
  return request.postData;
}

/**
 * 開啟頁面（含同源內容頁框）的請求攔截。每次連線（含人工驗證碼／OTP
 * 重新連線同一個 Browser session）都要重新呼叫；斷線時 CDP session 結束，
 * 攔截隨之解除。cookie 一律以瀏覽器自身的 cookie 儲存為準：送出前讀取該網址
 * 適用的 cookie（含 HttpOnly），回應的 Set-Cookie 由 Fetch.fulfillRequest
 * 交給瀏覽器儲存，因此 document.cookie、轉址與跨頁面的工作階段一致。
 */
export async function enableFubonEgress(
  page: Page,
  egress: FubonEgressFetch,
  stats: FubonEgressStats = createFubonEgressStats(),
  exchanges?: FubonExchangeLog,
) {
  const session = await page.createCDPSession();
  session.on("Fetch.requestPaused", (event: PausedRequest) => {
    void handlePaused(session, event, egress, stats, exchanges);
  });
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  return stats;
}

async function handlePaused(
  session: CDPSession,
  event: PausedRequest,
  egress: FubonEgressFetch,
  stats: FubonEgressStats,
  exchanges?: FubonExchangeLog,
) {
  const { requestId, request } = event;
  const url = request.url;
  const method = request.method.toUpperCase();
  const type = event.resourceType.toLowerCase();
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    await session
      .send("Fetch.continueRequest", { requestId })
      .catch(() => undefined);
    return;
  }
  if (isFubonClickTracking(url, method)) {
    // 官方點擊追蹤 /B2C/click 一律回 500 且與帳務無關：本地回 204，不送往銀行。
    stats.aborted += 1;
    await session
      .send("Fetch.fulfillRequest", { requestId, responseCode: 204 })
      .catch(() => undefined);
    return;
  }
  if (classifyFubonRequest(url, type, method) === "abort") {
    stats.aborted += 1;
    await session
      .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
      .catch(() => undefined);
    return;
  }
  const cacheable = isStaticCacheable(url, type, method);
  const cached = cacheable ? staticCache.get(url) : undefined;
  if (cached) {
    stats.cached += 1;
    await session
      .send("Fetch.fulfillRequest", {
        requestId,
        responseCode: cached.status,
        responseHeaders: cached.headers,
        body: cached.body,
      })
      .catch(() => undefined);
    return;
  }
  let fulfilled = false;
  try {
    const { cookies } = await session.send("Network.getCookies", {
      urls: [url],
    });
    const requestBody =
      method === "POST" ? pausedRequestBody(request) : undefined;
    const response = await egress(
      new Request(url, {
        method,
        headers: buildForwardHeaders(request.headers, cookieHeader(cookies)),
        body: requestBody,
        redirect: "manual",
      }),
    );
    stats.proxied += 1;
    stats.byType[type] = (stats.byType[type] ?? 0) + 1;
    if (response.headers.get(EGRESS_CACHE_HEADER) === "hit")
      stats.egressCached += 1;
    const headers = buildBrowserResponseHeaders(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (exchanges) {
      // 必須在回填前記錄：登入成功的處理函式會立即讓頁面離開登入頁。
      const exchange = exchangeToRecord(
        url,
        method,
        requestBody,
        response.status,
        bytes,
      );
      if (exchange) exchanges.record(exchange);
    }
    const body = bytes.toString("base64");
    if (
      cacheable &&
      response.status === 200 &&
      !headers.some((header) => header.name === "set-cookie") &&
      !/no-store/i.test(response.headers.get("cache-control") ?? "")
    ) {
      rememberStatic(url, { status: response.status, headers, body });
    }
    fulfilled = true;
    await session.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: response.status,
      responseHeaders: headers,
      body,
    });
  } catch {
    if (!fulfilled) {
      stats.failed += 1;
      await session
        .send("Fetch.failRequest", {
          requestId,
          errorReason: "ConnectionFailed",
        })
        .catch(() => undefined);
    }
  }
}

function rememberStatic(url: string, entry: CachedResponse) {
  const size = entry.body.length;
  if (size > STATIC_CACHE_MAX_BYTES / 4) return;
  while (
    staticCacheBytes + size > STATIC_CACHE_MAX_BYTES &&
    staticCache.size > 0
  ) {
    const oldest = staticCache.keys().next().value as string;
    staticCacheBytes -= staticCache.get(oldest)?.body.length ?? 0;
    staticCache.delete(oldest);
  }
  staticCache.set(url, entry);
  staticCacheBytes += size;
}

/** 測試用：清除 isolate 內的靜態快取。 */
export function clearFubonStaticCache() {
  staticCache.clear();
  staticCacheBytes = 0;
}
