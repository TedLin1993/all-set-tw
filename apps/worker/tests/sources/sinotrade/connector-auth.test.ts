import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, Page } from "@cloudflare/puppeteer";
import type { SinotradeVerificationChallenge } from "@taiwan-fin-hub/shared";
import {
  fetchSinotradeSnapshot,
  signInSinotradeUnattended,
  querySinotradeSavings,
  querySinotradeSavingsTrades,
  readSinotradeNewwebSession,
  readSinotradeSavingsOverview,
} from "../../../src/sources/sinotrade/connector";
import {
  SINOTRADE_ORIGINS,
  SinotradeAuthenticationRequiredError,
  SinotradeConnectionError,
  SinotradeUnattendedLoginError,
  isSinotradeAuthenticationRequiredError,
} from "../../../src/sources/sinotrade/session-protocol";

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../../../src/sources/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/sources/browser")>()),
  launchBrowserWithRetry: browserMocks.launch,
  closeBrowserSession: browserMocks.close,
}));

const loginMocks = vi.hoisted(() => ({
  credentials: vi.fn(),
  verification: vi.fn(),
}));
vi.mock(
  "../../../src/sources/sinotrade/login-form",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../src/sources/sinotrade/login-form")
    >()),
    acknowledgeOfficialDialogs: vi.fn(),
    submitSinotradeCredentials: loginMocks.credentials,
    submitSinotradeVerification: loginMocks.verification,
  }),
);

const credentials = { userId: "A000000000", password: "fixture-password" };
const challenge = (
  step: SinotradeVerificationChallenge["step"],
  message?: string,
): SinotradeVerificationChallenge => ({
  step,
  fields: [],
  actions: step === "certificate" ? ["confirm_certificate"] : [],
  ...(message ? { message } : {}),
});

const account = {
  brokerNo: "9999",
  brokerAccount: "0000001",
  market: "TW" as const,
};

