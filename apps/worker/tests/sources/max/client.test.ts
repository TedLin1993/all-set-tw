import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fetchMaxSnapshot,
  signMaxRequest,
} from "../../../src/sources/max/client";
import {
  MaxAccessBlockedError,
  MaxApiError,
  MaxCredentialError,
} from "../../../src/sources/max/protocol";
import { safeErrorMessage } from "../../../src/features/sync/errors";

const ACCESS_KEY = "test-access-key";
const SECRET_KEY = "test-secret-key";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(handler: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetcher, calls };
}

const markets = [
  { id: "btctwd", status: "active", base_unit: "btc", quote_unit: "twd" },
  { id: "usdttwd", status: "active", base_unit: "usdt", quote_unit: "twd" },
  { id: "ethtwd", status: "active", base_unit: "eth", quote_unit: "twd" },
];

function healthy(mWallet: () => Response) {
  return (url: URL) => {
    switch (url.pathname) {
      case "/api/v3/wallet/spot/accounts":
        return json([
          { currency: "btc", balance: "0.01", locked: "0", staked: null },
        ]);
      case "/api/v3/wallet/m/accounts":
        return mWallet();
      case "/api/v3/markets":
        return json(markets);
      case "/api/v3/tickers":
        return json([
          { market: "btctwd", last: "2000000" },
          { market: "usdttwd", last: "32.5" },
        ]);
      default:
        return json({ success: false, error: { code: 1, message: "x" } }, 404);
    }
  };
}

