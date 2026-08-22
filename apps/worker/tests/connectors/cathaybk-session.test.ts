import { describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  CathayOtpInvalidError,
  CathayOtpChannelRequiredError,
  CathayOtpRequiredError,
  CathayVerificationRequiredError,
  captureCathayTrustedState,
  completeCathayTrustedDeviceSetup,
  createCathaybkConnector,
  dismissCathaySystemMessageIfPresent,
  loginCathay,
  restoreCathayTrustedState,
  sendCathayOtp,
  scrapeCreditCards,
  submitCathayLoginForm,
  submitCathayOtp,
} from "../../src/connectors/cathaybk";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

function verificationPage() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation(async (fn: unknown) => {
      const source = String(fn);
      if (source.includes("hasInput")) {
        return { hasInput: true, hasSubmit: true };
      }
      if (source.includes("normalizedText")) return false;
      return undefined;
    }),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    url: vi
      .fn()
      .mockReturnValue("https://www.cathaybk.com.tw/MyBank/verification"),
  };
}

function browserForPage(page: ReturnType<typeof verificationPage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
    pages: vi.fn().mockResolvedValue([page]),
    sessionId: vi.fn().mockReturnValue("cathay-session"),
  };
}

describe("Cathay system message modal", () => {
  it("dismisses the visible login message before continuing", async () => {
    const dismissButton = {
      click: vi.fn().mockResolvedValue(undefined),
    };
    const page = {
      $: vi.fn().mockResolvedValue(dismissButton),
      waitForSelector: vi.fn().mockResolvedValue(null),
    };

    await expect(dismissCathaySystemMessageIfPresent(page)).resolves.toBe(true);

    expect(page.$).toHaveBeenCalledWith(
      "#divSystemLoginMsgList.show button.btn-fill",
    );
    expect(dismissButton.click).toHaveBeenCalledOnce();
    expect(page.waitForSelector).toHaveBeenCalledWith(
      "#divSystemLoginMsgList.show",
      { hidden: true, timeout: 5000 },
    );
  });

  it("does nothing when the login message is not visible", async () => {
    const page = {
      $: vi.fn().mockResolvedValue(null),
      waitForSelector: vi.fn(),
    };

    await expect(dismissCathaySystemMessageIfPresent(page)).resolves.toBe(
      false,
    );

    expect(page.waitForSelector).not.toHaveBeenCalled();
  });
});

