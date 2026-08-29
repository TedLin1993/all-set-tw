import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  createFirstbankConnector,
  FirstbankCaptchaRejectedError,
  FirstbankConnectionError,
  FirstbankCredentialRejectedError,
  FirstbankVerificationRequiredError,
  prepareFirstbankCaptcha,
} from "../../src/connectors/firstbank";

const LOGIN_URL = "https://ibank.firstbank.com.tw/NetBank/index103.html";
const LOGIN_LANDING_URL = "https://ibank.firstbank.com.tw/NetBank/login.html";
const FRAME_URL = "https://ibank.firstbank.com.tw/NetBank/frame.html";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

const depositTables = `
  <table>
    <tr class="ResultHeader"><td>帳號</td><td>幣別</td><td>餘額</td></tr>
    <tr class="ResultContent"><td>123456789012</td><td>新台幣</td><td>100,000</td></tr>
  </table>
`;

const transactionTables = `
  <table>
    <tr class="ResultHeader"><td>交易日期</td><td>支出</td><td>摘要</td></tr>
    <tr class="ResultContent"><td>2026/08/20</td><td>100</td><td>測試交易</td></tr>
  </table>
`;

const TRANSACTION_RESULT_URL =
  "https://ibank.firstbank.com.tw/NetBank/2/010103.html";
const TRANSACTION_QUERY_URL =
  "https://ibank.firstbank.com.tw/NetBank/2/0101.html";

function base64Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type Listener = (...args: unknown[]) => void;

function makeFrame(options?: { authenticated?: boolean }) {
  let currentUrl = options?.authenticated ? FRAME_URL : LOGIN_URL;
  return {
    detached: false,
    setUrl(url: string) {
      currentUrl = url;
    },
    name: vi.fn().mockReturnValue("main"),
    url: vi.fn().mockImplementation(() => currentUrl),
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
    }),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (source.includes("fetch(resourcePath")) {
        return { ok: true, status: 200, text: depositTables };
      }
      if (source.includes("searchBtn") && source.includes(".click()")) {
        currentUrl = TRANSACTION_RESULT_URL;
        return true;
      }
      if (source.includes('querySelectorAll("table")')) {
        return currentUrl.includes("010103")
          ? transactionTables
          : depositTables;
      }
      if (source.includes('querySelectorAll("select")')) return true;
      if (source.includes("searchBtn")) return true;
      if (source.includes("帳面餘額") || source.includes("可用餘額"))
        return true;
      if (source.includes("交易日期")) return true;
      if (source.includes("targetLabel")) return false;
      return undefined;
    }),
    content: vi.fn().mockResolvedValue(depositTables),
  };
}

