import { beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  createTaishinConnector,
  prepareTaishinCaptcha,
  TaishinBrowserCapacityError,
  TaishinCaptchaRejectedError,
  TaishinConnectionError,
  TaishinCredentialRejectedError,
  TaishinSyncStageError,
} from "../../src/connectors/taishin";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

const selectors = {
  userId: 'input[data-taishin-field="user-id"]',
  account: 'input[data-taishin-field="account"]',
  password: 'input[data-taishin-field="password"]',
  captcha: 'input[data-taishin-field="captcha"]',
};

const captchaTarget = {
  selector: 'img[data-taishin-captcha="image"]',
  digitCount: 6,
};

const SECRET_PAGE_TEXT = "raw-secret-login-page";
const SECRET_SESSION_BODY = "raw-secret-session-body";
const SECRET_ERROR_MESSAGE = "raw-secret-error-message";

const manualUnknownCases = [
  {
    name: "HTTP 200 JSON without a session id",
    response: () => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        RESULT: "SUCCESS",
        diagnostic: SECRET_SESSION_BODY,
      }),
      timedOut: false,
      errorName: "",
      errorMessage: SECRET_ERROR_MESSAGE,
    }),
    sessionCheck: {
      httpStatus: 200,
      isJson: true,
      timedOut: false,
      validJson: true,
      hasApiError: false,
      expired: false,
      hasSessionId: false,
    },
  },
  {
    name: "HTTP 503 session check",
    response: () => ({
      ok: false,
      status: 503,
      contentType: "application/json",
      text: JSON.stringify({ error: SECRET_SESSION_BODY }),
      timedOut: false,
      errorName: "",
      errorMessage: SECRET_ERROR_MESSAGE,
    }),
    sessionCheck: {
      httpStatus: 503,
      isJson: true,
      timedOut: false,
      checkFailed: true,
    },
  },
] as const;

function page() {
  return {
    $: vi.fn().mockResolvedValue({
      screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }),
    click: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    cookies: vi
      .fn()
      .mockResolvedValue([
        { name: "SESSION", value: "fresh", domain: "my.taishinbank.com.tw" },
      ]),
    setCookie: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
  };
}

function browser(browserPage: ReturnType<typeof page>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([browserPage]),
    newPage: vi.fn().mockResolvedValue(browserPage),
    sessionId: vi.fn().mockReturnValue("taishin-session"),
  };
}