describe("Cathay browser session lifecycle", () => {
  it("attempts to reconnect when the session list still has a connection id", async () => {
    const page = verificationPage();
    const browser = browserForPage(page);
    puppeteerMock.sessions.mockResolvedValueOnce([
      {
        sessionId: "cathay-session",
        connectionId: "stale-connection",
      },
    ]);
    puppeteerMock.connect.mockResolvedValueOnce(browser);

    await expect(
      createCathaybkConnector({} as Fetcher).sync({
        ...credentials,
        browserSessionId: "cathay-session",
        browserSessionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(CathayOtpChannelRequiredError);

    expect(puppeteerMock.connect).toHaveBeenCalledWith({}, "cathay-session");
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it.each([
    [
      "pages",
      (browser: ReturnType<typeof browserForPage>) => {
        browser.pages.mockRejectedValue(new Error("pages failed"));
      },
    ],
    [
      "newPage",
      (browser: ReturnType<typeof browserForPage>) => {
        browser.pages.mockResolvedValue([]);
        browser.newPage.mockRejectedValue(new Error("new page failed"));
      },
    ],
  ] as const)(
    "closes a launched browser when %s setup fails",
    async (_stage, fail) => {
      const page = verificationPage();
      const browser = browserForPage(page);
      fail(browser);
      puppeteerMock.launch.mockResolvedValueOnce(browser);

      await expect(
        createCathaybkConnector({} as Fetcher).sync(credentials),
      ).rejects.toThrow();

      expect(puppeteerMock.launch).toHaveBeenCalledWith(
        {},
        { keep_alive: 120_000 },
      );
      expect(browser.close).toHaveBeenCalledOnce();
      expect(browser.disconnect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "missing OTP channel",
      { browserSessionId: "cathay-session" },
      CathayOtpChannelRequiredError,
    ],
    [
      "missing OTP",
      { browserSessionId: "cathay-session", otpChannel: "email" as const },
      CathayOtpRequiredError,
    ],
    [
      "invalid OTP",
      {
        browserSessionId: "cathay-session",
        otpChannel: "email" as const,
        otp: "123456",
      },
      CathayOtpInvalidError,
    ],
  ] as const)(
    "disconnects instead of closing for %s",
    async (_stage, options, errorType) => {
      const page = verificationPage();
      const browser = browserForPage(page);
      puppeteerMock.sessions.mockResolvedValueOnce([
        { sessionId: "cathay-session" },
      ]);
      puppeteerMock.connect.mockResolvedValueOnce(browser);

      await expect(
        createCathaybkConnector({} as Fetcher).sync({
          ...credentials,
          ...options,
          browserSessionExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(errorType);

      expect(browser.disconnect).toHaveBeenCalledOnce();
      expect(browser.close).not.toHaveBeenCalled();
    },
  );
});

describe("Cathay login result", () => {
  it("invokes the bank login handler directly", async () => {
    const page = {
      click: vi.fn(),
      evaluate: vi.fn().mockResolvedValue(true),
    };

    await submitCathayLoginForm(page);

    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(page.click).not.toHaveBeenCalled();
  });

  it("falls back to clicking the login button when the handler is unavailable", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(false),
    };

    await submitCathayLoginForm(page);

    expect(page.click).toHaveBeenCalledWith(".js-login");
  });

  it("reports additional email or SMS verification without requiring a navigation event", async () => {
    const page = {
      $: vi.fn().mockResolvedValue(null),
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true),
      goto: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue(
          "https://www.cathaybk.com.tw/MyBank/Quicklinks/Home/NormalSignin",
        ),
      waitForNavigation: vi
        .fn()
        .mockRejectedValue(
          new Error("Navigation timeout of 60000 ms exceeded"),
        ),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
    };

    await expect(loginCathay(page, credentials)).rejects.toMatchObject({
      name: CathayVerificationRequiredError.name,
      message: "國泰世華要求 Email 或簡訊額外驗證，請先完成人工驗證。",
    });

    expect(page.click).not.toHaveBeenCalledWith(".js-login");
    expect(page.waitForNavigation).not.toHaveBeenCalled();
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 45000,
    });
  });

  it("logs only sanitized page state when the login result times out", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const page = {
      $: vi.fn().mockResolvedValue(null),
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          customerIdCleared: false,
          userIdCleared: true,
          passwordCleared: true,
          encryptedUserIdReady: true,
          encryptedPasswordReady: true,
          formMarkedSubmitting: true,
          hasVisibleValidation: false,
        }),
      goto: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue(
          "https://www.cathaybk.com.tw/MyBank/Quicklinks/Home/NormalSignin?token=secret",
        ),
      waitForFunction: vi
        .fn()
        .mockRejectedValue(new Error("Waiting failed: 45000ms exceeded")),
      waitForSelector: vi.fn().mockResolvedValue(null),
    };

    await expect(loginCathay(page, credentials)).rejects.toThrow(
      "Waiting failed: 45000ms exceeded",
    );

    const diagnostic = String(consoleError.mock.calls.at(-1)?.[0]);
    expect(diagnostic).toContain('"event":"cathaybk_login_wait_failed"');
    expect(diagnostic).toContain(
      '"currentUrl":"https://www.cathaybk.com.tw/MyBank/Quicklinks/Home/NormalSignin"',
    );
    expect(diagnostic).not.toContain("token=secret");
    expect(diagnostic).not.toContain(credentials.userId);
    expect(diagnostic).not.toContain(credentials.account);
    expect(diagnostic).not.toContain(credentials.password);

    const pageErrorHandler = page.on.mock.calls.find(
      ([event]) => event === "pageerror",
    )?.[1] as ((error: Error) => void) | undefined;
    expect(pageErrorHandler).toBeTypeOf("function");
    pageErrorHandler?.(
      new Error(
        `Login failed for ${credentials.account}/${credentials.password} at https://www.cathaybk.com.tw/MyBank/?token=secret`,
      ),
    );
    const pageErrorDiagnostic = String(consoleError.mock.calls.at(-1)?.[0]);
    expect(pageErrorDiagnostic).toContain('"event":"cathaybk_page_error"');
    expect(pageErrorDiagnostic).not.toContain("token=secret");
    expect(pageErrorDiagnostic).not.toContain(credentials.account);
    expect(pageErrorDiagnostic).not.toContain(credentials.password);
  });
});