function makePage(options?: {
  authenticated?: boolean;
  afterLogin?: "frame" | "interstitial";
}) {
  const afterLogin = options?.afterLogin ?? "frame";
  let currentUrl = options?.authenticated ? FRAME_URL : LOGIN_URL;
  let authenticated = Boolean(options?.authenticated);
  let interstitialVisible = false;
  const listeners = new Map<string, Set<Listener>>();
  const cdpListeners = new Map<string, Set<Listener>>();
  const cdpBodies = new Map<string, { body: string; base64Encoded: boolean }>();
  const cdpSession = {
    detach: vi.fn().mockResolvedValue(undefined),
    off: vi.fn().mockImplementation((event: string, listener: Listener) => {
      cdpListeners.get(event)?.delete(listener);
    }),
    on: vi.fn().mockImplementation((event: string, listener: Listener) => {
      const eventListeners = cdpListeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      cdpListeners.set(event, eventListeners);
    }),
    send: vi
      .fn()
      .mockImplementation(
        async (method: string, params?: { requestId?: string }) => {
          if (method === "Network.getResponseBody" && params?.requestId) {
            const body = cdpBodies.get(params.requestId);
            if (!body)
              throw new Error("No resource with given identifier found");
            return body;
          }
          return {};
        },
      ),
  };
  const frame = makeFrame(options);
  const originalFrameEvaluate = frame.evaluate;
  frame.evaluate = vi
    .fn()
    .mockImplementation(async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (source.includes("#btnOpen") || source.includes("#tFunc")) {
        return authenticated;
      }
      return originalFrameEvaluate(fn, arg);
    });
  const page = {
    frame,
    $: vi.fn().mockImplementation(async (selector: string) => {
      if (selector.includes("code_verify1.jpg")) {
        return {
          screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        };
      }
      if (authenticated && ["#btnOpen", "#tFunc"].includes(selector)) {
        return {};
      }
      return null;
    }),
    cookies: vi.fn().mockResolvedValue([
      {
        name: "SESSION",
        value: "fresh",
        domain: "ibank.firstbank.com.tw",
      },
    ]),
    createCDPSession: vi.fn().mockResolvedValue(cdpSession),
    evaluate: vi.fn().mockImplementation(async (fn: unknown) => {
      const source = String(fn);
      if (source.includes("image.naturalWidth")) return { x: 140, y: 360 };
      if (source.includes("#btnOpen, #tFunc")) return authenticated;
      if (source.includes("innerText")) return "";
      return undefined;
    }),
    frames: vi.fn().mockImplementation(() => (authenticated ? [frame] : [])),
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      if (options?.authenticated) {
        authenticated = true;
        currentUrl = FRAME_URL;
        frame.setUrl(FRAME_URL);
      }
    }),
    off: vi.fn().mockImplementation((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
    }),
    on: vi.fn().mockImplementation((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    }),
    setCookie: vi.fn().mockResolvedValue(undefined),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    mouse: {
      click: vi.fn().mockImplementation(async () => {
        authenticated = true;
        currentUrl = FRAME_URL;
        frame.setUrl(FRAME_URL);
      }),
    },
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => currentUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    emitResponse(url: string, payload: unknown) {
      const response = {
        url: () => url,
        json: vi.fn().mockResolvedValue(payload),
        text: vi
          .fn()
          .mockResolvedValue(
            typeof payload === "string" ? payload : JSON.stringify(payload),
          ),
      };
      for (const listener of listeners.get("response") ?? [])
        listener(response);
      return response;
    },
    emitTransactionDocument(url: string, body: string, base64Encoded = false) {
      const requestId = "transaction-document";
      cdpBodies.set(requestId, { body, base64Encoded });
      for (const listener of cdpListeners.get("Network.responseReceived") ?? [])
        listener({ requestId, type: "Document", response: { url } });
      for (const listener of cdpListeners.get("Network.loadingFinished") ?? [])
        listener({ requestId });
    },
    cdpSession,
  };
  return page;
}

function makeBrowser(page: ReturnType<typeof makePage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([page]),
    newPage: vi.fn().mockResolvedValue(page),
    sessionId: vi.fn().mockReturnValue("firstbank-session"),
  };
}

function postedTransactionQuery(frame: ReturnType<typeof makeFrame>) {
  return frame.evaluate.mock.calls.some(
    ([fn]) =>
      String(fn).includes("payload.action") && String(fn).includes("fetch("),
  );
}

function clickedTransactionSearch(frame: ReturnType<typeof makeFrame>) {
  return frame.evaluate.mock.calls.some(
    ([fn]) =>
      String(fn).includes("searchBtn") && String(fn).includes(".click()"),
  );
}

function makeTransactionResultFrame() {
  const frame = makeFrame({ authenticated: true });
  frame.url.mockReturnValue(TRANSACTION_RESULT_URL);
  frame.evaluate.mockImplementation(async (fn: unknown) => {
    const source = String(fn);
    if (source.includes("#btnOpen") || source.includes("#tFunc")) return true;
    if (source.includes("交易日期")) return true;
    if (source.includes('querySelectorAll("table")')) return transactionTables;
    if (source.includes("searchBtn")) return false;
    return undefined;
  });
  return frame;
}

function makeEmptyLiveFrame() {
  const frame = makeFrame({ authenticated: true });
  frame.url.mockReturnValue(TRANSACTION_QUERY_URL);
  frame.evaluate.mockImplementation(async (fn: unknown) => {
    const source = String(fn);
    if (source.includes("#btnOpen") || source.includes("#tFunc")) return true;
    if (source.includes("交易日期")) return false;
    if (source.includes('querySelectorAll("table")')) return "";
    if (source.includes("searchBtn")) return false;
    return undefined;
  });
  return frame;
}

