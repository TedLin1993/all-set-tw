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
const ACCOUNT_OVERVIEW_URL =
  "https://ibank.firstbank.com.tw/NetBank/1/acntReviewAll.html";

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
const VERIFY_DV_URL = "https://ibank.firstbank.com.tw/NetBank/2/verifyDV.html";

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
    click: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (source.includes("document.readyState")) return true;
      if (source.includes("depositTriggerSelector")) return "#btnOpen a";
      if (source.includes("fetch(resourcePath")) {
        return { ok: true, status: 200, text: depositTables };
      }
      if (source.includes("searchBtn") && source.includes("setTimeout")) {
        setTimeout(() => {
          currentUrl = TRANSACTION_RESULT_URL;
        }, 0);
        return true;
      }
      if (source.includes('querySelectorAll("table")')) {
        return currentUrl.includes("010103")
          ? transactionTables
          : depositTables;
      }
      if (
        source.includes("acnt") ||
        source.includes('querySelectorAll("select")')
      )
        return true;
      if (source.includes("searchBtn")) return true;
      if (source.includes("帳面餘額") || source.includes("可用餘額"))
        return true;
      if (source.includes("交易日期")) return currentUrl.includes("010103");
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
          if (
            (method === "Network.getResponseBody" ||
              method === "Fetch.getResponseBody") &&
            params?.requestId
          ) {
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
      if (source.includes("depositTriggerSelector")) {
        return originalFrameEvaluate(fn, arg);
      }
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
        status: () => 200,
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
    emitCdpRequest(url: string, requestId: string, resourceType = "XHR") {
      for (const listener of cdpListeners.get("Network.requestWillBeSent") ??
        [])
        listener({ requestId, type: resourceType, request: { url } });
    },
    emitCdpResponse(
      url: string,
      requestId: string,
      status = 200,
      resourceType = "XHR",
    ) {
      for (const listener of cdpListeners.get("Network.responseReceived") ?? [])
        listener({
          requestId,
          type: resourceType,
          response: { url, status },
        });
    },
    dialogs: [] as Array<{ accept: ReturnType<typeof vi.fn> }>,
    emitDialog(message: string, type = "confirm") {
      const dialog = {
        type: () => type,
        message: () => message,
        accept: vi.fn().mockResolvedValue(undefined),
        dismiss: vi.fn().mockResolvedValue(undefined),
      };
      page.dialogs.push(dialog);
      for (const listener of listeners.get("dialog") ?? []) listener(dialog);
      return dialog;
    },
    emitCdpLoadingFailed(requestId: string) {
      for (const listener of cdpListeners.get("Network.loadingFailed") ?? [])
        listener({ requestId });
    },
    emitTransactionDocumentReceived(
      url: string,
      body: string,
      base64Encoded = false,
      status = 200,
      resourceType = "Document",
    ) {
      const requestId = "transaction-document";
      cdpBodies.set(requestId, { body, base64Encoded });
      for (const listener of cdpListeners.get("Network.responseReceived") ?? [])
        listener({
          requestId,
          type: resourceType,
          response: { url, status },
        });
    },
    emitTransactionDocumentLoaded() {
      for (const listener of cdpListeners.get("Network.loadingFinished") ?? [])
        listener({ requestId: "transaction-document" });
    },
    emitFetchPaused(
      url: string,
      body: string,
      base64Encoded = false,
      status = 200,
    ) {
      const requestId = "fetch-transaction-document";
      cdpBodies.set(requestId, { body, base64Encoded });
      for (const listener of cdpListeners.get("Fetch.requestPaused") ?? [])
        listener({
          requestId,
          resourceType: "Document",
          request: { url },
          responseStatusCode: status,
        });
    },
    emitTransactionDocument(url: string, body: string, base64Encoded = false) {
      const requestId = "transaction-document";
      cdpBodies.set(requestId, { body, base64Encoded });
      for (const listener of cdpListeners.get("Network.responseReceived") ?? [])
        listener({
          requestId,
          type: "Document",
          response: { url, status: 200 },
        });
      for (const listener of cdpListeners.get("Network.loadingFinished") ?? [])
        listener({ requestId });
    },
    cdpSession,
  };
  frame.click.mockImplementation(async (selector: string) => {
    if (selector === "#btnOpen a") {
      page.emitResponse(
        "https://ibank.firstbank.com.tw/NetBank/ajax/acntReview1.html",
        depositTables,
      );
    }
  });
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
  return frame.evaluate.mock.calls.some(([fn]) => {
    const source = String(fn);
    return (
      source.includes("searchBtn") &&
      source.includes("setTimeout") &&
      source.includes(".click()")
    );
  });
}

