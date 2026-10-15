const FUBON_EGRESS_HOST = "ebank.taipeifubon.com.tw";
const FUBON_EGRESS_NAME = "fubon";

// 台北富邦網銀會重設 Browser Run 出口的 TLS 連線，但接受 Worker fetch()。
// 瀏覽器攔截到的網銀請求改由這個物件代發：每個 Durable Object 請求各自有
// 子請求額度，避免單次 Worker 呼叫超過免費方案 50 個對外子請求的上限。
// 固定名稱的物件只在首次建立時採用 locationHint，之後留在同一機房。
const FUBON_EGRESS_LOCATION = "apac" as const;

const ALLOWED_METHODS = new Set(["GET", "POST"]);

export function isFubonEgressUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === FUBON_EGRESS_HOST &&
      (url.port === "" || url.port === "443") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

/** 只轉送網銀 host 的 GET／POST；不跟隨轉址，交由瀏覽器處理 3xx。不記錄內容。 */
export async function proxyFubonEgress(
  request: Request,
  outbound: (request: Request) => Promise<Response> = fetch,
  cache?: FubonStaticCache,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method) || !isFubonEgressUrl(request.url)) {
    return new Response(null, { status: 403 });
  }
  const cacheable = cache !== undefined && isFubonStaticRequest(request);
  if (cacheable) {
    const hit = await cache.get(request.url);
    if (hit) return staticResponse(hit, "hit");
  }
  const response = await outbound(new Request(request, { redirect: "manual" }));
  if (!cacheable || !isFubonStaticResponse(response)) return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const entry = {
    status: response.status,
    headers: storedHeaders(response.headers),
    body,
  };
  if (body.byteLength <= FUBON_STATIC_MAX_ENTRY_BYTES)
    await cache.put(request.url, entry);
  return staticResponse(entry, "miss");
}

// ---------------------------------------------------------------------------
// 靜態資源快取（Durable Object 儲存）
// ---------------------------------------------------------------------------
// 網銀頁面每次同步都會在新的 Browser session 重新載入相同的 .js／.css；瀏覽器
// HTTP 快取與 Worker isolate 記憶體都撐不過一次同步。代發物件只有一個，因此在其
// SQLite 儲存保留靜態檔，命中時不再向銀行請求（不帶任何 cookie 或使用者資料）。
// 只快取：GET、路徑副檔名 .js／.css、HTTP 200、沒有 Set-Cookie、未標示
// no-store／private、Content-Type 為 JavaScript 或 CSS 的回應，保存 12 小時。

export const FUBON_STATIC_TTL_MS = 12 * 60 * 60 * 1000;
export const FUBON_STATIC_MAX_ENTRY_BYTES = 1024 * 1024;
export const FUBON_STATIC_CACHE_HEADER = "x-all-set-egress-cache";

export type FubonStaticEntry = {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  storedAt: number;
};

export interface FubonStaticCache {
  get(url: string): Promise<FubonStaticEntry | undefined>;
  put(url: string, entry: Omit<FubonStaticEntry, "storedAt">): Promise<void>;
}

export function isFubonStaticRequest(request: Request) {
  if (request.method !== "GET") return false;
  try {
    return /\.(?:js|css)$/i.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

export function isFubonStaticResponse(response: Response) {
  if (response.status !== 200) return false;
  if (response.headers.getSetCookie().length > 0) return false;
  if (/no-store|private/i.test(response.headers.get("cache-control") ?? ""))
    return false;
  return /javascript|ecmascript|text\/css/i.test(
    response.headers.get("content-type") ?? "",
  );
}

// Worker fetch() 已解壓縮內容；編碼／長度標頭不保存，避免與內容不符。
const UNSTORED_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "date",
  "age",
]);

function storedHeaders(headers: Headers): [string, string][] {
  const entries: [string, string][] = [];
  headers.forEach((value, name) => {
    if (!UNSTORED_HEADERS.has(name.toLowerCase())) entries.push([name, value]);
  });
  return entries;
}

function staticResponse(
  entry: Omit<FubonStaticEntry, "storedAt">,
  result: "hit" | "miss",
) {
  const headers = new Headers(entry.headers);
  headers.set(FUBON_STATIC_CACHE_HEADER, result);
  return new Response(entry.body.slice(), { status: entry.status, headers });
}

/** 以 Durable Object 儲存實作的快取；同一實例另以記憶體保留最近讀取的項目。 */
export function createFubonStaticCache(
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">,
  now: () => number = Date.now,
): FubonStaticCache {
  const memory = new Map<string, FubonStaticEntry>();
  let lastPrune = 0;
  const fresh = (entry: FubonStaticEntry | undefined) =>
    entry !== undefined && now() - entry.storedAt < FUBON_STATIC_TTL_MS;
  return {
    async get(url) {
      const cached = memory.get(url);
      if (fresh(cached)) return cached;
      const stored = await storage.get<FubonStaticEntry>(`static:${url}`);
      if (!fresh(stored)) {
        memory.delete(url);
        return undefined;
      }
      memory.set(url, stored!);
      return stored;
    },
    async put(url, value) {
      const entry: FubonStaticEntry = { ...value, storedAt: now() };
      memory.set(url, entry);
      await storage.put(`static:${url}`, entry);
      await storage.put(`static-meta:${url}`, entry.storedAt);
      // 每小時最多清除一次過期項目（只列出時間戳，不讀取內容）。
      if (now() - lastPrune < 60 * 60 * 1000) return;
      lastPrune = now();
      const stamps = await storage.list<number>({ prefix: "static-meta:" });
      const expired = [...stamps]
        .filter(([, storedAt]) => now() - storedAt >= FUBON_STATIC_TTL_MS)
        .map(([key]) => key.slice("static-meta:".length));
      for (const key of expired) {
        memory.delete(key);
        await storage.delete([`static:${key}`, `static-meta:${key}`]);
      }
    },
  };
}

export function createFubonEgressFetcher(
  namespace: DurableObjectNamespace,
): (request: Request) => Promise<Response> {
  const stub = namespace.getByName(FUBON_EGRESS_NAME, {
    locationHint: FUBON_EGRESS_LOCATION,
  });
  return (request) => stub.fetch(request);
}