function response(status: number, payload: unknown = {}) {
  return {
    url: () => `${SINOTRADE_ORIGINS.savings}/API_Account/GetOverviewData`,
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

function overviewPage(options?: {
  afterGoto?: string;
  navigationStatus?: number;
  responseStatus?: number;
}) {
  let currentUrl =
    options?.afterGoto ?? `${SINOTRADE_ORIGINS.savings}/Account/Overview`;
  const networkResponse = response(options?.responseStatus ?? 200, {
    Data: {
      ActsData: [
        {
          AccType: "S",
          Broker: account.brokerNo,
          Act: account.brokerAccount,
        },
      ],
    },
  });
  const page = {
    url: () => currentUrl,
    waitForResponse: vi.fn(
      async (predicate: (value: unknown) => Promise<boolean>) => {
        // 被導覽取消的回應讀不到內容：不論先後到達都略過，繼續等讀得到的回應。
        const cancelled = response(200);
        cancelled.text.mockRejectedValue(new Error("Could not load body"));
        if (await predicate(cancelled))
          throw new Error("unreadable response accepted");
        if (!(await predicate(networkResponse)))
          throw new Error("unexpected response");
        return networkResponse;
      },
    ),
    goto: vi.fn(async () => {
      currentUrl = options?.afterGoto ?? currentUrl;
      return { status: () => options?.navigationStatus ?? 200 };
    }),
    $: vi.fn().mockResolvedValue({}),
  } as unknown as Page;
  return page;
}

describe("永豐證券登入恢復與豐存股 origin 邊界", () => {
  it("豐存股成交紀錄：拒絕錯誤 origin，非成交頁或查詢失敗不當成沒有交易，401 視為未登入", async () => {
    const wrongOrigin = {
      url: () => "https://evil.invalid/Account/Overview",
      evaluate: vi.fn(),
    } as unknown as Page;
    await expect(
      querySinotradeSavingsTrades(
        wrongOrigin,
        account,
        "2000/01/01 ~ 2027/01/01",
      ),
    ).rejects.toThrow(/origin 不符/);
    expect(wrongOrigin.evaluate).not.toHaveBeenCalled();

    const pageWith = (result: unknown) =>
      ({
        url: () => `${SINOTRADE_ORIGINS.savings}/Account/Overview`,
        evaluate: vi.fn().mockResolvedValue(result),
      }) as unknown as Page;
    const range = "2000/01/01 ~ 2027/01/01";
    // 頁面可辨識但沒有成交表格：沒有交易，不是錯誤。
    const empty = pageWith({ status: 200, recognized: true, table: null });
    await expect(
      querySinotradeSavingsTrades(empty, account, range),
    ).resolves.toEqual([]);
    expect(empty.evaluate).toHaveBeenCalledWith(expect.any(Function), {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: `${SINOTRADE_ORIGINS.savings}/Account/Transaction`,
      dateRange: range,
      timeoutMs: 20_000,
    });
    for (const result of [
      { status: 200, recognized: false, table: null },
      { status: 0 },
      { status: 500 },
    ])
      await expect(
        querySinotradeSavingsTrades(pageWith(result), account, range),
      ).rejects.toThrow(/成交紀錄查詢失敗/);
    await expect(
      querySinotradeSavingsTrades(pageWith({ status: 401 }), account, range),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("只有明確未登入錯誤才允許跨平台重新提交帳密", () => {
    expect(
      isSinotradeAuthenticationRequiredError(
        new SinotradeAuthenticationRequiredError(),
      ),
    ).toBe(true);
    expect(
      isSinotradeAuthenticationRequiredError(
        new SinotradeConnectionError("回應格式錯誤"),
      ),
    ).toBe(false);
    expect(isSinotradeAuthenticationRequiredError(new Error())).toBe(false);
  });

  it("新理財網沒有 token 視為未登入，帳戶資料格式錯誤則停止", async () => {
    const noToken = {
      evaluate: vi.fn().mockResolvedValue({ token: null, accounts: null }),
    } as unknown as Page;
    await expect(readSinotradeNewwebSession(noToken)).rejects.toBeInstanceOf(
      SinotradeAuthenticationRequiredError,
    );

    const malformed = {
      evaluate: vi.fn().mockResolvedValue({
        token: "fixture-token",
        accounts: "not-json",
      }),
    } as unknown as Page;
    await expect(readSinotradeNewwebSession(malformed)).rejects.toBeInstanceOf(
      SinotradeConnectionError,
    );
    await expect(
      readSinotradeNewwebSession(malformed),
    ).rejects.not.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("豐存股導向登入頁或 HTTP 401 才視為未登入，其他 HTTP 錯誤不重送帳密", async () => {
    await expect(
      readSinotradeSavingsOverview(
        overviewPage({ afterGoto: `${SINOTRADE_ORIGINS.savings}/Login` }),
      ),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);

    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 401 })),
    ).rejects.toBeInstanceOf(SinotradeAuthenticationRequiredError);

    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 500 })),
    ).rejects.toBeInstanceOf(SinotradeConnectionError);
    await expect(
      readSinotradeSavingsOverview(overviewPage({ responseStatus: 500 })),
    ).rejects.not.toBeInstanceOf(SinotradeAuthenticationRequiredError);
  });

  it("豐存股查詢拒絕錯誤 origin，並傳入固定絕對 Asset URL", async () => {
    const wrongOrigin = {
      url: () => "https://evil.invalid/Account/Overview",
      $$eval: vi.fn(),
      evaluate: vi.fn(),
    } as unknown as Page;
    await expect(querySinotradeSavings(wrongOrigin, account)).rejects.toThrow(
      /origin 不符/,
    );
    expect(wrongOrigin.$$eval).not.toHaveBeenCalled();
    expect(wrongOrigin.evaluate).not.toHaveBeenCalled();

    const evaluate = vi.fn().mockResolvedValue({ status: 200, html: null });
    const page = {
      url: () => `${SINOTRADE_ORIGINS.savings}/Account/Overview`,
      $$eval: vi
        .fn()
        .mockResolvedValue([{ value: account.brokerAccount, label: "台股" }]),
      evaluate,
    } as unknown as Page;
    await expect(querySinotradeSavings(page, account)).rejects.toThrow(
      /庫存查詢失敗/,
    );
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: `${SINOTRADE_ORIGINS.savings}/Account/Asset`,
      timeoutMs: 20_000,
    });
  });

  describe("同步時自動重新登入", () => {
    beforeEach(() => {
      loginMocks.credentials.mockReset();
      loginMocks.verification.mockReset();
      browserMocks.launch.mockReset();
      browserMocks.close.mockReset().mockResolvedValue(true);
    });
    const browser = {} as Browser;
    const storedState = {
      authenticated: true,
      cookies: [],
      localStorage: {},
      capturedAt: "2027-01-01T00:00:00.000Z",
    };
    const config = {
      ...credentials,
      webState: { newweb: storedState, savings: storedState },
    };
    const storedSession = {
      token: "fixture-token",
      accounts: JSON.stringify([
        {
          broker_id: account.brokerNo,
          account: account.brokerAccount,
          accttype: "S",
        },
      ]),
    };
    /** 新理財網分頁：`evaluate` 依序回應讀取登入狀態、清除舊 token 與官方 API。 */
    function newwebBrowser(evaluations: unknown[]) {
      const evaluate = vi.fn();
      for (const value of evaluations) evaluate.mockResolvedValueOnce(value);
      const page = {
        browser: () => fake,
        setUserAgent: vi.fn().mockResolvedValue(undefined),
        setViewport: vi.fn().mockResolvedValue(undefined),
        evaluateOnNewDocument: vi.fn().mockResolvedValue({ identifier: "1" }),
        removeScriptToEvaluateOnNewDocument: vi
          .fn()
          .mockResolvedValue(undefined),
        goto: vi.fn().mockResolvedValue(null),
        evaluate,
      };
      const fake = {
        userAgent: vi.fn().mockResolvedValue("HeadlessChrome/1"),
        on: vi.fn(),
        pages: vi.fn().mockResolvedValue([page]),
        newPage: vi
          .fn()
          .mockResolvedValueOnce(page)
          // 新理財網確認完成後才會開啟豐存股分頁。
          .mockRejectedValue(new Error("豐存股分頁")),
      };
      browserMocks.launch.mockResolvedValue(fake);
      return page;
    }

    it("只送出帳密一次並載入已存憑證；生日、OTP、條款或被拒絕時停止，不寄送也不同意", async () => {
      loginMocks.credentials.mockResolvedValue(challenge("certificate"));
      loginMocks.verification.mockResolvedValue(challenge("ready"));
      await signInSinotradeUnattended(browser, "savings", credentials);
      expect(loginMocks.credentials).toHaveBeenCalledOnce();
      expect(loginMocks.verification.mock.calls).toEqual([
        [
          browser,
          "savings",
          { action: "confirm_certificate", values: {} },
          credentials,
        ],
      ]);

      for (const step of ["birthday", "otp", "terms", "blocked"] as const) {
        loginMocks.credentials.mockReset().mockResolvedValue(challenge(step));
        loginMocks.verification.mockReset();
        await expect(
          signInSinotradeUnattended(browser, "savings", credentials),
        ).rejects.toMatchObject({
          name: "SinotradeUnattendedLoginError",
          platform: "savings",
          step,
        });
        expect(loginMocks.credentials).toHaveBeenCalledOnce();
        expect(loginMocks.verification).not.toHaveBeenCalled();
      }

      // 載入憑證後官方仍要求 OTP：只做過確認憑證這一個動作。
      loginMocks.credentials
        .mockReset()
        .mockResolvedValue(challenge("certificate"));
      loginMocks.verification.mockReset().mockResolvedValue(challenge("otp"));
      const failure = await signInSinotradeUnattended(
        browser,
        "newweb",
        credentials,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SinotradeUnattendedLoginError);
      expect((failure as Error).message).toContain("新理財網");
      expect(
        (failure as SinotradeUnattendedLoginError).toSyncError(),
      ).toMatchObject({
        code: "SINOTRADE_CONNECTION_REQUIRED",
        needsUserAction: true,
      });
      expect(loginMocks.verification).toHaveBeenCalledOnce();
      expect(loginMocks.verification.mock.calls[0]![2]).toEqual({
        action: "confirm_certificate",
        values: {},
      });
    });

    it("官方回應未登入才重新登入，登入後再確認一次才繼續查詢", async () => {
      const page = newwebBrowser([
        { token: null, accounts: null },
        undefined,
        storedSession,
        { httpStatus: 200, payload: { success: "True" } },
      ]);
      loginMocks.credentials.mockResolvedValue(challenge("ready"));
      await expect(
        fetchSinotradeSnapshot({ fetch: vi.fn() }, config),
      ).rejects.toThrow("豐存股分頁");
      expect(loginMocks.credentials).toHaveBeenCalledOnce();
      expect(loginMocks.credentials.mock.calls[0]!.slice(1)).toEqual([
        "newweb",
        config,
      ]);
      expect(page.evaluate).toHaveBeenCalledTimes(4);
      expect(browserMocks.close).toHaveBeenCalledOnce();
    });

    it("登入後官方仍回應未登入時停止，不再送第二次帳密", async () => {
      newwebBrowser([
        storedSession,
        { httpStatus: 401, payload: null },
        undefined,
        storedSession,
        { httpStatus: 401, payload: null },
      ]);
      loginMocks.credentials.mockResolvedValue(challenge("ready"));
      await expect(
        fetchSinotradeSnapshot({ fetch: vi.fn() }, config),
      ).rejects.toMatchObject({
        name: "SinotradeUnattendedLoginError",
        platform: "newweb",
        step: "not_authenticated",
      });
      expect(loginMocks.credentials).toHaveBeenCalledOnce();
    });

    it("權限或其他查詢錯誤不重送帳密", async () => {
      for (const httpStatus of [403, 500]) {
        loginMocks.credentials.mockReset();
        newwebBrowser([storedSession, { httpStatus, payload: null }]);
        const failure = await fetchSinotradeSnapshot(
          { fetch: vi.fn() },
          config,
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(SinotradeUnattendedLoginError);
        expect(loginMocks.credentials).not.toHaveBeenCalled();
      }
    });
  });

  it("同步超過 120 秒即停止並關閉 Browser，不空耗 Browser Run 額度", async () => {
    vi.useFakeTimers();
    try {
      // The official page never answers: the step would otherwise wait for the global limit.
      const browser = { newPage: vi.fn(() => new Promise(() => undefined)) };
      browserMocks.launch.mockResolvedValue(browser);
      browserMocks.close.mockReset().mockResolvedValue(true);
      const state = {
        authenticated: true,
        cookies: [],
        localStorage: {},
        capturedAt: "2027-01-01T00:00:00.000Z",
      };
      const sync = fetchSinotradeSnapshot(
        { fetch: vi.fn() },
        { webState: { newweb: state, savings: state } },
      );
      const outcome = expect(sync).rejects.toThrow(/超過 120 秒/);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(browserMocks.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(browserMocks.close).toHaveBeenCalledOnce();
      expect(browserMocks.close).toHaveBeenCalledWith(
        expect.anything(),
        browser,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