function probedTransactionHeader(frame: ReturnType<typeof makeFrame>) {
  return frame.evaluate.mock.calls.some(([fn]) =>
    String(fn).includes("交易日期"),
  );
}

function directlySubmitsForm(frame: ReturnType<typeof makeFrame>) {
  return frame.evaluate.mock.calls.some(([fn]) =>
    String(fn).includes("form.submit"),
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

function mockQueryAccountSelect(
  frame: ReturnType<typeof makeFrame>,
  values: Array<{ text: string; value: string; selected?: boolean }>,
) {
  const options = values.map((value) => ({
    ...value,
    selected: Boolean(value.selected),
  }));
  let selectedValue =
    options.find((option) => option.selected)?.value ?? options[0]?.value ?? "";
  const dispatchEvent = vi.fn();
  const select = {
    options,
    get selectedIndex() {
      return options.findIndex((option) => option.selected);
    },
    get value() {
      return selectedValue;
    },
    set value(value: string) {
      selectedValue = value;
      for (const option of options) option.selected = option.value === value;
    },
    dispatchEvent,
  };
  const previousEvaluate = frame.evaluate;
  frame.evaluate = vi
    .fn()
    .mockImplementation(async (fn: unknown, arg?: unknown) => {
      if (!String(fn).includes("acnt")) {
        return previousEvaluate(fn, arg);
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "document",
      );
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { querySelector: () => select },
      });
      try {
        return (fn as (shouldSelect: boolean) => unknown)(Boolean(arg));
      } finally {
        if (descriptor) {
          Object.defineProperty(globalThis, "document", descriptor);
        } else {
          delete (globalThis as { document?: unknown }).document;
        }
      }
    });
  return { dispatchEvent, options, select };
}

