import { describe, expect, it, vi } from "vitest";
import { BrowserRunCapacityError } from "../../src/sources/browser";
import {
  CryptoBrowserSession,
  cryptoEgressOrigin,
  type CryptoEgressRequest,
} from "../../src/sources/crypto-browser-egress";
import {
  CRYPTO_EGRESS_FALLBACK_DELAY_MS,
  createCryptoBrowserFetcher,
  handleCryptoEgressRequest,
  parseCryptoEgressRequest,
  runWithCryptoEgressFallback,
  withCryptoBrowserFetcher,
} from "../../src/platform/crypto-browser-egress";
import {
  BINANCE_EGRESS_ORIGINS,
  fetchBinanceSnapshot,
} from "../../src/sources/binance/client";
import { BinanceRegionBlockedError } from "../../src/sources/binance/protocol";

type PageFetch = (request: CryptoEgressRequest) => {
  status: number;
  headers?: Record<string, string>;
  body: string;
};

/** 假的瀏覽器：記錄開頁與同源頁面，evaluate 交給 pageFetch 模擬頁面內的 fetch。 */
function fakeBrowser(pageFetch: PageFetch) {
  const gotos: string[] = [];
  const evaluated: CryptoEgressRequest[] = [];
  let newPages = 0;
  const listeners = new Map<string, () => void>();
  const browser = {
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
      return browser;
    }),
    newPage: vi.fn(async () => {
      newPages += 1;
      return {
        goto: vi.fn(async (url: string) => {
          gotos.push(url);
          return null;
        }),
        evaluate: vi.fn(async (_fn: unknown, request: CryptoEgressRequest) => {
          evaluated.push(request);
          const result = pageFetch(request);
          return { headers: {}, ...result };
        }),
        close: vi.fn(async () => undefined),
      };
    }),
  };
  return {
    browser,
    gotos,
    evaluated,
    pageCount: () => newPages,
    disconnect: () => listeners.get("disconnected")?.(),
  };
}

function sessionWith(pageFetch: PageFetch) {
  const fake = fakeBrowser(pageFetch);
  const launch = vi.fn(async () => fake.browser as never);
  const close = vi.fn(async () => undefined);
  return {
    ...fake,
    launch,
    close,
    session: new CryptoBrowserSession({ launch, close }),
  };
}

/** 假的 Durable Object namespace：stub.fetch 直接交給 handleCryptoEgressRequest。 */
function fakeNamespace(session: CryptoBrowserSession) {
  const dispose = vi.fn(async () => undefined);
  const getByName = vi.fn(() => ({
    fetch: (input: string, init?: RequestInit) =>
      handleCryptoEgressRequest(
        new Request(input, init),
        () => session,
        dispose,
      ),
  }));
  return {
    namespace: { getByName } as unknown as DurableObjectNamespace,
    getByName,
    dispose,
  };
}

