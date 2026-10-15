import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import {
  buildBrowserResponseHeaders,
  buildForwardHeaders,
  classifyFubonRequest,
  clearFubonStaticCache,
  cookieHeader,
  enableFubonEgress,
  exchangeAction,
  exchangeToRecord,
  FubonExchangeLog,
  isFubonClickTracking,
  pausedRequestBody,
} from "../../../src/sources/fubon/egress";

const ORIGIN = "https://ebank.taipeifubon.com.tw";

type Listener = (event: unknown) => void;

function fakeSession(
  cookies: Array<{ name: string; value: string; path: string }>,
) {
  const listeners = new Map<string, Listener>();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const session = {
    on: (name: string, listener: Listener) => listeners.set(name, listener),
    send: vi.fn(
      async (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params });
        if (method === "Network.getCookies") return { cookies };
        return {};
      },
    ),
  };
  const page = {
    createCDPSession: async () => session,
  } as unknown as Page;
  const pause = async (event: Record<string, unknown>) => {
    listeners.get("Fetch.requestPaused")!(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { page, sent, pause };
}

function paused(
  requestId: string,
  url: string,
  resourceType: string,
  extra: Record<string, unknown> = {},
) {
  return {
    requestId,
    resourceType,
    request: { url, method: "GET", headers: {}, ...extra },
  };
}

afterEach(() => clearFubonStaticCache());

describe("台北富邦網銀請求攔截", () => {
  it("只代發網銀的文件、腳本、樣式、XHR 與驗證碼圖片", () => {
    expect(
      classifyFubonRequest(`${ORIGIN}/B2C/x.faces`, "Document", "GET"),
    ).toBe("proxy");
    expect(
      classifyFubonRequest(`${ORIGIN}/B2C/inc/js/a.js`, "Script", "GET"),
    ).toBe("proxy");
    expect(
      classifyFubonRequest(`${ORIGIN}/B2C/B2CLoginServlet`, "XHR", "POST"),
    ).toBe("proxy");
    expect(
      classifyFubonRequest(
        `${ORIGIN}/B2C/captchaImage?timestamp=1`,
        "Image",
        "GET",
      ),
    ).toBe("proxy");
    expect(
      classifyFubonRequest(`${ORIGIN}/B2C/inc/img/a.png`, "Image", "GET"),
    ).toBe("abort");
    expect(classifyFubonRequest(`${ORIGIN}/B2C/font.woff`, "Font", "GET")).toBe(
      "abort",
    );
    expect(
      classifyFubonRequest("https://ccdp.fubon.com/session.json", "XHR", "GET"),
    ).toBe("abort");
    expect(classifyFubonRequest(`${ORIGIN}/B2C/x`, "XHR", "PUT")).toBe("abort");
    expect(
      classifyFubonRequest(
        "http://ebank.taipeifubon.com.tw/B2C/",
        "Document",
        "GET",
      ),
    ).toBe("abort");
  });

  it("轉送標頭時以瀏覽器 cookie 取代原本的 Cookie，移除逐跳標頭", () => {
    const headers = buildForwardHeaders(
      {
        Cookie: "stale=1",
        Host: "x",
        "Accept-Encoding": "gzip",
        Referer: `${ORIGIN}/B2C/`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      "a=1; b=2",
    );
    expect(headers.get("cookie")).toBe("a=1; b=2");
    expect(headers.get("host")).toBeNull();
    expect(headers.get("accept-encoding")).toBeNull();
    expect(headers.get("referer")).toBe(`${ORIGIN}/B2C/`);
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(
      cookieHeader([
        { name: "root", value: "1", path: "/" },
        { name: "deep", value: "2", path: "/B2C" },
      ]),
    ).toBe("deep=2; root=1");
  });

  it("回應保留多筆 Set-Cookie 並移除已解壓縮的編碼標頭", () => {
    const response = new Response("x", { status: 302 });
    response.headers.append("set-cookie", "A=1; Path=/; HttpOnly");
    response.headers.append("set-cookie", "B=2; Path=/");
    response.headers.set("location", "/B2C/next.faces");
    response.headers.set("content-encoding", "gzip");
    response.headers.set("content-length", "99");
    const headers = buildBrowserResponseHeaders(response);
    expect(
      headers.filter((h) => h.name === "set-cookie").map((h) => h.value),
    ).toEqual(["A=1; Path=/; HttpOnly", "B=2; Path=/"]);
    expect(headers.find((h) => h.name === "location")?.value).toBe(
      "/B2C/next.faces",
    );
    expect(
      headers.some(
        (h) => h.name === "content-encoding" || h.name === "content-length",
      ),
    ).toBe(false);
  });

  it("POST 內容優先使用 postDataEntries", () => {
    const body = pausedRequestBody({
      url: ORIGIN,
      method: "POST",
      headers: {},
      postData: "ignored",
      postDataEntries: [{ bytes: btoa("a=1&") }, { bytes: btoa("b=2") }],
    });
    expect(Buffer.from(body as Buffer).toString()).toBe("a=1&b=2");
  });

  it("代發網銀請求並回填狀態、標頭與內容；第三方請求直接中止", async () => {
    const { page, sent, pause } = fakeSession([
      { name: "JSESSIONID", value: "s", path: "/" },
    ]);
    const egress = vi.fn(async (_request: Request) => {
      const response = new Response("<html></html>", {
        status: 302,
        headers: { location: "/B2C/next.faces", "content-type": "text/html" },
      });
      response.headers.append("set-cookie", "A=1; Path=/");
      response.headers.append("set-cookie", "B=2; Path=/");
      return response;
    });
    const stats = await enableFubonEgress(page, egress);
    expect(sent[0]).toEqual({
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
    });

    await pause(
      paused("r1", `${ORIGIN}/B2C/B2CLoginServlet`, "XHR", {
        method: "POST",
        postData: "action=checkLogin",
        headers: { Cookie: "stale=1" },
      }),
    );
    await pause(
      paused(
        "r2",
        "https://ccdp.fubon.com/2364/js/events/v10/session.json",
        "XHR",
      ),
    );

    expect(egress).toHaveBeenCalledTimes(1);
    const forwarded = egress.mock.calls[0]![0];
    expect(forwarded.method).toBe("POST");
    expect(forwarded.redirect).toBe("manual");
    expect(forwarded.headers.get("cookie")).toBe("JSESSIONID=s");
    expect(await forwarded.text()).toBe("action=checkLogin");
    const fulfill = sent.find(
      (call) => call.method === "Fetch.fulfillRequest",
    )!.params;
    expect(fulfill.requestId).toBe("r1");
    expect(fulfill.responseCode).toBe(302);
    expect(Buffer.from(fulfill.body as string, "base64").toString()).toBe(
      "<html></html>",
    );
    expect(
      (fulfill.responseHeaders as Array<{ name: string }>).filter(
        (h) => h.name === "set-cookie",
      ),
    ).toHaveLength(2);
    expect(
      sent.find((call) => call.method === "Fetch.failRequest")!.params,
    ).toEqual({ requestId: "r2", errorReason: "BlockedByClient" });
    expect(stats).toMatchObject({ proxied: 1, aborted: 1, failed: 0 });
  });

  it("重複的靜態腳本由記憶體回應，不再代發", async () => {
    const { page, pause } = fakeSession([]);
    const egress = vi.fn(
      async () =>
        new Response("var a=1;", {
          headers: { "content-type": "application/javascript" },
        }),
    );
    const stats = await enableFubonEgress(page, egress);
    await pause(paused("s1", `${ORIGIN}/B2C/inc/js/b2c.js`, "Script"));
    await pause(paused("s2", `${ORIGIN}/B2C/inc/js/b2c.js`, "Script"));
    expect(egress).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ proxied: 1, cached: 1 });
  });

  it("代發失敗時讓瀏覽器收到連線失敗", async () => {
    const { page, sent, pause } = fakeSession([]);
    const stats = await enableFubonEgress(page, async () => {
      throw new Error("network");
    });
    await pause(paused("f1", `${ORIGIN}/B2C/x.faces`, "Document"));
    expect(
      sent.find((call) => call.method === "Fetch.failRequest")!.params,
    ).toEqual({ requestId: "f1", errorReason: "ConnectionFailed" });
    expect(stats.failed).toBe(1);
  });

  it("在回填瀏覽器之前保留登入 servlet 的 JSON 回應（以 action 區分）", async () => {
    const { page, sent, pause } = fakeSession([]);
    const exchanges = new FubonExchangeLog();
    // 合成的去識別化回應，與真實登入成功回應的欄位形狀相同。
    const loginBody = {
      result: true,
      errorCode: "",
      errorDesc: "",
      signonToken: "synthetic-token",
    };
    let recordedBeforeFulfill = false;
    const egress = vi.fn(
      async () =>
        new Response(JSON.stringify(loginBody), {
          headers: { "content-type": "application/json" },
        }),
    );
    const since = exchanges.mark();
    const waiting = exchanges.waitFor(
      (entry) => entry.action === "login",
      since,
      1_000,
    );
    const record = exchanges.record.bind(exchanges);
    vi.spyOn(exchanges, "record").mockImplementation((entry) => {
      recordedBeforeFulfill = !sent.some(
        (call) => call.method === "Fetch.fulfillRequest",
      );
      record(entry);
    });
    await enableFubonEgress(page, egress, undefined, exchanges);
    await pause(
      paused("l1", `${ORIGIN}/B2C/B2CLoginServlet`, "XHR", {
        method: "POST",
        postData: "loginType=m1&action=login&confirm=false",
      }),
    );
    const exchange = await waiting;
    expect(exchange).toMatchObject({
      path: "/B2C/B2CLoginServlet",
      action: "login",
      status: 200,
      json: loginBody,
    });
    expect(recordedBeforeFulfill).toBe(true);
  });

  it("只保留登入 servlet 與官方登出的交換紀錄", () => {
    const json = Buffer.from('{"result":false,"errorCode":"0290"}');
    expect(exchangeAction("action=checkLogin&menuId=CMF06")).toBe("checkLogin");
    expect(exchangeAction("ajaxAction=doLogoutAction")).toBe("doLogoutAction");
    expect(exchangeAction(undefined)).toBeUndefined();
    expect(
      exchangeToRecord(
        `${ORIGIN}/B2C/B2CLoginServlet`,
        "POST",
        "action=login",
        200,
        json,
      ),
    ).toMatchObject({ action: "login", json: { errorCode: "0290" } });
    expect(
      exchangeToRecord(
        `${ORIGIN}/B2C/B2CLoginServlet`,
        "POST",
        "action=login",
        500,
        Buffer.from("<html>"),
      ),
    ).toEqual({
      path: "/B2C/B2CLoginServlet",
      action: "login",
      status: 500,
      json: undefined,
    });
    expect(
      exchangeToRecord(
        `${ORIGIN}/B2C/common/ContextFrame.faces`,
        "POST",
        "ajaxAction=doLogoutAction&javax.faces.ViewState=x",
        200,
        Buffer.from(""),
      ),
    ).toEqual({
      path: "/B2C/common/ContextFrame.faces",
      action: "doLogoutAction",
      status: 200,
    });
    expect(
      exchangeToRecord(
        `${ORIGIN}/B2C/common/ContextFrame.faces`,
        "POST",
        "ajaxAction=doAjaxGetPMCount",
        200,
        Buffer.from("{}"),
      ),
    ).toBeUndefined();
    expect(
      exchangeToRecord(
        `${ORIGIN}/B2C/B2CLoginServlet`,
        "GET",
        undefined,
        200,
        json,
      ),
    ).toBeUndefined();
  });

  it("等待交換紀錄時忽略標記之前的舊回應並在逾時後回傳 undefined", async () => {
    const log = new FubonExchangeLog();
    log.record({ path: "/B2C/B2CLoginServlet", action: "login", status: 200 });
    const since = log.mark();
    expect(
      await log.waitFor((entry) => entry.action === "login", since, 10),
    ).toBeUndefined();
    const pending = log.waitFor(
      (entry) => entry.action === "login",
      since,
      500,
    );
    log.record({ path: "/B2C/B2CLoginServlet", action: "login", status: 200 });
    expect(await pending).toMatchObject({ seq: 2 });
  });
});

describe("台北富邦點擊追蹤", () => {
  it("只把網銀的 POST /B2C/click 視為點擊追蹤", () => {
    expect(isFubonClickTracking(`${ORIGIN}/B2C/click`, "POST")).toBe(true);
    expect(isFubonClickTracking(`${ORIGIN}/B2C/click`, "GET")).toBe(false);
    expect(isFubonClickTracking(`${ORIGIN}/B2C/dispatcher`, "POST")).toBe(
      false,
    );
    expect(isFubonClickTracking("https://example.com/B2C/click", "POST")).toBe(
      false,
    );
  });
});