function detachQueryFrameAfterSearch(
  page: ReturnType<typeof makePage>,
  nextFrames: Array<ReturnType<typeof makeFrame>>,
  responseHtml?: string,
  responseUrl = TRANSACTION_RESULT_URL,
  base64Encoded = false,
  timing?: {
    delayMs?: number;
    loadingFinishedDelayMs?: number;
    fetchDelayMs?: number;
    resourceType?: string;
    verification?: "response" | "pending" | "failed";
    verificationDelayMs?: number;
    dialogMessage?: string;
    queryFrame?: ReturnType<typeof makeFrame>;
  },
) {
  const queryFrame = timing?.queryFrame ?? page.frame;
  const previousEvaluate = queryFrame.evaluate;
  queryFrame.evaluate = vi
    .fn()
    .mockImplementation(async (fn: unknown, arg?: unknown) => {
      const source = String(fn);
      if (queryFrame.detached) {
        throw new Error("Execution context was destroyed during navigation");
      }
      if (source.includes("searchBtn") && source.includes("setTimeout")) {
        // Match the connector's browser-side timer: Runtime.evaluate returns
        // first, then the real button click emits the bank requests.
        setTimeout(() => {
          const verification = timing?.verification ?? "response";
          page.emitCdpRequest(VERIFY_DV_URL, "verify-dv");
          if (timing?.dialogMessage !== undefined) {
            page.emitDialog(timing.dialogMessage);
          }
          if (verification === "pending") return;
          // The bank only submits the query once verifyDV settles, so every
          // later emission is scheduled relative to that verification.
          setTimeout(() => {
            if (verification === "failed") {
              page.emitCdpLoadingFailed("verify-dv");
              return;
            }
            page.emitCdpResponse(VERIFY_DV_URL, "verify-dv");
            queryFrame.detached = true;
            page.frames.mockImplementation(() => nextFrames);
            if (responseHtml === undefined) return;
            const fetchDelayMs = timing?.fetchDelayMs;
            if (fetchDelayMs !== undefined) {
              setTimeout(() => {
                page.emitFetchPaused(responseUrl, responseHtml, base64Encoded);
              }, fetchDelayMs);
            }
            if (
              timing?.delayMs !== undefined ||
              timing?.loadingFinishedDelayMs !== undefined
            ) {
              const delayMs = timing?.delayMs ?? 0;
              const loadingFinishedDelayMs =
                timing?.loadingFinishedDelayMs ?? delayMs;
              setTimeout(() => {
                page.emitTransactionDocumentReceived(
                  responseUrl,
                  responseHtml,
                  base64Encoded,
                  200,
                  timing?.resourceType ?? "Document",
                );
              }, delayMs);
              setTimeout(() => {
                page.emitTransactionDocumentLoaded();
              }, loadingFinishedDelayMs);
            } else if (fetchDelayMs === undefined) {
              page.emitTransactionDocument(
                responseUrl,
                responseHtml,
                base64Encoded,
              );
            }
          }, timing?.verificationDelayMs ?? 0);
        }, 0);
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
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
    );
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
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
    );
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
  it("存款總覽依 Recorder 點擊銀行原生 handler 且不注入 fetch", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const page = makePage({ authenticated: true });
    const staleFrame = page.frame;
    staleFrame.setUrl(ACCOUNT_OVERVIEW_URL);
    page.goto.mockImplementation(async () => {
      staleFrame.setUrl(ACCOUNT_OVERVIEW_URL);
    });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
    );
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    try {
      const result = await createFirstbankConnector(
        {} as Fetcher,
        vi.fn(),
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

      expect(result.bankTransactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: -100, description: "測試交易" }),
        ]),
      );
      expect(
        staleFrame.goto.mock.calls.some(
          ([url]) => url === ACCOUNT_OVERVIEW_URL,
        ),
      ).toBe(false);
      expect(staleFrame.click).toHaveBeenCalledTimes(1);
      expect(staleFrame.click).toHaveBeenCalledWith("#btnOpen a");
      expect(
        staleFrame.evaluate.mock.calls.some(([fn]) =>
          String(fn).includes("fetch(resourcePath"),
        ),
      ).toBe(false);
      expect(logs.some((line) => line.includes("deposit-ajax-failed"))).toBe(
        false,
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("存款總覽 frame replacement 後只在不同且 ready 的 frame 點擊一次", async () => {
    const page = makePage({ authenticated: true });
    const staleFrame = page.frame;
    const replacementFrame = makeFrame({ authenticated: true });
    let currentFrames = [staleFrame];
    page.frames.mockImplementation(() => currentFrames);
    const previousEvaluate = staleFrame.evaluate;
    staleFrame.evaluate = vi
      .fn()
      .mockImplementation(async (fn: unknown, arg?: unknown) => {
        if (
          staleFrame.url() === ACCOUNT_OVERVIEW_URL &&
          String(fn).includes("document.readyState")
        ) {
          staleFrame.detached = true;
          replacementFrame.setUrl(ACCOUNT_OVERVIEW_URL);
          currentFrames = [replacementFrame];
          throw new Error("waitForFunction failed: frame got detached");
        }
        return previousEvaluate(fn, arg);
      });
    replacementFrame.click.mockImplementation(async (selector: string) => {
      if (selector === "#btnOpen a") {
        page.emitResponse(
          "https://ibank.firstbank.com.tw/NetBank/ajax/acntReview1.html",
          depositTables,
        );
      }
    });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { queryFrame: replacementFrame },
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

    expect(result.bankAccounts).toHaveLength(1);
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
    expect(staleFrame.click).not.toHaveBeenCalled();
    expect(replacementFrame.click).toHaveBeenCalledTimes(1);
    expect(replacementFrame.click).toHaveBeenCalledWith("#btnOpen a");
  });

  it("英文 placeholder value 0 不會被選成查詢帳號", async () => {
    const page = makePage({ authenticated: true });
    const accountSelect = mockQueryAccountSelect(page.frame, [
      { text: "--Please select--", value: "0", selected: true },
      { text: "masked-account", value: "24657009679" },
    ]);
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
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
    expect(accountSelect.select.value).toBe("24657009679");
    expect(accountSelect.options[0]?.selected).toBe(false);
    expect(accountSelect.options[1]?.selected).toBe(true);
    expect(accountSelect.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it("只有 placeholder 時不送出交易查詢", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    mockQueryAccountSelect(page.frame, [
      { text: "--Please select--", value: "0", selected: true },
    ]);
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
      expect(pending).rejects.toThrow("第一銀行交易明細查詢帳號無法選取。");
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;
    expect(clickedTransactionSearch(page.frame)).toBe(false);
  });

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
    expect(directlySubmitsForm(page.frame)).toBe(false);
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
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });

  it("沒有 010103 frame 或 HTTP 回應時逾時回報讀取失敗", async () => {
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
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;
    await expect(pending).rejects.toBeInstanceOf(FirstbankConnectionError);
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(postedTransactionQuery(page.frame)).toBe(false);
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });

  it("verifyDV 只有 request 沒有 response 時回報前置驗證未完成", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { verification: "pending" },
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
      expect(pending).rejects.toThrow("第一銀行交易明細前置驗證沒有完成。");
    await vi.advanceTimersByTimeAsync(31_000);
    await expectation;
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });

  it("verifyDV 延遲回應時延長等待並擷取 010103", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { verificationDelayMs: 15_000, delayMs: 1_000 },
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
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(11_000);
    expect(settled).toBe(false);
    // A blocked query frame must not be probed with Runtime.evaluate while the
    // bank's verifyDV request is still in flight.
    expect(probedTransactionHeader(page.frame)).toBe(false);

    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
    expect(page.cdpSession.send).toHaveBeenCalledWith(
      "Network.getResponseBody",
      { requestId: "transaction-document" },
    );
  });

  it("查詢跳出原生對話框時自動接受並遮罩訊息數字", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { dialogMessage: "查詢區間 20260101 至 20260131 帳號 123456789012" },
    );
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    try {
      const result = await createFirstbankConnector(
        {} as Fetcher,
        vi.fn(),
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

      expect(result.bankTransactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: -100, description: "測試交易" }),
        ]),
      );
      expect(page.dialogs).toHaveLength(1);
      expect(page.dialogs[0]?.accept).toHaveBeenCalledOnce();
      const dialogLine = logs.find((line) => line.includes("0101-dialog"));
      expect(dialogLine).toContain(
        "detail=confirm:查詢區間 ######## 至 ######## 帳號 ############",
      );
      expect(dialogLine).not.toContain("123456789012");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("存款總覽 AJAX 非 2xx 時記錄狀態並回報讀取失敗", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const page = makePage({ authenticated: true });
    page.frame.click.mockImplementation(async (selector: string) => {
      if (selector === "#btnOpen a") {
        const response = {
          url: () =>
            "https://ibank.firstbank.com.tw/NetBank/ajax/acntReview1.html",
          status: () => 403,
          json: vi.fn().mockRejectedValue(new Error("not json")),
          text: vi.fn().mockResolvedValue(""),
        };
        const pageListeners = page.on.mock.calls.find(
          ([event]) => event === "response",
        )?.[1] as Listener | undefined;
        pageListeners?.(response);
      }
    });
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    try {
      await expect(
        createFirstbankConnector({} as Fetcher, vi.fn()).sync({
          ...credentials,
          sessionCookies: JSON.stringify([
            {
              name: "SESSION",
              value: "encrypted-at-rest",
              domain: "ibank.firstbank.com.tw",
            },
          ]),
        }),
      ).rejects.toThrow("第一銀行存款總覽讀取失敗。");

      expect(
        logs.find((line) => line.includes("deposit-ajax path=")),
      ).toContain("status=403 bodyLength=0");
      expect(page.frame.click).toHaveBeenCalledTimes(1);
      expect(logs.some((line) => line.includes("collect-start"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("存款總覽回應逾時後不會再次點擊銀行 handler", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    page.frame.click.mockResolvedValue(undefined);
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
      expect(pending).rejects.toThrow("第一銀行存款總覽讀取失敗。");
    await vi.advanceTimersByTimeAsync(25_000);
    await expectation;

    expect(page.frame.click).toHaveBeenCalledTimes(1);
    expect(page.frame.click).toHaveBeenCalledWith("#btnOpen a");
  });

  it("交易頁 frame 導覽 replacement 後只在 ready 的 0101 frame 送出一次", async () => {
    const page = makePage({ authenticated: true });
    const overviewFrame = page.frame;
    overviewFrame.setUrl(ACCOUNT_OVERVIEW_URL);
    const queryFrame = makeFrame({ authenticated: true });
    queryFrame.setUrl(TRANSACTION_QUERY_URL);
    const notReadyQueryFrame = makeFrame({ authenticated: true });
    notReadyQueryFrame.setUrl(TRANSACTION_QUERY_URL);
    notReadyQueryFrame.evaluate.mockImplementation(async (fn: unknown) => {
      if (String(fn).includes("document.readyState")) return false;
      return undefined;
    });
    const rootFrame = makeFrame({ authenticated: true });
    rootFrame.setUrl(FRAME_URL);
    overviewFrame.goto.mockImplementation(async (url: string) => {
      overviewFrame.setUrl(url);
      if (url === TRANSACTION_QUERY_URL) {
        overviewFrame.detached = true;
        page.frames.mockImplementation(() => [
          rootFrame,
          notReadyQueryFrame,
          queryFrame,
        ]);
        throw new Error("Navigating frame was detached");
      }
    });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { queryFrame },
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
    expect(clickedTransactionSearch(overviewFrame)).toBe(false);
    expect(clickedTransactionSearch(rootFrame)).toBe(false);
    expect(clickedTransactionSearch(notReadyQueryFrame)).toBe(false);
    expect(clickedTransactionSearch(queryFrame)).toBe(true);
  });

  it("找不到 ready 的 0101 replacement 時不會把 root frame 當查詢頁", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    const overviewFrame = page.frame;
    overviewFrame.setUrl(ACCOUNT_OVERVIEW_URL);
    const rootFrame = makeFrame({ authenticated: true });
    rootFrame.setUrl(FRAME_URL);
    const notReadyQueryFrame = makeFrame({ authenticated: true });
    notReadyQueryFrame.setUrl(TRANSACTION_QUERY_URL);
    notReadyQueryFrame.evaluate.mockImplementation(async (fn: unknown) => {
      if (String(fn).includes("document.readyState")) return false;
      return undefined;
    });
    overviewFrame.goto.mockImplementation(async (url: string) => {
      overviewFrame.setUrl(url);
      if (url === TRANSACTION_QUERY_URL) {
        overviewFrame.detached = true;
        page.frames.mockImplementation(() => [rootFrame, notReadyQueryFrame]);
        throw new Error("Waiting failed: Frame detached");
      }
    });
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
    const expectation = expect(pending).rejects.toThrow(
      "第一銀行交易明細查詢頁面尚未載入完成。",
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;

    expect(clickedTransactionSearch(overviewFrame)).toBe(false);
    expect(clickedTransactionSearch(rootFrame)).toBe(false);
    expect(clickedTransactionSearch(notReadyQueryFrame)).toBe(false);
  });

  it("本次 verifyDV 完成前不會採用既有的舊 010103 frame", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    const staleResultFrame = makeTransactionResultFrame();
    const queryFrame = page.frame;
    page.frames.mockImplementation(() => [queryFrame, staleResultFrame]);
    detachQueryFrameAfterSearch(
      page,
      [staleResultFrame],
      undefined,
      TRANSACTION_RESULT_URL,
      false,
      { verification: "pending" },
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
      expect(pending).rejects.toThrow("第一銀行交易明細前置驗證沒有完成。");
    await vi.advanceTimersByTimeAsync(31_000);
    await expectation;

    expect(probedTransactionHeader(staleResultFrame)).toBe(false);
  });

  it("verifyDV loadingFailed 時回報前置驗證未完成", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { verification: "failed" },
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
      expect(pending).rejects.toThrow("第一銀行交易明細前置驗證沒有完成。");
    await vi.advanceTimersByTimeAsync(11_000);
    await expectation;
    expect(clickedTransactionSearch(page.frame)).toBe(true);
    expect(page.cdpSession.send).not.toHaveBeenCalledWith(
      "Network.getResponseBody",
      expect.anything(),
    );
  });

  it("延遲到達的 CDP 010103 document 仍可擷取明細", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      `${TRANSACTION_RESULT_URL};jsessionid=synthetic-secret`,
      false,
      { delayMs: 3_000 },
    );
    const browser = makeBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);

    try {
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
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;
      expect(result.bankTransactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: -100, description: "測試交易" }),
        ]),
      );
      expect(page.cdpSession.send).toHaveBeenCalledWith(
        "Network.getResponseBody",
        { requestId: "transaction-document" },
      );
      expect(page.cdpSession.detach).toHaveBeenCalledOnce();
      const joined = logs.join("\n");
      expect(joined).toContain("path=/NetBank/2/010103.html");
      expect(joined).toContain("status=200");
      expect(joined).toMatch(/bodyLength=\d+/);
      expect(joined).toContain("hasTxnDateHeader=true");
      const verificationRequestIndex = logs.findIndex((line) =>
        line.includes("0101-cdp-request path=/NetBank/2/verifyDV.html"),
      );
      const verificationResponseIndex = logs.findIndex((line) =>
        line.includes(
          "0101-verification-response path=/NetBank/2/verifyDV.html",
        ),
      );
      const transactionResponseIndex = logs.findIndex((line) =>
        line.includes("010103-cdp-response path=/NetBank/2/010103.html"),
      );
      expect(verificationRequestIndex).toBeGreaterThanOrEqual(0);
      expect(verificationResponseIndex).toBeGreaterThan(
        verificationRequestIndex,
      );
      expect(transactionResponseIndex).toBeGreaterThan(
        verificationResponseIndex,
      );
      expect(joined).not.toContain("synthetic-secret");
      expect(joined).not.toContain("測試交易");
      expect(joined).not.toContain("123456789012");
      expect(joined).not.toContain("encrypted-at-rest");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("requestIds 仍為空時仍等待延後的 CDP loadingFinished", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { delayMs: 3_000, loadingFinishedDelayMs: 4_000 },
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
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await pending;
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
    expect(page.cdpSession.send).toHaveBeenCalledWith(
      "Network.getResponseBody",
      {
        requestId: "transaction-document",
      },
    );
  });

  it("結果 frame 帶 jsessionid 時仍序列化交易表", async () => {
    const page = makePage({ authenticated: true });
    const resultFrame = makeTransactionResultFrame();
    resultFrame.url.mockReturnValue(
      `${TRANSACTION_RESULT_URL};jsessionid=synthetic`,
    );
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
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
  });

  it("CDP 資源類型為 Other 時仍擷取延遲的 010103", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { delayMs: 3_000, resourceType: "Other" },
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
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
  });

  it("Network 事件缺失時改從 CDP Fetch.requestPaused 擷取 010103", async () => {
    vi.useFakeTimers();
    const page = makePage({ authenticated: true });
    detachQueryFrameAfterSearch(
      page,
      [makeEmptyLiveFrame()],
      transactionTables,
      TRANSACTION_RESULT_URL,
      false,
      { fetchDelayMs: 3_000 },
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
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.bankTransactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amount: -100, description: "測試交易" }),
      ]),
    );
    expect(page.cdpSession.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [
        {
          urlPattern: "*://ibank.firstbank.com.tw/NetBank/2/010103*",
          requestStage: "Response",
        },
      ],
    });
    expect(page.cdpSession.send).toHaveBeenCalledWith("Fetch.getResponseBody", {
      requestId: "fetch-transaction-document",
    });
    expect(page.cdpSession.send).toHaveBeenCalledWith("Fetch.continueRequest", {
      requestId: "fetch-transaction-document",
    });
  });
});
