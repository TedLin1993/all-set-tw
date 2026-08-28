import { beforeEach, describe, expect, it, vi } from "vitest";

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

type Listener = (...args: unknown[]) => void;

function makeFrame(options?: { authenticated?: boolean }) {
  let currentUrl = options?.authenticated ? FRAME_URL : LOGIN_URL;
  return {
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
      if (source.includes('querySelectorAll("table")')) {
        return currentUrl.includes("0101") ? transactionTables : depositTables;
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
        frame.url.mockReturnValue(FRAME_URL);
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
        frame.url.mockReturnValue(FRAME_URL);
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
        text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
      };
      for (const listener of listeners.get("response") ?? [])
        listener(response);
    },
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
