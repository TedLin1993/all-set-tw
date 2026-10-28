import type { Browser, Page } from "@cloudflare/puppeteer";
import { closeBrowserSession, launchBrowserWithRetry } from "./browser";

/**
 * 加密貨幣交易所的對外請求改由 Browser Run 代發。
 *
 * Binance 與 MAX 都拒絕 Cloudflare Workers 的對外連線（Worker fetch 不論機房都回
 * 403／451），但接受 Browser Run 的連線。瀏覽器的位置跟著開啟它的呼叫端，因此由
 * 固定區域的 Durable Object 開瀏覽器。這裡是瀏覽器端：開瀏覽器、為每個 origin 建立
 * 同源頁面並在頁面內執行 fetch；Durable Object 的 HTTP 介面、Worker 端 fetcher 與
 * 區域備援在 `platform/crypto-browser-egress.ts`。請求在 Worker 簽章完成，瀏覽器
 * 不接觸 secret。
 */

/** 允許代發的交易所 API origin，以及建立同源頁面用的輕量公開端點。 */
export const CRYPTO_EGRESS_ORIGINS: Readonly<Record<string, string>> = {
  "https://api.binance.com": "/api/v3/ping",
  "https://fapi.binance.com": "/fapi/v1/ping",
  "https://dapi.binance.com": "/dapi/v1/ping",
  "https://max-api.maicoin.com": "/api/v3/ticker?market=usdttwd",
};

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
          // 允許清單只檢查第一個網址；不跟隨轉址，避免 API Key 與簽章送到清單外的主機。
          redirect: "error",
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
