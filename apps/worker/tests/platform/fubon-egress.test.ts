import { describe, expect, it, vi } from "vitest";
import {
  FUBON_STATIC_CACHE_HEADER,
  FUBON_STATIC_TTL_MS,
  createFubonEgressFetcher,
  createFubonStaticCache,
  isFubonEgressUrl,
  proxyFubonEgress,
} from "../../src/platform/fubon-egress";

const bankUrl =
  "https://ebank.taipeifubon.com.tw/B2C/cmfqu/cmfqu021/CMFQU021_Home.faces";

describe("台北富邦網銀代發出口", () => {
  it("只轉送網銀 host 的 GET／POST，且不跟隨轉址", async () => {
    const outbound = vi.fn(async (_request: Request) => new Response("ok"));

    const get = await proxyFubonEgress(new Request(bankUrl), outbound);
    const post = await proxyFubonEgress(
      new Request(bankUrl, { method: "POST", body: "a=1" }),
      outbound,
    );
    const otherHost = await proxyFubonEgress(
      new Request("https://ccdp.fubon.com/session.json"),
      outbound,
    );
    const lookalike = await proxyFubonEgress(
      new Request("https://ebank.taipeifubon.com.tw.example.com/B2C/"),
      outbound,
    );
    const plainHttp = await proxyFubonEgress(
      new Request("http://ebank.taipeifubon.com.tw/B2C/"),
      outbound,
    );
    const wrongMethod = await proxyFubonEgress(
      new Request(bankUrl, { method: "PUT", body: "x" }),
      outbound,
    );

    expect(get.status).toBe(200);
    expect(post.status).toBe(200);
    expect(otherHost.status).toBe(403);
    expect(lookalike.status).toBe(403);
    expect(plainHttp.status).toBe(403);
    expect(wrongMethod.status).toBe(403);
    expect(outbound).toHaveBeenCalledTimes(2);
    const forwarded = outbound.mock.calls[1]![0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.redirect).toBe("manual");
    expect(await forwarded.text()).toBe("a=1");
  });

  it("拒絕非預設埠與含帳密的網址", () => {
    expect(isFubonEgressUrl("https://ebank.taipeifubon.com.tw:8443/B2C/")).toBe(
      false,
    );
    expect(isFubonEgressUrl("https://u:p@ebank.taipeifubon.com.tw/B2C/")).toBe(
      false,
    );
    expect(isFubonEgressUrl(bankUrl)).toBe(true);
  });

  it("每次都指向同一個 apac 物件", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const getByName = vi.fn(() => ({ fetch }));
    const fetcher = createFubonEgressFetcher({
      getByName,
    } as unknown as DurableObjectNamespace);
    const request = new Request(bankUrl);

    await fetcher(request);

    expect(getByName).toHaveBeenCalledWith("fubon", { locationHint: "apac" });
    expect(fetch).toHaveBeenCalledWith(request);
  });

  describe("靜態資源快取（Durable Object 儲存）", () => {
    const scriptUrl =
      "https://ebank.taipeifubon.com.tw/B2C/inc/js/common.js?v=1";
    function fakeStorage() {
      const map = new Map<string, unknown>();
      return {
        map,
        storage: {
          get: vi.fn(async (key: string) => map.get(key)),
          put: vi.fn(async (key: string, value: unknown) => {
            map.set(key, value);
          }),
          delete: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys])
              map.delete(key);
            return true;
          }),
          list: vi.fn(async ({ prefix }: { prefix: string }) => {
            return new Map([...map].filter(([key]) => key.startsWith(prefix)));
          }),
        } as unknown as DurableObjectStorage,
      };
    }
    const script = (headers: Record<string, string> = {}) =>
      new Response("console.log(1)", {
        status: 200,
        headers: {
          "content-type": "application/javascript",
          "content-encoding": "gzip",
          ...headers,
        },
      });

    it("第二次請求同一個 .js 由儲存回應，不再向銀行請求", async () => {
      const { storage } = fakeStorage();
      const cache = createFubonStaticCache(storage);
      const outbound = vi.fn(async () => script());
      const first = await proxyFubonEgress(
        new Request(scriptUrl, { headers: { cookie: "JSESSIONID=x" } }),
        outbound,
        cache,
      );
      expect(first.headers.get(FUBON_STATIC_CACHE_HEADER)).toBe("miss");
      expect(first.headers.get("content-encoding")).toBeNull();
      expect(await first.text()).toBe("console.log(1)");
      const second = await proxyFubonEgress(
        new Request(scriptUrl),
        outbound,
        cache,
      );
      expect(second.headers.get(FUBON_STATIC_CACHE_HEADER)).toBe("hit");
      expect(await second.text()).toBe("console.log(1)");
      expect(outbound).toHaveBeenCalledTimes(1);
      // 新的物件實例（記憶體清空）仍可由儲存命中。
      const reloaded = createFubonStaticCache(storage);
      const third = await proxyFubonEgress(
        new Request(scriptUrl),
        outbound,
        reloaded,
      );
      expect(third.headers.get(FUBON_STATIC_CACHE_HEADER)).toBe("hit");
      expect(outbound).toHaveBeenCalledTimes(1);
    });

    it("不快取頁面、POST、帶 Set-Cookie、no-store／private 或非 200 的回應", async () => {
      const cases: Array<[Request, Response]> = [
        [
          new Request(bankUrl),
          new Response("<html>", { headers: { "content-type": "text/html" } }),
        ],
        [new Request(scriptUrl, { method: "POST", body: "a" }), script()],
        [new Request(scriptUrl), script({ "set-cookie": "a=b" })],
        [new Request(scriptUrl), script({ "cache-control": "no-store" })],
        [new Request(scriptUrl), script({ "cache-control": "private" })],
        [
          new Request(scriptUrl),
          new Response("", {
            status: 404,
            headers: { "content-type": "application/javascript" },
          }),
        ],
        [
          new Request(scriptUrl),
          new Response("<html>login</html>", {
            headers: { "content-type": "text/html" },
          }),
        ],
      ];
      for (const [request, response] of cases) {
        const { storage, map } = fakeStorage();
        const cache = createFubonStaticCache(storage);
        const result = await proxyFubonEgress(
          request,
          async () => response,
          cache,
        );
        expect(result.headers.get(FUBON_STATIC_CACHE_HEADER)).toBeNull();
        expect(map.size).toBe(0);
      }
    });

    it("超過保存期限後重新向銀行請求並清除過期項目", async () => {
      const { storage, map } = fakeStorage();
      let now = 1_000_000;
      const cache = createFubonStaticCache(storage, () => now);
      const outbound = vi.fn(async () => script());
      await proxyFubonEgress(new Request(scriptUrl), outbound, cache);
      now += FUBON_STATIC_TTL_MS + 1;
      const expired = await proxyFubonEgress(
        new Request(scriptUrl),
        outbound,
        cache,
      );
      expect(expired.headers.get(FUBON_STATIC_CACHE_HEADER)).toBe("miss");
      expect(outbound).toHaveBeenCalledTimes(2);
      // 另一個過期項目在下一次寫入時被清除（每小時最多一次）。
      map.set("static:https://ebank.taipeifubon.com.tw/old.js", {});
      map.set("static-meta:https://ebank.taipeifubon.com.tw/old.js", 0);
      now += 2 * 60 * 60 * 1000;
      await proxyFubonEgress(
        new Request("https://ebank.taipeifubon.com.tw/B2C/inc/js/b.js"),
        outbound,
        cache,
      );
      expect(map.has("static:https://ebank.taipeifubon.com.tw/old.js")).toBe(
        false,
      );
    });
  });
});
