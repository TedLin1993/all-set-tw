import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  createHncbConnector,
  prepareHncbCaptcha,
  HncbBrowserCapacityError,
  HncbCaptchaRejectedError,
  HncbConnectionError,
  HncbCredentialRejectedError,
} from "../../src/connectors/hncb";

const LOGIN_URL =
  "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";
const PERSONAL_JSP =
  "https://netbank.hncb.com.tw/netbank/pages/jsp/Personal_new/html/personal.jsp";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

const depositHtml = `
  <table>
    <tr>
      <td>777201604933</td>
      <td>活儲</td>
      <td>新台幣</td>
      <td>100,000.00</td>
      <td>100,000.00</td>
    </tr>
  </table>
`;

function mainFrame(html = depositHtml) {
  let url =
    "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq";
  return {
    name: () => "main",
    url: () => url,
    content: vi.fn().mockImplementation(async () => {
      if (/CrdDetailInq/i.test(url)) return "";
      return html;
    }),
    goto: vi.fn().mockImplementation(async (nextUrl: string) => {
      url = nextUrl;
    }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
  };
}

function page(options?: {
  html?: string;
  startLoggedIn?: boolean;
  navigationTimeout?: boolean;
  blankLoginPage?: boolean;
  errorPage?: boolean;
  hangNavigation?: boolean;
}) {
  let currentUrl = options?.startLoggedIn
    ? PERSONAL_JSP
    : options?.blankLoginPage
      ? "about:blank"
      : LOGIN_URL;
  const frame = mainFrame(options?.html ?? depositHtml);
  return {
    frame,
    $: vi.fn().mockImplementation(async (selector: string) => {
      if (selector.includes("code_Cap") || selector.includes("CaptchaImage")) {
        return {
          screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        };
      }
      if (selector.includes("frameset") && currentUrl.includes("personal")) {
        return {};
      }
      return null;
    }),
    cookies: vi
      .fn()
      .mockResolvedValue([
        { name: "JSESSIONID", value: "fresh", domain: "netbank.hncb.com.tw" },
      ]),
    evaluate: vi
      .fn()
      .mockImplementation(async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("readyState") && source.includes("USERIDTEXT")) {
          const onLogin = currentUrl.includes("Login");
          return {
            href: currentUrl,
            title: onLogin ? "華南銀行-個人網路銀行" : "",
            readyState: options?.blankLoginPage ? "loading" : "complete",
            hasUser: onLogin,
            hasSubmit: onLogin,
            htmlLength: onLogin ? 50_000 : 0,
          };
        }
        if (source.includes("innerText")) return "";
        if (source.includes("setTimeout") && source.includes("doSubmit")) {
          currentUrl = PERSONAL_JSP;
        }
        return undefined;
      }),
    frames: vi
      .fn()
      .mockImplementation(() =>
        currentUrl.includes("personal") ? [frame] : [],
      ),
    goto: vi.fn().mockImplementation(async (url: string) => {
      if (options?.hangNavigation) return new Promise(() => {});
      if (options?.errorPage) {
        currentUrl = "chrome-error://chromewebdata/";
        throw new Error("Navigation timeout of 5000 ms exceeded");
      }
      if (options?.blankLoginPage) {
        currentUrl = "about:blank";
        throw new Error("Navigation timeout of 20000 ms exceeded");
      }
      currentUrl = url;
      if (options?.navigationTimeout) {
        throw new Error("Navigation timeout of 30000 ms exceeded");
      }
      return { status: () => 200 };
    }),
    off: vi.fn(),
    on: vi.fn(),
    setCookie: vi.fn().mockResolvedValue(undefined),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => currentUrl),
    waitForFunction: vi.fn().mockImplementation(async () => {
      if (options?.blankLoginPage) {
        throw new Error(
          "waiting for function failed: timeout 15000ms exceeded",
        );
      }
    }),
    waitForNavigation: vi.fn().mockImplementation(async () => {
      currentUrl = PERSONAL_JSP;
    }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

function browser(browserPage: ReturnType<typeof page>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([browserPage]),
    newPage: vi.fn().mockResolvedValue(browserPage),
    sessionId: vi.fn().mockReturnValue("hncb-session"),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

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

describe("HNCB browser session lifecycle", () => {
  it("closes a browser when CAPTCHA preparation stalls past its deadline", async () => {
    vi.useFakeTimers();
    const browserPage = page();
    const browserInstance = browser(browserPage);
    browserInstance.pages.mockImplementation(() => new Promise(() => {}));
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const preparation = prepareHncbCaptcha({} as Fetcher, credentials);
    const rejected = expect(preparation).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南瀏覽器工作超過期限，已停止，請稍後再試。",
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await rejected;
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("waits for direct session cleanup when Puppeteer close stalls", async () => {
    vi.useFakeTimers();
    const browserPage = page();
    const browserInstance = browser(browserPage);
    browserInstance.pages.mockImplementation(() => new Promise(() => {}));
    browserInstance.close.mockImplementation(() => new Promise(() => {}));
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const preparation = prepareHncbCaptcha(
      { fetch } as unknown as Fetcher,
      credentials,
    );
    const rejected =
      expect(preparation).rejects.toBeInstanceOf(HncbConnectionError);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;

    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      "https://fake.host/v1/devtools/browser/hncb-session",
      { method: "DELETE" },
    );
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects after capturing CAPTCHA and stores the session id", async () => {
    const browserPage = page();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await prepareHncbCaptcha({} as Fetcher, credentials);

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).toHaveBeenCalledWith(expect.anything(), {
      keep_alive: 150_000,
    });
    expect(browserInstance.sessionId).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
    expect(browserInstance.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      browserSessionId: "hncb-session",
      captchaDigitCount: 4,
      captchaImage: "data:image/jpeg;base64,AQID",
    });
    expect(browserPage.goto).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("dismisses unexpected dialogs without blocking automation", async () => {
    const browserPage = page();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await prepareHncbCaptcha({} as Fetcher, credentials);

      const dialogHandler = browserPage.on.mock.calls.find(
        ([event]) => event === "dialog",
      )?.[1] as
        | ((dialog: {
            message: () => string;
            accept: () => Promise<void>;
          }) => void)
        | undefined;
      expect(dialogHandler).toBeTypeOf("function");
      const accept = vi.fn().mockResolvedValue(undefined);
      dialogHandler?.({
        message: () => "Sorry, there was a problem!",
        accept,
      });

      expect(accept).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("hncb_dialog_dismissed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("reuses the pending captcha browser instead of launching another one", async () => {
    const browserPage = page();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await prepareHncbCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "hncb-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "hncb-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
    expect(result.browserSessionId).toBe("hncb-session");
  });

  it("does not launch when the pending captcha browser is still connected", async () => {
    puppeteerMock.sessions.mockResolvedValue([
      {
        sessionId: "hncb-session",
        startTime: Date.now(),
        connectionId: "busy-connection",
      },
    ]);

    await expect(
      prepareHncbCaptcha({} as Fetcher, {
        ...credentials,
        browserSessionId: "hncb-session",
      }),
    ).rejects.toBeInstanceOf(HncbBrowserCapacityError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("submits the prepared CAPTCHA on the connected browser and saves cookies", async () => {
    const browserPage = page();
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await createHncbConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "hncb-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captchaDigitCount: 4,
      captcha: "1234",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "hncb-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browserPage.type).toHaveBeenCalledWith(
      "#TrxCaptchaKey",
      "1234",
      expect.any(Object),
    );
    expect(result.bankAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "bank:hncb:777201604933:TWD" }),
      ]),
    );
    expect(JSON.parse(String(result.cursor))).toMatchObject({
      sessionCookies: expect.stringContaining("JSESSIONID"),
    });
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });

  it("keeps syncing when the login submit call never returns", async () => {
    vi.useFakeTimers();
    const browserPage = page();
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("setTimeout") && source.includes("doSubmit")) {
          browserPage.url.mockReturnValue(PERSONAL_JSP);
          browserPage.frames.mockReturnValue([browserPage.frame]);
          return new Promise(() => {});
        }
        if (source.includes("innerText")) return "";
        return undefined;
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const pending = createHncbConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "hncb-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captchaDigitCount: 4,
      captcha: "1234",
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({
      bankAccounts: expect.arrayContaining([
        expect.objectContaining({ sourceId: "bank:hncb:777201604933:TWD" }),
      ]),
    });
  });

  it("retries reading the main frame after navigation destroys the execution context", async () => {
    const browserPage = page();
    browserPage.frame.content
      .mockReset()
      .mockRejectedValueOnce(
        new Error(
          "Execution context was destroyed, most likely because of a navigation.",
        ),
      )
      .mockImplementation(async () => {
        if (/CrdDetailInq/i.test(browserPage.frame.url())) return "";
        return depositHtml;
      });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await createHncbConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "hncb-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captchaDigitCount: 4,
      captcha: "1234",
    });

    expect(result.bankAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "bank:hncb:777201604933:TWD" }),
      ]),
    );
  });

  it("reuses valid cookies without running OCR", async () => {
    const browserPage = page({ startLoggedIn: true });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn();

    const result = await createHncbConnector({} as Fetcher, recognize).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "JSESSIONID",
          value: "valid",
          domain: "netbank.hncb.com.tw",
        },
      ]),
    });

    expect(recognize).not.toHaveBeenCalled();
    expect(browserPage.setCookie).toHaveBeenCalled();
    expect(browserPage.goto).toHaveBeenCalledWith(
      PERSONAL_JSP,
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
    expect(result.bankAccounts).toHaveLength(1);
  });

  it("re-logs in when restored cookies no longer open the account frameset", async () => {
    vi.useFakeTimers();
    const browserPage = page({ startLoggedIn: true });
    let sessionAlive = false;
    browserPage.frames.mockImplementation(() =>
      sessionAlive ? [browserPage.frame] : [],
    );
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("innerText")) return "";
        if (source.includes("setTimeout") && source.includes("doSubmit")) {
          sessionAlive = true;
        }
        return undefined;
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("1234");

    const pending = createHncbConnector({} as Fetcher, recognize).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        { name: "JSESSIONID", value: "stale", domain: "netbank.hncb.com.tw" },
      ]),
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toMatchObject({
      bankAccounts: expect.arrayContaining([
        expect.objectContaining({ sourceId: "bank:hncb:777201604933:TWD" }),
      ]),
    });
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("continues cookie restore when personal.jsp navigation times out", async () => {
    const browserPage = page({ navigationTimeout: true });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await createHncbConnector({} as Fetcher).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "JSESSIONID",
          value: "valid",
          domain: "netbank.hncb.com.tw",
        },
      ]),
    });

    expect(result.bankAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: "bank:hncb:777201604933:TWD" }),
      ]),
    );
  });

  it("closes the browser when prepared CAPTCHA verification fails", async () => {
    const browserPage = page();
    browserPage.waitForNavigation.mockResolvedValue(undefined);
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("innerText")) return "圖形驗證碼錯誤";
        return undefined;
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createHncbConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "hncb-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captchaDigitCount: 4,
        captcha: "1234",
      }),
    ).rejects.toBeInstanceOf(HncbCaptchaRejectedError);

    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });

  it("does not call an indeterminate prepared login a CAPTCHA error", async () => {
    vi.useFakeTimers();
    const browserPage = page();
    browserPage.waitForNavigation.mockResolvedValue(undefined);
    browserPage.evaluate.mockResolvedValue(undefined);
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const sync = createHncbConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "hncb-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captchaDigitCount: 4,
      captcha: "1234",
    });
    const rejected = expect(sync).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南登入後沒有取得明確回應，已停止重試，請稍後再試。",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("reloads a new captcha after OCR rejection and can succeed on a later attempt", async () => {
    const browserPage = page();
    let submits = 0;
    browserPage.waitForNavigation.mockResolvedValue(undefined);
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("innerText")) {
          return submits < 2 ? "圖形驗證碼錯誤" : "";
        }
        if (source.includes("setTimeout") && source.includes("doSubmit")) {
          submits += 1;
          if (submits >= 2) {
            browserPage.url.mockReturnValue(PERSONAL_JSP);
            browserPage.frames.mockReturnValue([mainFrame()]);
          }
        }
        return undefined;
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("0000")
      .mockResolvedValueOnce("1234");

    const result = await createHncbConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    expect(result.bankAccounts).toHaveLength(1);
  });

  it("stops after an indeterminate login response without another OCR attempt", async () => {
    vi.useFakeTimers();
    const browserPage = page();
    browserPage.waitForNavigation.mockResolvedValue(undefined);
    const evaluate = browserPage.evaluate.getMockImplementation()!;
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        if (
          String(fn).includes("setTimeout") &&
          String(fn).includes("doSubmit")
        ) {
          return undefined;
        }
        return evaluate(fn);
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("1234");

    const sync = createHncbConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    const rejected = expect(sync).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南登入後沒有取得明確回應，已停止重試，請稍後再試。",
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await rejected;
    expect(recognize).toHaveBeenCalledOnce();
    expect(puppeteerMock.launch).toHaveBeenCalledWith(expect.anything(), {
      keep_alive: 60_000,
    });
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("stops after credential rejection without retrying OCR", async () => {
    const browserPage = page();
    browserPage.waitForNavigation.mockResolvedValue(undefined);
    browserPage.evaluate.mockImplementation(
      async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("innerText")) return "使用者代號或密碼錯誤";
        return undefined;
      },
    );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("1234");

    await expect(
      createHncbConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(HncbCredentialRejectedError);
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("treats a blank login page as a connection error instead of captcha failure", async () => {
    const browserPage = page({ blankLoginPage: true });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("1234");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createHncbConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南登入頁沒有在期限內載入完整表單，請稍後再試。",
    });

    expect(recognize).not.toHaveBeenCalled();
    expect(browserPage.goto).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserPage.goto).toHaveBeenCalledWith(
      LOGIN_URL,
      expect.objectContaining({
        waitUntil: "domcontentloaded",
        timeout: 5_000,
      }),
    );
    const events = warn.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object"
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
    expect(events.some((event) => event.event === "hncb_navigation")).toBe(
      true,
    );
    expect(
      events.some((event) => event.event === "hncb_login_page_unavailable"),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.href === "about:blank" && event.hasUser === false,
      ),
    ).toBe(true);
    warn.mockRestore();
  });

  it("stops immediately on Chromium's failed login page", async () => {
    const browserPage = page({ errorPage: true });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn();

    await expect(
      createHncbConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南登入頁載入失敗，已停止重試，請稍後再試。",
    });
    expect(browserPage.goto).toHaveBeenCalledOnce();
    expect(browserPage.waitForFunction).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("does not let a stalled navigation consume the whole browser deadline", async () => {
    vi.useFakeTimers();
    const browserPage = page({ blankLoginPage: true, hangNavigation: true });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn();

    const sync = createHncbConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    const rejected = expect(sync).rejects.toMatchObject({
      name: "HncbConnectionError",
      message: "華南登入頁沒有在期限內載入完整表單，請稍後再試。",
    });
    await vi.advanceTimersByTimeAsync(7_000);
    await rejected;
    expect(recognize).not.toHaveBeenCalled();
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("throws when logged-in pages parse to empty data", async () => {
    const browserPage = page({ html: "<html><body>no accounts</body></html>" });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "hncb-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createHncbConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "hncb-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captcha: "1234",
      }),
    ).rejects.toBeInstanceOf(HncbConnectionError);
  });
});