function rejectLoginSequence(
  browserPage: ReturnType<typeof page>,
  detail: string,
) {
  browserPage.evaluate
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(selectors)
    .mockResolvedValueOnce(captchaTarget)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(detail);
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

describe("Taishin browser session lifecycle", () => {
  it("labels an empty browser acquisition error", async () => {
    puppeteerMock.launch.mockRejectedValueOnce(new Error(""));

    await expect(
      createTaishinConnector({} as Fetcher).sync(credentials),
    ).rejects.toMatchObject({
      name: "TaishinSyncStageError",
      stage: "acquire_browser",
      message: "台新同步在啟動瀏覽器階段失敗。",
      cause: expect.any(Error),
    });
  });

  it("labels an empty runtime error with its sync stage", async () => {
    const browserPage = page();
    browserPage.setViewport.mockRejectedValueOnce(new Error(""));
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const error = await createTaishinConnector({} as Fetcher)
      .sync(credentials)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaishinSyncStageError);
    expect(error).toMatchObject({
      stage: "configure_browser_page",
      message: "台新同步在設定瀏覽器頁面階段失敗。",
      cause: expect.any(Error),
    });
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("does not turn a successful sync into failure when browser cleanup fails", async () => {
    const browserPage = page();
    const response = (value: unknown) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error: null }),
    });
    browserPage.evaluate
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({
          RESULT: "SUCCESS",
          DBSESSIONID: "database-session",
        }),
      })
      .mockResolvedValueOnce(response({ fmtRealTxListMap: [] }))
      .mockResolvedValueOnce(
        response({ "001": { "OUT-DTE-LST-STMT": "20260720" } }),
      )
      .mockResolvedValueOnce(response({}));
    const browserInstance = browser(browserPage);
    browserInstance.close.mockRejectedValueOnce(new Error(""));
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await createTaishinConnector({} as Fetcher).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "valid",
          domain: "my.taishinbank.com.tw",
        },
      ]),
    });

    expect(result.bankTransactions).toEqual([]);
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
      event: "taishin_browser_cleanup_failed",
      connectorId: "taishin",
      stage: "close_browser",
      errorName: "Error",
      message: "瀏覽器關閉失敗，但未取得錯誤原因。",
    });
    warn.mockRestore();
  });

  it("preserves the primary failure when browser cleanup also fails", async () => {
    const browserPage = page();
    browserPage.setViewport.mockRejectedValueOnce(new Error("primary failure"));
    const browserInstance = browser(browserPage);
    browserInstance.close.mockRejectedValueOnce(new Error("cleanup failure"));
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      createTaishinConnector({} as Fetcher).sync(credentials),
    ).rejects.toMatchObject({
      stage: "configure_browser_page",
      message: "台新同步在設定瀏覽器頁面階段失敗：primary failure",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("taishin_browser_cleanup_failed"),
    );
    warn.mockRestore();
  });

  it("reuses valid encrypted cookies without running OCR", async () => {
    const browserPage = page();
    const response = (value: unknown, error: unknown = null) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error }),
    });
    const activeSession = {
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        RESULT: "SUCCESS",
        DBSESSIONID: "database-session",
      }),
    };
    browserPage.evaluate
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValueOnce(response({ fmtRealTxListMap: [] }))
      .mockResolvedValueOnce(
        response(
          {
            "001": {
              "OUT-AVAIL-CREDIT": "100000",
              "OUT-STMT-BALANCE": "1200",
              "OUT-CRLIMIT-PERM": "200000",
              "OUT-DTE-LST-STMT": "20260720",
            },
          },
          "",
        ),
      )
      .mockResolvedValueOnce(
        response({
          showAccoutnYM: "2026/07",
          showCbalance: "1200",
          showCdue: "1200",
          newAcctDetailList: [],
        }),
      );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn();

    const result = await createTaishinConnector({} as Fetcher, recognize).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "encrypted-at-rest",
          domain: "my.taishinbank.com.tw",
        },
      ]),
    });

    expect(browserPage.setCookie).toHaveBeenCalledOnce();
    expect(recognize).not.toHaveBeenCalled();
    expect(result.bankAccounts).toHaveLength(1);
    expect(browserPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      path: "/TIBNetBank/svc/web4/rb0708rwd/qryRealTime",
      body: "",
      timeoutMs: 8_000,
    });
    expect(browserPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      path: "/TIBNetBank/svc/web4/rb0708rwd/doXTPA",
      body: {},
      timeoutMs: 4_000,
    });
    expect(browserPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      path: "/TIBNetBank/svc/web4/rb0760/getCardOverviewData",
      body: {},
      timeoutMs: 4_000,
    });
    expect(browserPage.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      path: "/TIBNetBank/svc/web4/rb0708rwd/init",
      body: {
        org: "001",
        byear: "2026",
        bmonth: "07",
        cardHolderFlagSelected: "1",
        cardNo: "",
      },
      timeoutMs: 4_000,
    });
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("re-authenticates once and skips history when no current bill exists", async () => {
    const browserPage = page();
    const response = (value: unknown) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error: null }),
    });
    const activeSession = {
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        RESULT: "SUCCESS",
        DBSESSIONID: "database-session",
      }),
    };
    browserPage.evaluate
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        contentType: "text/html",
        text: "登入",
      })
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(selectors)
      .mockResolvedValueOnce(captchaTarget)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("登入成功")
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValueOnce(response({ fmtRealTxListMap: [] }))
      .mockResolvedValueOnce(
        response({
          "001": { "OUT-DTE-LST-STMT": "20260720" },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("123456");

    const result = await createTaishinConnector({} as Fetcher, recognize).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "expired-during-fetch",
          domain: "my.taishinbank.com.tw",
        },
      ]),
    });

    const billCalls = browserPage.evaluate.mock.calls.filter(
      ([, input]) =>
        typeof input === "object" &&
        input !== null &&
        "path" in input &&
        input.path === "/TIBNetBank/svc/web4/rb0708rwd/init",
    );
    expect(recognize).toHaveBeenCalledOnce();
    expect(billCalls).toHaveLength(1);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(result.creditCardBills).toEqual([]);
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("keeps realtime transactions when the optional bill API fails", async () => {
    const browserPage = page();
    const response = (value: unknown, error: unknown = null) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error }),
    });
    browserPage.evaluate
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({
          RESULT: "SUCCESS",
          DBSESSIONID: "database-session",
        }),
      })
      .mockResolvedValueOnce(response({}, "系統忙碌中，無法取得資料。"))
      .mockResolvedValueOnce(response({}, "系統忙碌中，無法取得資料。"))
      .mockResolvedValueOnce(
        response({
          fmtRealTxListMap: [
            {
              cardname: "信用卡 (卡號末四碼:3108)",
              txlist: [
                ["2026/07/24", "12:30:00", "即時消費", "350", "TW", "成功"],
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          "001": { "OUT-DTE-LST-STMT": "20260720" },
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 504,
        contentType: "application/json",
        text: "{}",
      });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await createTaishinConnector({} as Fetcher).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "valid",
          domain: "my.taishinbank.com.tw",
        },
      ]),
    });

    const transactions = result.bankTransactions ?? [];
    const realtimeCalls = browserPage.evaluate.mock.calls.filter(
      ([, input]) =>
        typeof input === "object" &&
        input !== null &&
        "path" in input &&
        input.path === "/TIBNetBank/svc/web4/rb0708rwd/qryRealTime",
    );
    expect(realtimeCalls).toHaveLength(3);
    expect(realtimeCalls.map(([, input]) => input)).toEqual(
      Array.from({ length: 3 }, () => ({
        path: "/TIBNetBank/svc/web4/rb0708rwd/qryRealTime",
        body: "",
        timeoutMs: 8_000,
      })),
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      description: "即時消費",
      status: "pending",
    });
    expect(result.creditCardBills).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("optional bill sync skipped"),
    );
    warn.mockRestore();
  });

  it("retries a transient realtime fetch failure and keeps its diagnostics", async () => {
    const browserPage = page();
    const response = (value: unknown) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error: null }),
    });
    browserPage.evaluate
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        contentType: "application/json",
        text: JSON.stringify({
          RESULT: "SUCCESS",
          DBSESSIONID: "database-session",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 0,
        contentType: "",
        text: "",
        timedOut: false,
        errorName: "TypeError",
        errorMessage:
          "Failed to fetch https://my.taishinbank.com.tw/private-path",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        contentType: "application/json",
        text: "{}",
      })
      .mockResolvedValueOnce(response({ fmtRealTxListMap: [] }))
      .mockResolvedValueOnce(
        response({
          "001": { "OUT-DTE-LST-STMT": "20260720" },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await createTaishinConnector({} as Fetcher).sync({
      ...credentials,
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "valid",
          domain: "my.taishinbank.com.tw",
        },
      ]),
    });

    expect(warn).toHaveBeenCalledWith(
      "[taishin] realtime retry 1/3: 台新信用卡 API qryRealTime 網路請求失敗（TypeError: Failed to fetch [URL]）。",
    );
    expect(warn).toHaveBeenCalledWith(
      "[taishin] realtime retry 2/3: 台新信用卡 API qryRealTime 回應 HTTP 502。",
    );
    const realtimeCalls = browserPage.evaluate.mock.calls.filter(
      ([, input]) =>
        typeof input === "object" &&
        input !== null &&
        "path" in input &&
        input.path === "/TIBNetBank/svc/web4/rb0708rwd/qryRealTime",
    );
    expect(realtimeCalls).toHaveLength(3);
    warn.mockRestore();
  });

  it("returns fresh session cookies when an API fails after login", async () => {
    const browserPage = page();
    const activeSession = {
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        RESULT: "SUCCESS",
        DBSESSIONID: "database-session",
      }),
    };
    browserPage.evaluate
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValue({
        ok: false,
        status: 0,
        contentType: "",
        text: "",
        timedOut: false,
        errorName: "TypeError",
        errorMessage: "Failed to fetch",
      });
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const error = await createTaishinConnector({} as Fetcher)
      .sync({
        ...credentials,
        sessionCookies: JSON.stringify([
          {
            name: "SESSION",
            value: "expired",
            domain: "my.taishinbank.com.tw",
          },
        ]),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TaishinConnectionError);
    expect(error).toMatchObject({
      message:
        "台新信用卡 API qryRealTime 網路請求失敗（TypeError: Failed to fetch）。",
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "fresh",
          domain: "my.taishinbank.com.tw",
        },
      ]),
      sessionCreatedAt: expect.any(String),
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(
      browserPage.evaluate.mock.calls.filter(
        ([, input]) =>
          typeof input === "object" &&
          input !== null &&
          "path" in input &&
          input.path === "/TIBNetBank/svc/web4/rb0708rwd/qryRealTime",
      ),
    ).toHaveLength(3);
    expect(browserInstance.close).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reuses the same browser for manual CAPTCHA and disconnects it", async () => {
    const browserPage = page();
    browserPage.evaluate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(selectors)
      .mockResolvedValueOnce(captchaTarget);
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "taishin-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    const result = await prepareTaishinCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "taishin-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "taishin-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      browserSessionId: "taishin-session",
      captchaImage: "data:image/jpeg;base64,AQID",
      captchaDigitCount: 6,
    });
  });

  it("reopens the login page once when the CAPTCHA image is slow to load", async () => {
    const browserPage = page();
    browserPage.evaluate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(selectors)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(selectors)
      .mockResolvedValueOnce(captchaTarget);
    browserPage.waitForFunction
      .mockRejectedValueOnce(new Error("CAPTCHA image timeout"))
      .mockResolvedValueOnce(undefined);
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);

    const result = await prepareTaishinCaptcha({} as Fetcher, credentials);

    expect(browserPage.goto).toHaveBeenCalledTimes(2);
    expect(browserPage.waitForFunction).toHaveBeenCalledTimes(2);
    expect(result.captchaImage).toBe("data:image/jpeg;base64,AQID");
    expect(browserInstance.disconnect).toHaveBeenCalledOnce();
  });

  it("preserves the CAPTCHA page on reconnect and closes it after rejection", async () => {
    const browserPage = page();
    browserPage.evaluate
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("驗證碼錯誤");
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "taishin-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createTaishinConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "taishin-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captchaDigitCount: 6,
        captcha: "123456",
      }),
    ).rejects.toThrow("圖形驗證碼錯誤");

    // Reapplying mobile emulation on a reconnected Page triggers a reload.
    expect(browserPage.setViewport).not.toHaveBeenCalled();
    expect(browserPage.setUserAgent).not.toHaveBeenCalled();
    expect(browserPage.goto).not.toHaveBeenCalled();
    expect(browserInstance.close).toHaveBeenCalledOnce();
    expect(browserInstance.disconnect).not.toHaveBeenCalled();
  });

  it("clicks a visible div used as the login button", async () => {
    const browserPage = page();
    const loginButton = {
      tagName: "DIV",
      innerText: "登入網銀",
      hidden: false,
      title: "",
      dataset: {} as Record<string, string>,
      getAttribute: vi.fn().mockReturnValue(null),
      getBoundingClientRect: vi
        .fn()
        .mockReturnValue({ width: 300, height: 50 }),
      matches: vi.fn().mockReturnValue(false),
      click: vi.fn(),
    };
    browserPage.evaluate
      .mockImplementationOnce(async (callback: () => unknown) => {
        vi.stubGlobal("document", {
          querySelectorAll: vi.fn().mockReturnValue([loginButton]),
        });
        try {
          return callback();
        } finally {
          vi.unstubAllGlobals();
        }
      })
      .mockResolvedValueOnce("驗證碼錯誤");
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "taishin-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createTaishinConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "taishin-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captchaDigitCount: 6,
        captcha: "123456",
      }),
    ).rejects.toThrow("圖形驗證碼錯誤");

    expect(loginButton.dataset.taishinLogin).toBe("submit");
    expect(loginButton.click).toHaveBeenCalledOnce();
    expect(browserPage.click).not.toHaveBeenCalled();
  });

  it("prioritizes an active popup when rejecting a CAPTCHA", async () => {
    const browserPage = page();
    const popup = { innerText: "驗證碼輸入錯誤" };
    const querySelector = vi.fn().mockReturnValue(popup);
    const noisyBodyText = `${"x".repeat(2_000)}-footer`;
    browserPage.evaluate
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async (callback: () => unknown) => {
        vi.stubGlobal("document", {
          querySelector,
          body: { innerText: noisyBodyText },
        });
        try {
          return callback();
        } finally {
          vi.unstubAllGlobals();
        }
      });
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "taishin-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    await expect(
      createTaishinConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "taishin-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        captchaDigitCount: 6,
        captcha: "123456",
      }),
    ).rejects.toBeInstanceOf(TaishinCaptchaRejectedError);

    expect(querySelector).toHaveBeenCalledWith(".js-popup.active ._popup_text");
    expect(browserPage.evaluate).toHaveBeenCalledTimes(2);
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("records a safe manual login response diagnostic", async () => {
    const browserPage = page();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    type EventHandler = (payload: unknown) => void | Promise<void>;
    const handlers = new Map<string, Set<EventHandler>>();
    browserPage.on.mockImplementation(
      (event: string, handler: EventHandler) => {
        const eventHandlers = handlers.get(event) ?? new Set<EventHandler>();
        eventHandlers.add(handler);
        handlers.set(event, eventHandlers);
        return browserPage;
      },
    );
    browserPage.off.mockImplementation(
      (event: string, handler: EventHandler) => {
        handlers.get(event)?.delete(handler);
        return browserPage;
      },
    );
    const emit = async (event: string, payload: unknown) => {
      await Promise.all(
        [...(handlers.get(event) ?? [])].map((handler) =>
          Promise.resolve(handler(payload)),
        ),
      );
    };
    const loginUrl =
      "https://my.taishinbank.com.tw/TIBNetBank/svc/web/login/login";
    const loginRequest = { url: vi.fn().mockReturnValue(loginUrl) };
    const loginResponse = {
      url: vi.fn().mockReturnValue(loginUrl),
      status: vi.fn().mockReturnValue(200),
      json: vi.fn().mockResolvedValue({
        RESULT: "FAIL",
        STATUS: "A",
        ERRORMSG: "private-body",
        TOKEN: "secret-token",
      }),
    };
    let clickEvents: Promise<void> | undefined;
    const loginButton = {
      tagName: "BUTTON",
      innerText: "登入網銀",
      hidden: false,
      title: "",
      dataset: {} as Record<string, string>,
      getAttribute: vi.fn().mockReturnValue(null),
      getBoundingClientRect: vi
        .fn()
        .mockReturnValue({ width: 300, height: 50 }),
      matches: vi.fn().mockReturnValue(true),
      click: vi.fn(() => {
        clickEvents = Promise.all([
          emit("request", loginRequest),
          emit("response", loginResponse),
        ]).then(() => undefined);
      }),
    };
    browserPage.evaluate
      .mockImplementationOnce(async (callback: () => unknown) => {
        vi.stubGlobal("document", {
          querySelectorAll: vi.fn().mockReturnValue([loginButton]),
        });
        try {
          const result = callback();
          if (clickEvents) await clickEvents;
          return result;
        } finally {
          vi.unstubAllGlobals();
        }
      })
      .mockResolvedValueOnce("驗證碼輸入錯誤");
    const browserInstance = browser(browserPage);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "taishin-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browserInstance);

    try {
      await expect(
        createTaishinConnector({} as Fetcher).sync({
          ...credentials,
          browserSessionId: "taishin-session",
          browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          captchaDigitCount: 6,
          captcha: "123456",
        }),
      ).rejects.toBeInstanceOf(TaishinCaptchaRejectedError);

      expect(browserPage.on).toHaveBeenCalledWith(
        "request",
        expect.any(Function),
      );
      expect(browserPage.on).toHaveBeenCalledWith(
        "response",
        expect.any(Function),
      );
      expect(browserPage.off).toHaveBeenCalledWith(
        "request",
        expect.any(Function),
      );
      expect(browserPage.off).toHaveBeenCalledWith(
        "response",
        expect.any(Function),
      );
      expect(loginRequest.url).toHaveBeenCalledOnce();
      expect(loginResponse.url).toHaveBeenCalledOnce();
      expect(loginResponse.status).toHaveBeenCalledOnce();
      expect(loginResponse.json).toHaveBeenCalledOnce();

      const diagnostic = warn.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((value) => value.event === "taishin_login_response");
      expect(diagnostic).toMatchObject({
        event: "taishin_login_response",
        mode: "manual",
        httpStatus: 200,
        validJson: true,
        result: "FAIL",
        status: "A",
        hasErrorMessage: true,
      });
      const serialized = JSON.stringify(warn.mock.calls);
      for (const secret of [
        "private-body",
        "secret-token",
        credentials.userId,
        credentials.account,
        credentials.password,
        "123456",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it.each(manualUnknownCases)(
    "reports a safe manual unknown outcome after ten session checks ($name)",
    async ({ response, sessionCheck }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        const browserPage = page();
        browserPage.evaluate
          .mockResolvedValueOnce(true)
          .mockImplementation((_callback, input?: { path?: string }) =>
            Promise.resolve(input?.path ? response() : SECRET_PAGE_TEXT),
          );
        const browserInstance = browser(browserPage);
        puppeteerMock.sessions.mockResolvedValue([
          { sessionId: "taishin-session", startTime: Date.now() },
        ]);
        puppeteerMock.connect.mockResolvedValue(browserInstance);

        const pending = createTaishinConnector({} as Fetcher).sync({
          ...credentials,
          browserSessionId: "taishin-session",
          browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          captchaDigitCount: 6,
          captcha: "123456",
        });
        const rejected = expect(pending).rejects.toMatchObject({
          name: "TaishinLoginOutcomeUnknownError",
          message:
            "台新人工驗證已送出，但尚未確認登入成功，請稍後重新取得驗證碼再試。",
        });
        await vi.runAllTimersAsync();
        await rejected;

        expect(warn).toHaveBeenCalledTimes(1);
        const diagnostic = JSON.parse(String(warn.mock.calls[0]?.[0]));
        expect(diagnostic).toMatchObject({
          event: "taishin_login_outcome_unknown",
          mode: "manual",
          attempts: 10,
          elapsedMs: expect.any(Number),
          sessionChecks: Array.from({ length: 10 }, () => sessionCheck),
        });
        const serialized = String(warn.mock.calls[0]?.[0]);
        expect(serialized).not.toContain(SECRET_PAGE_TEXT);
        expect(serialized).not.toContain(SECRET_SESSION_BODY);
        expect(serialized).not.toContain(SECRET_ERROR_MESSAGE);
        expect(browserInstance.close).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("accepts a valid bank session without relying on account overview text", async () => {
    const browserPage = page();
    const activeSession = {
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({
        RESULT: "SUCCESS",
        DBSESSIONID: "database-session",
      }),
    };
    const response = (value: unknown) => ({
      ok: true,
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ value, error: null }),
    });
    browserPage.evaluate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(selectors)
      .mockResolvedValueOnce(captchaTarget)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("登入成功")
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValueOnce(response({ fmtRealTxListMap: [] }))
      .mockResolvedValueOnce(
        response({
          "001": {
            "OUT-AVAIL-CREDIT": "100000",
            "OUT-STMT-BALANCE": "1200",
            "OUT-CRLIMIT-PERM": "200000",
            "OUT-DTE-LST-STMT": "20260720",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          showAccoutnYM: "2026/07",
          showCbalance: "1200",
          showCdue: "1200",
          newAcctDetailList: [],
        }),
      );
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("123456");

    const result = await createTaishinConnector({} as Fetcher, recognize).sync({
      ...credentials,
    });

    expect(result.bankAccounts).toHaveLength(1);
    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("stops automatic login immediately when credentials are rejected", async () => {
    const browserPage = page();
    rejectLoginSequence(browserPage, "使用者密碼錯誤");
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("123456");

    await expect(
      createTaishinConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(TaishinCredentialRejectedError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("tries three fresh CAPTCHAs before requiring manual verification", async () => {
    const browserPage = page();
    rejectLoginSequence(browserPage, "驗證碼錯誤");
    rejectLoginSequence(browserPage, "驗證碼錯誤");
    rejectLoginSequence(browserPage, "驗證碼錯誤");
    const browserInstance = browser(browserPage);
    puppeteerMock.launch.mockResolvedValue(browserInstance);
    const recognize = vi.fn().mockResolvedValue("123456");

    await expect(
      createTaishinConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toThrow("連續失敗 3 次");

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(browserPage.goto).toHaveBeenCalledTimes(3);
    expect(browserInstance.close).toHaveBeenCalledOnce();
  });

  it("maps Browser Rendering capacity limits to a typed retryable error", async () => {
    puppeteerMock.limits.mockResolvedValue({
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 20_000,
    });

    await expect(
      prepareTaishinCaptcha({} as Fetcher, credentials),
    ).rejects.toBeInstanceOf(TaishinBrowserCapacityError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });
});