describe("Cathay additional verification", () => {
  it.each([
    ["email", "#js-otp-email-send"],
    ["sms", "#js-otp-send"],
  ] as const)(
    "sends the %s OTP with the bank's dedicated control",
    async (channel, selector) => {
      const page = {
        click: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue(undefined),
        waitForSelector: vi.fn().mockResolvedValue(null),
      };

      await sendCathayOtp(page, channel);

      expect(page.waitForSelector).toHaveBeenNthCalledWith(1, selector, {
        visible: true,
        timeout: 15_000,
      });
      expect(page.click).toHaveBeenCalledWith(selector);
      expect(page.waitForSelector).toHaveBeenNthCalledWith(
        2,
        '.js-otp-view input:not([type="hidden"]), .login-otp input:not([type="hidden"]), input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="後6位數字"]',
        { timeout: 15_000 },
      );
    },
  );

  it("types a numeric OTP and submits the visible verification form", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          hasInput: true,
          hasSubmit: true,
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          hasNext: false,
          hasNameInput: false,
          hasConfirm: false,
          success: true,
        }),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue("https://www.cathaybk.com.tw/OnlineBanking/Home"),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };

    await submitCathayOtp(page, " 123456 ");

    expect(page.evaluate).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      "驗證|確認|確定|送出|登入",
    );
    expect(page.click).toHaveBeenNthCalledWith(
      1,
      '[data-cathay-otp-input="true"]',
      { clickCount: 3 },
    );
    expect(page.type).toHaveBeenCalledWith(
      '[data-cathay-otp-input="true"]',
      "123456",
    );
    expect(page.click).toHaveBeenNthCalledWith(
      2,
      '[data-cathay-otp-submit="true"]',
    );
  });

  it("strips the bank's English prefix before typing the OTP suffix", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ hasInput: true, hasSubmit: true })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          hasNext: false,
          hasNameInput: false,
          hasConfirm: false,
          success: true,
        }),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue("https://www.cathaybk.com.tw/OnlineBanking/Home"),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };

    await submitCathayOtp(page, "DAKY-310307");

    expect(page.type).toHaveBeenCalledWith(
      '[data-cathay-otp-input="true"]',
      "310307",
    );
  });

  it("rejects malformed OTP values before operating the bank page", async () => {
    const page = {
      click: vi.fn(),
      evaluate: vi.fn(),
      type: vi.fn(),
      url: vi.fn(),
      waitForFunction: vi.fn(),
      waitForNavigation: vi.fn(),
    };

    await expect(submitCathayOtp(page, "12AB")).rejects.toThrow(
      "請輸入驗證碼後 4 至 8 位數字；英文前綴可省略。",
    );
    await expect(submitCathayOtp(page, "12AB")).rejects.toBeInstanceOf(
      CathayOtpInvalidError,
    );
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("classifies a rejected bank OTP as retryable", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ hasInput: true, hasSubmit: true })
        .mockResolvedValueOnce(false),
      type: vi.fn().mockResolvedValue(undefined),
      url: vi
        .fn()
        .mockReturnValue("https://www.cathaybk.com.tw/OnlineBanking/"),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForNavigation: vi.fn().mockResolvedValue(undefined),
    };

    await expect(submitCathayOtp(page, "123456")).rejects.toBeInstanceOf(
      CathayOtpInvalidError,
    );
  });
});

