import { beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));
const jpegMock = vi.hoisted(() => ({
  decode: vi.fn(() => ({
    width: 1,
    height: 1,
    data: new Uint8Array([0, 0, 0, 255]),
  })),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));
vi.mock("jpeg-js", () => jpegMock);

import {
  createSinopacConnector,
  loginSinopacWithOcr,
  prepareSinopacCaptcha,
  SinopacBrowserCapacityError,
  SinopacCredentialRejectedError,
  SinopacVerificationRequiredError,
} from "../../src/connectors/sinopac";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

function captchaPage() {
  return {
    $: vi.fn().mockResolvedValue({
      screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }),
    goto: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi
      .fn()
      .mockReturnValue(
        "https://m.sinopac.com/m/member/login/m_login.aspx?RequestTrans=MobileCard",
      ),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

function automaticLoginPage() {
  return {
    $: vi.fn().mockResolvedValue({
      screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }),
    click: vi.fn().mockResolvedValue(undefined),
    cookies: vi
      .fn()
      .mockResolvedValue([
        { name: "ASP.NET_SessionId", value: "fresh-session" },
      ]),
    evaluate: vi.fn().mockResolvedValue(false),
    goto: vi.fn().mockResolvedValue(undefined),
    off: vi.fn(),
    once: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi
      .fn()
      .mockReturnValue(
        "https://m.sinopac.com/m/member/login/m_login.aspx?RequestTrans=MobileCard",
      ),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

function launchedBrowser(page: ReturnType<typeof automaticLoginPage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    pages: vi.fn().mockResolvedValue([page]),
    sessionId: vi.fn().mockReturnValue("auto-session"),
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

describe("sinopac browser session lifecycle", () => {
  it("requires one-time verification before acquiring a browser when no bank cookies exist", async () => {
    await expect(
      createSinopacConnector({} as Fetcher).sync(credentials),
    ).rejects.toBeInstanceOf(SinopacVerificationRequiredError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("reuses the exact pending captcha browser instead of launching another one", async () => {
    const page = captchaPage();
    const browser = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      pages: vi.fn().mockResolvedValue([page]),
      sessionId: vi.fn().mockReturnValue("pending-session"),
    };
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "pending-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(browser);

    const result = await prepareSinopacCaptcha({} as Fetcher, {
      ...credentials,
      browserSessionId: "pending-session",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "pending-session");
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(result.browserSessionId).toBe("pending-session");
    expect(result.captchaImage).toBe("data:image/jpeg;base64,AQID");
  });

  it("closes a submitted CAPTCHA browser when verification fails", async () => {
    const page = {
      type: vi.fn().mockRejectedValue(new Error("invalid captcha")),
      url: vi
        .fn()
        .mockReturnValue(
          "https://m.sinopac.com/m/member/login/m_login.aspx?RequestTrans=MobileCard",
        ),
    };
    const browser = {
      close: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      pages: vi.fn().mockResolvedValue([page]),
    };
    puppeteerMock.connect.mockResolvedValue(browser);

    await expect(
      createSinopacConnector({} as Fetcher).sync({
        ...credentials,
        captcha: "123456",
        browserSessionId: "pending-session",
        browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(SinopacVerificationRequiredError);

    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.disconnect).not.toHaveBeenCalled();
  });

  it("does not launch when the pending captcha browser is still connected", async () => {
    puppeteerMock.sessions.mockResolvedValue([
      {
        sessionId: "pending-session",
        startTime: Date.now(),
        connectionId: "busy-connection",
      },
    ]);

    await expect(
      prepareSinopacCaptcha({} as Fetcher, {
        ...credentials,
        browserSessionId: "pending-session",
      }),
    ).rejects.toBeInstanceOf(SinopacBrowserCapacityError);
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });

  it("returns a typed capacity error before launch when acquisition is rate limited", async () => {
    puppeteerMock.limits.mockResolvedValue({
      activeSessions: [],
      maxConcurrentSessions: 3,
      allowedBrowserAcquisitions: 0,
      timeUntilNextAllowedBrowserAcquisition: 20_000,
    });

    await expect(
      prepareSinopacCaptcha({} as Fetcher, credentials),
    ).rejects.toMatchObject({
      name: "SinopacBrowserCapacityError",
      retryAfterSeconds: 20,
    });
    expect(puppeteerMock.launch).not.toHaveBeenCalled();
  });
});

describe("sinopac Gemma automatic login", () => {
  it("uses a fresh captcha for each recognition failure and can succeed on attempt three", async () => {
    const page = automaticLoginPage();
    const browser = launchedBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi
      .fn()
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValueOnce("not-six-digits")
      .mockResolvedValueOnce("575831");

    await expect(
      loginSinopacWithOcr({} as Fetcher, credentials, recognize),
    ).resolves.toEqual({
      sessionCookies: JSON.stringify([
        { name: "ASP.NET_SessionId", value: "fresh-session" },
      ]),
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(page.click).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("stops after three failed captcha attempts", async () => {
    const page = automaticLoginPage();
    const browser = launchedBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi.fn().mockResolvedValue("invalid");

    await expect(
      loginSinopacWithOcr({} as Fetcher, credentials, recognize),
    ).rejects.toThrow("連續失敗 3 次");

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("reloads a new captcha after bank rejection and succeeds on attempt three", async () => {
    const page = automaticLoginPage();
    page.evaluate
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("驗證碼錯誤")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce("驗證碼有誤")
      .mockResolvedValueOnce(false);
    const browser = launchedBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi.fn().mockResolvedValue("575831");

    await expect(
      loginSinopacWithOcr({} as Fetcher, credentials, recognize),
    ).resolves.toMatchObject({
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(recognize).toHaveBeenCalledTimes(3);
    expect(page.goto).toHaveBeenCalledTimes(3);
    expect(page.click).toHaveBeenCalledTimes(3);
  });

  it("does not retry when the bank explicitly rejects the credentials", async () => {
    const page = automaticLoginPage();
    page.evaluate.mockResolvedValueOnce(true).mockResolvedValueOnce("密碼錯誤");
    const browser = launchedBrowser(page);
    puppeteerMock.launch.mockResolvedValue(browser);
    const recognize = vi.fn().mockResolvedValue("575831");

    await expect(
      loginSinopacWithOcr({} as Fetcher, credentials, recognize),
    ).rejects.toBeInstanceOf(SinopacCredentialRejectedError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