describe("加密貨幣交易所 Browser Run 代發", () => {
  it("只允許交易所 API 的 HTTPS origin", () => {
    expect(cryptoEgressOrigin("https://api.binance.com/api/v3/account")).toBe(
      "https://api.binance.com",
    );
    expect(cryptoEgressOrigin("https://max-api.maicoin.com/api/v3/x")).toBe(
      "https://max-api.maicoin.com",
    );
    for (const url of [
      "http://api.binance.com/api/v3/account",
      "https://api.binance.com:8443/api/v3/account",
      "https://user:pass@api.binance.com/api/v3/account",
      "https://example.com/api/v3/account",
      "not a url",
    ]) {
      expect(cryptoEgressOrigin(url)).toBeUndefined();
    }
  });

  it("代發請求只接受 GET／POST、字串標頭與字串 body", () => {
    const valid = {
      url: "https://api.binance.com/api/v3/account",
      method: "GET",
      headers: { "x-mbx-apikey": "key" },
    };
    expect(parseCryptoEgressRequest(valid)).toEqual(valid);
    expect(
      parseCryptoEgressRequest({ ...valid, method: "DELETE" }),
    ).toBeUndefined();
    expect(
      parseCryptoEgressRequest({ ...valid, headers: { a: 1 } }),
    ).toBeUndefined();
    expect(parseCryptoEgressRequest({ ...valid, body: {} })).toBeUndefined();
    expect(parseCryptoEgressRequest(null)).toBeUndefined();
  });

  it("一次工作階段只開一個瀏覽器，每個 origin 只建立一次同源頁面", async () => {
    const { session, launch, close, gotos, evaluated, pageCount } = sessionWith(
      () => ({ status: 200, body: "{}" }),
    );
    for (const url of [
      "https://api.binance.com/api/v3/account",
      "https://api.binance.com/sapi/v1/simple-earn/flexible/position",
      "https://fapi.binance.com/fapi/v2/account",
    ]) {
      await session.execute({ url, method: "GET", headers: {} });
    }
    expect(launch).toHaveBeenCalledTimes(1);
    expect(pageCount()).toBe(2);
    expect(gotos).toEqual([
      "https://api.binance.com/api/v3/ping",
      "https://fapi.binance.com/fapi/v1/ping",
    ]);
    expect(evaluated).toHaveLength(3);
    // 預先開頁時已建立的 origin 不重開，只補上新的 origin
    await session.prepare([
      "https://api.binance.com",
      "https://max-api.maicoin.com",
    ]);
    expect(pageCount()).toBe(3);
    await expect(
      session.prepare(["https://api.binance.com", "https://example.com"]),
    ).rejects.toThrow("允許清單");
    await expect(
      session.execute({
        url: "https://example.com/",
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow("允許清單");
    await session.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("頁面內 fetch 不跟隨轉址，也不帶瀏覽器憑證", async () => {
    const pageFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", pageFetch);
    try {
      const page = {
        goto: vi.fn(async () => null),
        // 實際執行傳入頁面的函式，檢查頁面內 fetch 的選項
        evaluate: vi.fn(
          async (
            fn: (input: unknown, forwarded: unknown) => unknown,
            ...args: [unknown, unknown]
          ) => fn(...args),
        ),
        close: vi.fn(async () => undefined),
      };
      const browser = { once: vi.fn(), newPage: vi.fn(async () => page) };
      const session = new CryptoBrowserSession({
        launch: async () => browser as never,
        close: async () => undefined,
      });
      await session.execute({
        url: "https://api.binance.com/api/v3/account",
        method: "GET",
        headers: { "x-mbx-apikey": "key" },
      });
      expect(pageFetch).toHaveBeenCalledWith(
        "https://api.binance.com/api/v3/account",
        expect.objectContaining({ redirect: "error", credentials: "omit" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("物件介面：關閉、格式錯誤、禁止目的地與 Browser Run 額度不足", async () => {
    const dispose = vi.fn(async () => undefined);
    const session = new CryptoBrowserSession({
      launch: async () => {
        throw new BrowserRunCapacityError("daily_quota", 3600);
      },
      close: async () => undefined,
    });
    const call = (path: string, body?: unknown) =>
      handleCryptoEgressRequest(
        new Request(`https://crypto-egress${path}`, {
          method: "POST",
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        () => session,
        dispose,
      );

    expect((await call("/close")).status).toBe(204);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((await call("/request", { url: 1 })).status).toBe(400);
    expect((await call("/prepare", { origins: [] })).status).toBe(400);
    expect(
      (await call("/prepare", { origins: ["https://example.com"] })).status,
    ).toBe(403);
    const preparing = await call("/prepare", {
      origins: ["https://api.binance.com"],
    });
    expect(preparing.status).toBe(503);
    expect(await preparing.json()).toMatchObject({ kind: "daily_quota" });
    const forbidden = await call("/request", {
      url: "https://example.com/",
      method: "GET",
      headers: {},
    });
    expect(forbidden.status).toBe(403);
    const capacity = await call("/request", {
      url: "https://api.binance.com/api/v3/account",
      method: "GET",
      headers: {},
    });
    expect(capacity.status).toBe(503);
    expect(await capacity.json()).toEqual({
      error: "browser_capacity",
      kind: "daily_quota",
      retryAfterSeconds: 3600,
    });
  });

  it("Worker 端 fetcher：固定名稱與區域、還原回應，額度不足轉成共用錯誤", async () => {
    const { session } = sessionWith((request) => ({
      status: 451,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seen: request.method }),
    }));
    const { namespace, getByName, dispose } = fakeNamespace(session);
    const fetcher = createCryptoBrowserFetcher(namespace, "binance", "apac");
    const response = await fetcher.fetch(
      "https://api.binance.com/api/v3/account",
    );
    expect(getByName).toHaveBeenCalledWith("crypto-binance-apac", {
      locationHint: "apac",
    });
    expect(response.status).toBe(451);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ seen: "GET" });
    await fetcher.close();
    expect(dispose).toHaveBeenCalledTimes(1);

    const busy = createCryptoBrowserFetcher(
      fakeNamespace(
        new CryptoBrowserSession({
          launch: async () => {
            throw new BrowserRunCapacityError("rate_limit", 20);
          },
          close: async () => undefined,
        }),
      ).namespace,
      "max",
      "weur",
    );
    await expect(
      busy.fetch("https://max-api.maicoin.com/api/v3/markets"),
    ).rejects.toBeInstanceOf(BrowserRunCapacityError);
  });

  it("取消 signal 在本地中止等待，不跨越物件邊界", async () => {
    let release: () => void = () => undefined;
    const getByName = vi.fn(() => ({
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(Response.json({ status: 200, headers: {}, body: "" }));
        }),
    }));
    const fetcher = createCryptoBrowserFetcher(
      { getByName } as unknown as DurableObjectNamespace,
      "binance",
      "apac",
    );
    const controller = new AbortController();
    const pending = fetcher.fetch("https://api.binance.com/api/v3/ping", {
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    release();
  });

  it("端到端：先開好所有同源頁面再簽章，簽章標頭與 POST body 經物件送到頁面內 fetch", async () => {
    let pagesReadyAtFirstRequest: number | undefined;
    const { session, evaluated, gotos } = sessionWith((request) => {
      pagesReadyAtFirstRequest ??= gotos.length;
      const path = new URL(request.url).pathname;
      const body =
        path === "/api/v3/account"
          ? { balances: [{ asset: "BTC", free: "0.1", locked: "0" }] }
          : path === "/api/v3/ticker/price"
            ? [{ symbol: "BTCUSDT", price: "60000" }]
            : path === "/api/v3/ticker"
              ? { market: "usdttwd", last: "32" }
              : path.includes("simple-earn")
                ? { rows: [], total: 0 }
                : path === "/sapi/v1/asset/get-funding-asset" ||
                    path === "/sapi/v1/asset/wallet/balance"
                  ? []
                  : { assets: [] };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
    });
    const { namespace, dispose } = fakeNamespace(session);
    const snapshot = await withCryptoBrowserFetcher(
      namespace,
      "binance",
      "apac",
      BINANCE_EGRESS_ORIGINS,
      (fetcher) =>
        fetchBinanceSnapshot({
          apiKey: "test-api-key",
          apiSecret: "test-api-secret",
          fetcher,
          now: () => 1_700_000_000_000,
        }),
    );
    expect(snapshot.usdtTwd).toBe(32);
    // api、fapi、dapi 與 MAX（usdttwd）在第一個請求前都已開好
    expect(pagesReadyAtFirstRequest).toBe(4);
    expect(dispose).toHaveBeenCalledTimes(1);
    const funding = evaluated.find((request) =>
      request.url.endsWith("/sapi/v1/asset/get-funding-asset"),
    );
    expect(funding).toMatchObject({
      method: "POST",
      headers: {
        "x-mbx-apikey": "test-api-key",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    expect(funding?.body).toMatch(
      /^recvWindow=10000&timestamp=1700000000000&signature=[0-9a-f]{64}$/,
    );
    for (const request of evaluated) {
      expect(JSON.stringify(request)).not.toContain("test-api-secret");
    }
  });

  it("亞太被地區封鎖時等待新瀏覽器額度後改用西歐；其他錯誤不換區域", async () => {
    const wait = vi.fn(async () => undefined);
    const run = vi.fn(async (location: string) => {
      if (location === "apac") throw new BinanceRegionBlockedError(451);
      return "weur-result";
    });
    const isBlocked = (error: unknown) =>
      error instanceof BinanceRegionBlockedError;
    expect(
      await runWithCryptoEgressFallback(run, isBlocked, {
        wait,
        log: () => undefined,
      }),
    ).toBe("weur-result");
    expect(run.mock.calls.map(([location]) => location)).toEqual([
      "apac",
      "weur",
    ]);
    expect(wait).toHaveBeenCalledWith(
      CRYPTO_EGRESS_FALLBACK_DELAY_MS,
      undefined,
    );

    const other = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      runWithCryptoEgressFallback(other, isBlocked, { wait }),
    ).rejects.toThrow("network down");
    expect(other).toHaveBeenCalledTimes(1);

    const both = vi.fn(async () => {
      throw new BinanceRegionBlockedError(451);
    });
    await expect(
      runWithCryptoEgressFallback(both, isBlocked, {
        wait,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(BinanceRegionBlockedError);
    expect(both).toHaveBeenCalledTimes(2);
  });

  it("瀏覽器啟動逾時：中止取得、晚到的 session 被關閉，之後可重新啟動", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeBrowser(() => ({ status: 200, body: "{}" }));
      let resolveLate: (browser: never) => void = () => undefined;
      const signals: AbortSignal[] = [];
      const launch = vi
        .fn()
        .mockImplementationOnce(
          (signal: AbortSignal) =>
            new Promise((resolve) => {
              signals.push(signal);
              resolveLate = resolve;
            }),
        )
        .mockImplementation(async () => fake.browser);
      const close = vi.fn(async () => undefined);
      const session = new CryptoBrowserSession({
        launch,
        close,
        launchTimeoutMs: 1_000,
      });
      const first = session.execute({
        url: "https://api.binance.com/api/v3/account",
        method: "GET",
        headers: {},
      });
      const outcome = expect(first).rejects.toThrow("啟動逾時");
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(signals[0]?.aborted).toBe(true);

      resolveLate(fake.browser as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);

      await session.execute({
        url: "https://api.binance.com/api/v3/account",
        method: "GET",
        headers: {},
      });
      expect(launch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("關閉時最多等待 5 秒，啟動尚未完成的瀏覽器連上後才關掉", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeBrowser(() => ({ status: 200, body: "{}" }));
      let resolveLaunch: (browser: never) => void = () => undefined;
      const close = vi.fn(async () => undefined);
      const session = new CryptoBrowserSession({
        launch: () =>
          new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
        close,
        launchTimeoutMs: 60_000,
      });
      const pending = session
        .execute({
          url: "https://api.binance.com/api/v3/account",
          method: "GET",
          headers: {},
        })
        .catch(() => undefined);
      const disposing = session.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      await disposing;
      expect(close).not.toHaveBeenCalled();

      resolveLaunch(fake.browser as never);
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("瀏覽器斷線後重新啟動，不沿用失效的頁面", async () => {
    const { session, launch, disconnect, pageCount } = sessionWith(() => ({
      status: 200,
      body: "{}",
    }));
    const request = {
      url: "https://api.binance.com/api/v3/account",
      method: "GET" as const,
      headers: {},
    };
    await session.execute(request);
    disconnect();
    await session.execute(request);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(pageCount()).toBe(2);
  });

  it("fetcher 關閉後不再送出請求，避免物件重新開瀏覽器", async () => {
    const { session, launch } = sessionWith(() => ({
      status: 200,
      body: "{}",
    }));
    const { namespace } = fakeNamespace(session);
    const fetcher = createCryptoBrowserFetcher(namespace, "binance", "apac");
    await fetcher.close();
    await expect(
      fetcher.fetch("https://api.binance.com/api/v3/account"),
    ).rejects.toThrow("已結束");
    expect(launch).not.toHaveBeenCalled();
  });
});