describe("Cathay credit cards", () => {
  it("returns no card data when the overview has no card number", async () => {
    vi.useFakeTimers();
    const page = {
      evaluate: vi.fn().mockResolvedValue({
        cardDetected: false,
        last4: "",
        cardName: "國泰信用卡",
        creditLimit: 0,
        availableCredit: 0,
        unpaidAmount: 0,
        paymentDueDate: null,
        noPaymentNeeded: false,
      }),
      goto: vi.fn().mockResolvedValue(undefined),
    };

    try {
      const pending = scrapeCreditCards(
        page as unknown as Parameters<typeof scrapeCreditCards>[0],
      );
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual({
        bankAccounts: [],
        bankBalanceSnapshots: [],
        bankTransactions: [],
        creditCardBills: [],
      });
      expect(page.goto).toHaveBeenCalledOnce();
      expect(page.evaluate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Cathay trusted device state", () => {
  it("restores only the Cathay trusted-device cookie", async () => {
    const page = {
      setCookie: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      restoreCathayTrustedState(page, {
        sessionCookies: JSON.stringify([
          {
            name: "CUB.eBank.DeviceId",
            value: "device-1",
            domain: ".cathaybk.com.tw",
          },
          { name: "active-session", value: "no", domain: ".cathaybk.com.tw" },
          { name: "foreign", value: "no", domain: ".example.com" },
        ]),
      }),
    ).resolves.toBe(true);

    expect(page.setCookie).toHaveBeenCalledWith({
      name: "CUB.eBank.DeviceId",
      value: "device-1",
      domain: ".cathaybk.com.tw",
    });
  });

  it("captures encrypted cursor state without OTP fields", async () => {
    const page = {
      cookies: vi.fn().mockResolvedValue([
        {
          name: "CUB.eBank.DeviceId",
          value: "device-1",
          domain: ".cathaybk.com.tw",
          expires: 1_800_000_000,
        },
      ]),
    };

    await expect(captureCathayTrustedState(page)).resolves.toEqual({
      sessionCookies: JSON.stringify([
        {
          name: "CUB.eBank.DeviceId",
          value: "device-1",
          domain: ".cathaybk.com.tw",
          expires: 1_800_000_000,
        },
      ]),
      sessionExpiresAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
  });

  it("names and confirms a detected trusted-device setup step", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          hasNext: false,
          hasNameInput: true,
          hasConfirm: true,
          success: false,
        })
        .mockResolvedValueOnce(true),
      type: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    };

    await expect(completeCathayTrustedDeviceSetup(page)).resolves.toBe(true);
    expect(page.evaluate).toHaveBeenNthCalledWith(1, expect.any(Function), {
      context:
        "登入安全再升級|立即啟用|信任裝置|設定裝置名稱|裝置名稱|裝置暱稱|確定加入",
      confirm: "確定加入|確認加入|完成設定|^確定$|^確認$|^完成$",
    });
    expect(page.type).toHaveBeenCalledWith(
      '[data-cathay-trust-name="true"]',
      "ALL SET 同步",
    );
    expect(page.click).toHaveBeenLastCalledWith(
      '[data-cathay-trust-confirm="true"]',
    );
  });

  it("does not claim success when no trusted-device result is present", async () => {
    const page = {
      click: vi.fn(),
      evaluate: vi.fn().mockResolvedValue({
        hasNext: false,
        hasNameInput: false,
        hasConfirm: false,
        success: false,
      }),
      type: vi.fn(),
      waitForFunction: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    await expect(completeCathayTrustedDeviceSetup(page)).resolves.toBe(false);
    expect(page.click).not.toHaveBeenCalled();
  });
});