describe("MAX 簽章與 HTTP client", () => {
  it("payload 為含 nonce 與 path 的 JSON Base64，簽章為 HMAC-SHA256 hex", async () => {
    const path = "/api/v3/wallet/spot/accounts";
    const { payload, signature } = await signMaxRequest(SECRET_KEY, path, {
      nonce: 1_700_000_000_000,
    });
    const expectedPayload = Buffer.from(
      '{"nonce":1700000000000,"path":"/api/v3/wallet/spot/accounts"}',
    ).toString("base64");
    expect(payload).toBe(expectedPayload);
    expect(signature).toBe(
      createHmac("sha256", SECRET_KEY).update(expectedPayload).digest("hex"),
    );
  });

  it("私有請求的 nonce 不重複，只查詢存在的市場，secret 不外送", async () => {
    const { fetcher, calls } = fakeFetch(healthy(() => json([])));
    const snapshot = await fetchMaxSnapshot({
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      fetcher,
      now: () => 1_700_000_000_000,
    });
    expect(snapshot.m).toEqual([]);
    const privateCalls = calls.filter(({ url }) =>
      url.pathname.startsWith("/api/v3/wallet/"),
    );
    const nonces = privateCalls.map(({ url, init }) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["X-MAX-ACCESSKEY"]).toBe(ACCESS_KEY);
      const payload = JSON.parse(atob(headers["X-MAX-PAYLOAD"] ?? ""));
      expect(payload.path).toBe(url.pathname);
      expect(String(payload.nonce)).toBe(url.searchParams.get("nonce"));
      return payload.nonce;
    });
    expect(new Set(nonces).size).toBe(nonces.length);
    for (const { url, init } of calls) {
      expect(url.toString()).not.toContain(SECRET_KEY);
      expect(JSON.stringify(init.headers ?? {})).not.toContain(SECRET_KEY);
    }
    const tickers = calls.find(({ url }) => url.pathname === "/api/v3/tickers");
    expect(tickers?.url.searchParams.getAll("markets[]")).toEqual([
      "btctwd",
      "usdttwd",
    ]);
  });

  it("現貨 401 視為金鑰錯誤；M 錢包 4xx 視為未開通", async () => {
    const unauthorized = fakeFetch(() =>
      json(
        {
          success: false,
          error: { code: 2008, message: "The access key does not exist." },
        },
        401,
      ),
    );
    await expect(
      fetchMaxSnapshot({
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        fetcher: unauthorized.fetcher,
      }),
    ).rejects.toBeInstanceOf(MaxCredentialError);

    const noMWallet = fakeFetch(
      healthy(() =>
        json({ success: false, error: { code: 2006, message: "x" } }, 400),
      ),
    );
    const snapshot = await fetchMaxSnapshot({
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      fetcher: noMWallet.fetcher,
    });
    expect(snapshot.m).toBeUndefined();
    expect(snapshot.spot).toHaveLength(1);
  });

  it("M 錢包遇到 429 限流或 5xx 時同步失敗，避免漏扣借款", async () => {
    for (const status of [429, 503]) {
      const { fetcher } = fakeFetch(
        healthy(() =>
          json({ success: false, error: { code: 1, message: "x" } }, status),
        ),
      );
      await expect(
        fetchMaxSnapshot({
          accessKey: ACCESS_KEY,
          secretKey: SECRET_KEY,
          fetcher,
        }),
      ).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it("現貨或 M 錢包回應格式異常時同步失敗，不當成沒有持倉", async () => {
    const maintenance = () => json({ success: false });
    const malformedSpot = fakeFetch((url) =>
      url.pathname === "/api/v3/wallet/spot/accounts"
        ? maintenance()
        : healthy(() => json([]))(url),
    );
    await expect(
      fetchMaxSnapshot({
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        fetcher: malformedSpot.fetcher,
      }),
    ).rejects.toThrow("現貨帳戶回應格式異常");
    // M 錢包未開通時是 undefined，HTML 維護頁與空回應不可混成未開通而漏扣借款
    for (const [response, message] of [
      [maintenance, "M 錢包回應格式異常"],
      [
        () => new Response("<html>maintenance</html>", { status: 200 }),
        "m/accounts 回應格式異常",
      ],
      [() => new Response("", { status: 200 }), "m/accounts 回應格式異常"],
    ] as const) {
      const malformedM = fakeFetch(healthy(response));
      await expect(
        fetchMaxSnapshot({
          accessKey: ACCESS_KEY,
          secretKey: SECRET_KEY,
          fetcher: malformedM.fetcher,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("沒有 MAX 錯誤碼的 403 視為防火牆阻擋並附上節點；有錯誤碼的仍是 API 錯誤", async () => {
    const blocked = fakeFetch(
      () =>
        new Response("<html>Sorry, you have been blocked</html>", {
          status: 403,
          headers: { "cf-ray": "a4edaaa4cf584a8d-IAD" },
        }),
    );
    const error = await fetchMaxSnapshot({
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      fetcher: blocked.fetcher,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MaxAccessBlockedError);
    expect(safeErrorMessage(error)).toContain("HTTP 403，回應節點 IAD");

    const apiError = fakeFetch(() =>
      json({ success: false, error: { code: 2006, message: "x" } }, 403),
    );
    const coded = await fetchMaxSnapshot({
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      fetcher: apiError.fetcher,
    }).catch((caught: unknown) => caught);
    expect(coded).toBeInstanceOf(MaxApiError);
    // 完整路徑會被 token 脫敏規則遮蔽，錯誤訊息只用最後兩段。
    expect(safeErrorMessage(coded)).toContain(
      "spot/accounts，HTTP 403，代碼 2006",
    );
  });

  it("取不到有效的 usdttwd 時同步失敗，不以未估值的列覆蓋當天快照", async () => {
    for (const tickers of [
      [{ market: "btctwd", last: "2000000" }],
      [
        { market: "btctwd", last: "2000000" },
        { market: "usdttwd", last: "0" },
      ],
    ]) {
      const { fetcher } = fakeFetch((url) =>
        url.pathname === "/api/v3/tickers"
          ? json(tickers)
          : healthy(() => json([]))(url),
      );
      await expect(
        fetchMaxSnapshot({
          accessKey: ACCESS_KEY,
          secretKey: SECRET_KEY,
          fetcher,
        }),
      ).rejects.toThrow("usdttwd");
    }
    const malformed = fakeFetch((url) =>
      url.pathname === "/api/v3/markets"
        ? json({ error: "maintenance" })
        : healthy(() => json([]))(url),
    );
    await expect(
      fetchMaxSnapshot({
        accessKey: ACCESS_KEY,
        secretKey: SECRET_KEY,
        fetcher: malformed.fetcher,
      }),
    ).rejects.toThrow("市場清單");
  });
});
