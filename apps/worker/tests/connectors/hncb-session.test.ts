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
}) {
  let currentUrl = options?.startLoggedIn ? PERSONAL_JSP : LOGIN_URL;
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
        if (source.includes("innerText")) return "";
        if (source.includes("doSubmit")) currentUrl = PERSONAL_JSP;
        return undefined;
      }),
    frames: vi
      .fn()
      .mockImplementation(() =>
        currentUrl.includes("personal") ? [frame] : [],
      ),
    goto: vi.fn().mockImplementation(async (url: string) => {
      currentUrl = url;
      if (options?.navigationTimeout) {
        throw new Error("Navigation timeout of 30000 ms exceeded");
      }
    }),
    off: vi.fn(),
    on: vi.fn(),
    setCookie: vi.fn().mockResolvedValue(undefined),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => currentUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
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
  it("disconnects after capturing CAPTCHA and stores the session id", async () => {
    const browserPage = page();
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await prepareHncbCaptcha({} as Fetcher, credentials);

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
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
        if (source.includes("doSubmit")) {
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
        if (source.includes("doSubmit")) sessionAlive = true;
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
        if (source.includes("doSubmit")) {
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