function detachQueryFrameAfterSearch(
  page: ReturnType<typeof makePage>,
  nextFrames: Array<ReturnType<typeof makeFrame>>,
  responseHtml?: string,
  responseUrl = TRANSACTION_RESULT_URL,
  base64Encoded = false,
) {
  const queryFrame = page.frame;
  const previousEvaluate = queryFrame.evaluate;
  queryFrame.evaluate = vi
    .fn()
    .mockImplementation(async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (queryFrame.detached) {
        throw new Error("Execution context was destroyed during navigation");
      }
      if (source.includes("searchBtn") && source.includes(".click()")) {
        queryFrame.detached = true;
        page.frames.mockImplementation(() => nextFrames);
        if (responseHtml !== undefined) {
          page.emitTransactionDocument(
            responseUrl,
            responseHtml,
            base64Encoded,
          );
        }
        return true;
      }
      return previousEvaluate(fn, arg);
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMock.sessions.mockResolvedValue([]);
  puppeteerMock.limits.mockResolvedValue({
    activeSessions: [],
    maxConcurrentSessions: 3,
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("第一銀行 browser session lifecycle", () => {
  it("captures CAPTCHA, stores session id, and disconnects the pending browser", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const result = await prepareFirstbankCaptcha({} as Fetcher, credentials);

    expect(puppeteerMock.launch).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ keep_alive: expect.any(Number) }),
    );
    expect(browser.sessionId).toHaveBeenCalledOnce();
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      browserSessionId: "firstbank-session",
      captchaDigitCount: 4,
      captchaImage: "data:image/jpeg;base64,AQID",
    });
    expect(page.goto).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("connects to an existing pending browser instead of launching another", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "firstbank-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    const result = await prepareFirstbankCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "firstbank-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "firstbank-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(result.browserSessionId).toBe("firstbank-session");
  });

  it("waits for a pending browser connection to be released", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    puppeteerMock.sessions
      .mockResolvedValueOnce([
        {
          sessionId: "firstbank-session",
          startTime: Date.now(),
          connectionId: "finishing-connection",
        },
      ])
      .mockResolvedValue([
        { sessionId: "firstbank-session", startTime: Date.now() },
      ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    await expect(
      prepareFirstbankCaptcha({} as Fetcher, {
        ...credentials,
        browserSessionId: "firstbank-session",
      }),
    ).resolves.toMatchObject({ browserSessionId: "firstbank-session" });
    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "firstbank-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("submits a four-to-eight character CAPTCHA and closes the browser after sync", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "firstbank-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    const result = await createFirstbankConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "firstbank-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "XVSH",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "firstbank-session");
    expect(page.type).toHaveBeenCalledWith(
      "#vrfyCode",
      "XVSH",
      expect.objectContaining({ delay: 15 }),
    );
    expect(page.mouse.click).toHaveBeenCalledWith(140, 360);
    expect(
      page.evaluate.mock.calls.some(([fn]) =>
        String(fn).includes("form.submit"),
      ),
    ).toBe(false);
    expect(result.bankAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: expect.stringMatching(/^bank:firstbank:/),
        }),
      ]),
    );
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.disconnect).not.toHaveBeenCalled();
  });

  it("restores valid cookies without invoking OCR", async () => {
    const page = makePage({ authenticated: true });
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi.fn();

    const result = await createFirstbankConnector(
      {} as Fetcher,
      recognize,
    ).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });

    expect(page.setCookie).toHaveBeenCalledOnce();
    expect(recognize).not.toHaveBeenCalled();
    expect(result.bankAccounts).toHaveLength(1);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("limits automatic OCR to three attempts and rejects malformed answers", async () => {
    const page = makePage();
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi.fn().mockResolvedValue("bad");

    await expect(
      createFirstbankConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(FirstbankVerificationRequiredError);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("classifies an invalid manually submitted CAPTCHA and still closes the browser", async () => {
    const page = makePage();
    page.mouse.click.mockResolvedValue(undefined);
    page.evaluate.mockImplementation(async (fn: unknown) => {
      const source = String(fn);
      if (source.includes("image.naturalWidth")) return { x: 140, y: 360 };
      if (source.includes("innerText")) return "圖形驗證碼錯誤";
      return undefined;
    });
    const browser = makeBrowser(page);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "firstbank-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    await expect(
      createFirstbankConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "firstbank-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "XVSH",
      }),
    ).rejects.toBeInstanceOf(FirstbankCaptchaRejectedError);
    expect(page.mouse.click).toHaveBeenCalledWith(140, 360);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("stops before login when the randomized login area is unavailable", async () => {
    const page = makePage();
    page.waitForFunction.mockRejectedValue(new Error("area not ready"));
    const browser = makeBrowser(page);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "firstbank-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    const sync = createFirstbankConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "firstbank-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captcha: "XVSH",
    });
    await expect(sync).rejects.toBeInstanceOf(FirstbankConnectionError);
    await expect(sync).rejects.toThrow(
      "第一銀行登入按鈕尚未載入完成，請重新取得圖形驗證碼。",
    );
    expect(page.mouse.click).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

describe("第一銀行交易明細 010103 擷取", () => {
  it("點擊 searchBtn 後序列化仍存活的 010103 frame", async () => {
    const page = makePage({ authenticated: true });
    const resultFrame = makeTransactionResultFrame();
    detachQueryFrameAfterSearch(page, [resultFrame]);
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const result = await createFirstbankConnector({} as Fetcher, vi.fn()).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });

    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: -100,
          description: "測試交易",
        }),
      ]),
    );
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(postedTransactionQuery(page.frame)).toBe(false);
    expect(resultFrame.evaluate).toHaveBeenCalled();
    expect(page.frame.waitForNavigation).not.toHaveBeenCalled();
  });

  it("010103 iframe 消失時改從 CDP document response 讀取明細", async () => {
    const page = makePage({ authenticated: true });
    const liveFrame = makeEmptyLiveFrame();
    detachQueryFrameAfterSearch(page, [liveFrame], transactionTables);
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const result = await createFirstbankConnector({} as Fetcher, vi.fn()).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(postedTransactionQuery(page.frame)).toBe(false);
    expect(page.cdpSession.send).toHaveBeenCalledWith(
      "Network.enable",
      expect.objectContaining({
        maxTotalBufferSize: expect.any(Number),
        maxResourceBufferSize: expect.any(Number),
      }),
    );
    expect(page.cdpSession.send).toHaveBeenCalledWith(
      "Network.getResponseBody",
      { requestId: "transaction-document" },
    );
    expect(page.cdpSession.detach).toHaveBeenCalledOnce();
    expect(page.frame.waitForNavigation).not.toHaveBeenCalled();
  });

  it("解碼 CDP 的 base64 010103 document body", async () => {
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      base64Text(transactionTables),
      TRANSACTION_RESULT_URL,
      true,
    );
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const result = await createFirstbankConnector({} as Fetcher, vi.fn()).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });

    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
  });

  it("忽略非 010103 document 的 CDP response", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [],
      transactionTables,
      TRANSACTION_QUERY_URL,
    );
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const pending = createFirstbankConnector({} as Fetcher, vi.fn()).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });
    const expectation =
      expect(pending).rejects.toThrow("第一銀行交易明細讀取失敗。");
    await vi.advanceTimersByTimeAsync(3_000);
    await expectation;
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });

  it("沒有 010103 frame 或 HTTP 回應時快速回報讀取失敗", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(page, []);
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    const pending = createFirstbankConnector({} as Fetcher, vi.fn()).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "ibank.firstbank.com.tw",
        },
      ]),
    });
    const expectation =
      expect(pending).rejects.toThrow("第一銀行交易明細讀取失敗。");
    await vi.advanceTimersByTimeAsync(3_000);
    await expectation;
    await expect(pending).rejects.toBeInstanceOf(FirstbankConnectionError);
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(postedTransactionQuery(page.frame)).toBe(false);
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });
});
