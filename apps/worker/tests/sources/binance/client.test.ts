import { describe, expect, it } from "vitest";
import {
  fetchBinanceSnapshot,
  signBinanceParams,
} from "../../../src/sources/binance/client";
import {
  BinanceCredentialError,
  BinanceRegionBlockedError,
} from "../../../src/sources/binance/protocol";
import { hmacSha256Hex } from "../../../src/sources/crypto-holdings";
import { safeErrorMessage } from "../../../src/features/sync/errors";

// Binance 官方文件「SIGNED Endpoint Examples」的 HMAC 範例。
const OFFICIAL_SECRET =
  "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
const OFFICIAL_PAYLOAD =
  "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
const OFFICIAL_SIGNATURE =
  "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71";

const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";

type Route = (url: URL, init: RequestInit) => Response | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    for (const route of routes) {
      const response = route(url, init ?? {});
      if (response) return response;
    }
    return json({ code: -1, msg: "not mocked" }, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

const path =
  (pathname: string, response: () => Response): Route =>
  (url) =>
    url.pathname === pathname ? response() : undefined;

const healthyRoutes: Route[] = [
  (url) =>
    url.pathname === "/sapi/v1/asset/wallet/balance" &&
    url.searchParams.get("quoteAsset") === "USDT"
      ? json([{ activate: true, balance: "12.5", walletName: "Trading Bots" }])
      : undefined,
  path("/api/v3/account", () =>
    json({ balances: [{ asset: "BTC", free: "0.1", locked: "0" }] }),
  ),
  path("/sapi/v1/asset/get-funding-asset", () => json([])),
  path("/sapi/v1/simple-earn/flexible/position", () =>
    json({ rows: [], total: 0 }),
  ),
  path("/sapi/v1/simple-earn/locked/position", () =>
    json({ rows: [], total: 0 }),
  ),
  path("/fapi/v2/account", () => json({ assets: [] })),
  path("/dapi/v1/account", () => json({ assets: [] })),
  path("/api/v3/ticker/price", () =>
    json([{ symbol: "BTCUSDT", price: "60000" }]),
  ),
  path("/api/v3/ticker", () => json({ market: "usdttwd", last: "32.5" })),
];

describe("Binance 簽章與 HTTP client", () => {
  it("HMAC-SHA256 符合官方範例向量", async () => {
    expect(await hmacSha256Hex(OFFICIAL_SECRET, OFFICIAL_PAYLOAD)).toBe(
      OFFICIAL_SIGNATURE,
    );
    expect(
      await signBinanceParams(OFFICIAL_SECRET, {
        symbol: "LTCBTC",
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: "1",
        price: "0.1",
        recvWindow: "5000",
        timestamp: "1499827319559",
      }),
    ).toBe(`${OFFICIAL_PAYLOAD}&signature=${OFFICIAL_SIGNATURE}`);
  });

  it("簽章請求帶 API key header，secret 不出現在網址或 body", async () => {
    const { fetcher, calls } = fakeFetch(healthyRoutes);
    const snapshot = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
      now: () => 1_700_000_000_000,
    });
    expect(snapshot.usdtTwd).toBe(32.5);
    const signed = calls.filter(
      ({ url }) =>
        url.hostname.endsWith("binance.com") &&
        url.pathname !== "/api/v3/ticker/price",
    );
    expect(signed).toHaveLength(7);
    expect(snapshot.wallets).toEqual([
      { activate: true, balance: "12.5", walletName: "Trading Bots" },
    ]);
    for (const { url, init } of signed) {
      const query = init.method === "POST" ? String(init.body) : url.search;
      expect(query).toContain("timestamp=1700000000000");
      expect(query).toMatch(/signature=[0-9a-f]{64}/);
      expect((init.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(
        API_KEY,
      );
      expect(url.toString()).not.toContain(API_SECRET);
      expect(String(init.body ?? "")).not.toContain(API_SECRET);
    }
  });

  it("現貨帳戶 -2015 視為金鑰錯誤", async () => {
    const { fetcher } = fakeFetch([
      path("/api/v3/account", () =>
        json(
          {
            code: -2015,
            msg: "Invalid API-key, IP, or permissions for action.",
          },
          401,
        ),
      ),
    ]);
    await expect(
      fetchBinanceSnapshot({ apiKey: API_KEY, apiSecret: API_SECRET, fetcher }),
    ).rejects.toBeInstanceOf(BinanceCredentialError);
  });

  it("HTTP 451 與無錯誤碼的 403 視為地區封鎖", async () => {
    for (const response of [
      () => new Response("Unavailable For Legal Reasons", { status: 451 }),
      () => new Response("<html>Forbidden</html>", { status: 403 }),
    ]) {
      const { fetcher } = fakeFetch([path("/api/v3/account", response)]);
      await expect(
        fetchBinanceSnapshot({
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          fetcher,
        }),
      ).rejects.toBeInstanceOf(BinanceRegionBlockedError);
    }
  });

  it("合約與理財無權限時當成未開通，不讓同步失敗；5xx 仍失敗", async () => {
    const forbidden = () =>
      json(
        { code: -2015, msg: "Invalid API-key, IP, or permissions for action." },
        401,
      );
    const { fetcher } = fakeFetch([
      path("/fapi/v2/account", forbidden),
      path("/dapi/v1/account", () => json({ code: -1, msg: "x" }, 400)),
      path("/sapi/v1/simple-earn/locked/position", forbidden),
      ...healthyRoutes,
    ]);
    const snapshot = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
    });
    expect(snapshot.usdm).toBeUndefined();
    expect(snapshot.coinm).toBeUndefined();
    expect(snapshot.locked).toBeUndefined();
    expect(snapshot.flexible).toEqual([]);

    const failing = fakeFetch([
      path("/sapi/v1/asset/get-funding-asset", () =>
        json({ code: -1001, msg: "Internal error" }, 503),
      ),
      ...healthyRoutes,
    ]);
    await expect(
      fetchBinanceSnapshot({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        fetcher: failing.fetcher,
      }),
    ).rejects.toThrow("HTTP 503");
  });

  it("理財分頁取完 total 為止", async () => {
    const pageRows = (count: number) =>
      Array.from({ length: count }, () => ({
        asset: "USDT",
        totalAmount: "1",
      }));
    const { fetcher, calls } = fakeFetch([
      (url) =>
        url.pathname === "/sapi/v1/simple-earn/flexible/position"
          ? json({
              rows: pageRows(
                url.searchParams.get("current") === "1" ? 100 : 20,
              ),
              total: 120,
            })
          : undefined,
      ...healthyRoutes,
    ]);
    const snapshot = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
    });
    expect(snapshot.flexible).toHaveLength(120);
    expect(
      calls.filter(
        ({ url }) => url.pathname === "/sapi/v1/simple-earn/flexible/position",
      ),
    ).toHaveLength(2);
  });

  it("取不到 MAX usdttwd 時整次同步失敗，不以 0 覆蓋當天快照", async () => {
    for (const ticker of [
      () => json({ success: false }, 502),
      () => json({ market: "usdttwd", last: "0" }),
    ]) {
      const { fetcher } = fakeFetch([
        path("/api/v3/ticker", ticker),
        ...healthyRoutes,
      ]);
      await expect(
        fetchBinanceSnapshot({
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          fetcher,
        }),
      ).rejects.toThrow(/MAX/);
    }
  });

  it("選用錢包遇到 429 限流、418 IP 封鎖或暫時性錯誤碼時同步失敗，不當成未開通", async () => {
    for (const response of [
      () => json({ code: -1003, msg: "Too much request weight used" }, 429),
      () => json({ code: -1003, msg: "IP banned" }, 418),
      () => json({ code: -1021, msg: "Timestamp outside recvWindow" }, 400),
    ]) {
      const { fetcher } = fakeFetch([
        path("/sapi/v1/simple-earn/flexible/position", response),
        ...healthyRoutes,
      ]);
      await expect(
        fetchBinanceSnapshot({
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          fetcher,
        }),
      ).rejects.toThrow();
    }
  });

  it("理財持倉超過分頁上限時失敗，不默默截斷", async () => {
    const { fetcher } = fakeFetch([
      path("/sapi/v1/simple-earn/flexible/position", () =>
        json({
          rows: Array.from({ length: 100 }, () => ({
            asset: "USDT",
            totalAmount: "1",
          })),
          total: 5000,
        }),
      ),
      ...healthyRoutes,
    ]);
    await expect(
      fetchBinanceSnapshot({ apiKey: API_KEY, apiSecret: API_SECRET, fetcher }),
    ).rejects.toThrow("超過 20 頁");
  });

  it("地區封鎖訊息附上對方回應節點，脫敏後仍可讀", async () => {
    const { fetcher } = fakeFetch([
      path(
        "/api/v3/account",
        () =>
          new Response("{}", {
            status: 451,
            headers: { "x-amz-cf-pop": "IAD89-P1" },
          }),
      ),
    ]);
    const error = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BinanceRegionBlockedError);
    expect(safeErrorMessage(error)).toContain("HTTP 451，回應節點 IAD");
  });

  it("成功狀態但回應格式異常的錢包讓同步失敗，不當成空錢包", async () => {
    for (const route of [
      path(
        "/sapi/v1/simple-earn/flexible/position",
        () => new Response("<html>maintenance</html>", { status: 200 }),
      ),
      path("/sapi/v1/simple-earn/locked/position", () => json({ total: 3 })),
      path("/api/v3/account", () => json({})),
      path("/sapi/v1/asset/get-funding-asset", () => json({})),
      path("/fapi/v2/account", () => new Response("", { status: 200 })),
      (url: URL) =>
        url.pathname === "/sapi/v1/asset/wallet/balance"
          ? json({ success: false })
          : undefined,
    ]) {
      const { fetcher } = fakeFetch([route, ...healthyRoutes]);
      await expect(
        fetchBinanceSnapshot({
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          fetcher,
        }),
      ).rejects.toThrow("回應格式異常");
    }

    // 訊息只保留最後兩段路徑，脫敏後仍看得出是哪個端點
    const { fetcher } = fakeFetch([
      path(
        "/sapi/v1/simple-earn/flexible/position",
        () => new Response("<html>maintenance</html>", { status: 200 }),
      ),
      ...healthyRoutes,
    ]);
    const error = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
    }).catch((caught: unknown) => caught);
    expect(safeErrorMessage(error)).toContain(
      "Binance flexible/position 回應格式異常",
    );

    // 空的理財帳戶省略 rows、total 為 0 時視為沒有部位，不讓同步失敗
    const empty = fakeFetch([
      path("/sapi/v1/simple-earn/locked/position", () => json({ total: 0 })),
      ...healthyRoutes,
    ]);
    const snapshot = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher: empty.fetcher,
    });
    expect(snapshot.locked).toEqual([]);
  });

  it("報價回應格式異常時同步失敗；理財缺少 total 時依本頁筆數繼續翻頁", async () => {
    const broken = fakeFetch([
      path("/api/v3/ticker/price", () => json({ code: 0 })),
      ...healthyRoutes,
    ]);
    await expect(
      fetchBinanceSnapshot({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        fetcher: broken.fetcher,
      }),
    ).rejects.toThrow("格式異常");

    const { fetcher, calls } = fakeFetch([
      (url) =>
        url.pathname === "/sapi/v1/simple-earn/flexible/position"
          ? json({
              rows: Array.from(
                { length: url.searchParams.get("current") === "1" ? 100 : 3 },
                () => ({ asset: "USDT", totalAmount: "1" }),
              ),
            })
          : undefined,
      ...healthyRoutes,
    ]);
    const snapshot = await fetchBinanceSnapshot({
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      fetcher,
    });
    expect(snapshot.flexible).toHaveLength(103);
    expect(
      calls.filter(
        ({ url }) => url.pathname === "/sapi/v1/simple-earn/flexible/position",
      ),
    ).toHaveLength(2);
  });
});
