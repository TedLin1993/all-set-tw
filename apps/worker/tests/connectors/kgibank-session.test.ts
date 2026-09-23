import { beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  createKgibankConnector,
  KgibankConnectionError,
  KgibankCredentialRejectedError,
  KgibankVerificationRequiredError,
} from "../../src/connectors/kgibank";

const credentials = {
  userId: "A123456789",
  account: "test-user",
  password: "test-password",
};

type LoginOutcome = "captcha" | "credential" | "success" | "unknown";
type CaptchaRenderer = "ionic" | "legacy";
type SubmitButtonState = "enabled" | "disabled" | "invalid-account" | "missing";

function browserScenario(
  outcomes: LoginOutcome[],
  captchaRenderer: CaptchaRenderer = "legacy",
  submitButtonState: SubmitButtonState = "enabled",
  submissionError?: Error,
) {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let submitCount = 0;
  let currentOutcome: LoginOutcome | undefined;

  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const request = (url: string, headers: Record<string, string> = {}) => ({
    url: () => url,
    headers: () => headers,
  });
  const response = (status: number, body: Record<string, unknown> = {}) => ({
    url: () => "https://ib.kgibank.com.tw/gateway/prod-oidc/connect/token",
    status: () => status,
    json: vi.fn().mockResolvedValue(body),
  });

  const frame = {
    url: () => "https://ib.kgibank.com.tw/internalbank/",
    $: vi.fn().mockResolvedValue({}),
    type: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi
      .fn()
      .mockImplementation(
        async (
          _fn: (...args: unknown[]) => unknown,
          _options: unknown,
          ...args: unknown[]
        ) => {
          const selectors = args.find(
            (value): value is { ionic: string; legacy: string } =>
              typeof value === "object" &&
              value !== null &&
              "ionic" in value &&
              "legacy" in value,
          );
          if (
            captchaRenderer === "ionic" &&
            selectors?.ionic !== "ion-img.recaptcha-image"
          ) {
            throw new Error("CAPTCHA selector did not reach Ionic host");
          }
        },
      ),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    evaluate: vi
      .fn()
      .mockImplementation(
        async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => {
          const source = String(fn);
          if (
            source.includes("setTimeout") &&
            source.includes("button.click")
          ) {
            if (submissionError) throw submissionError;
            const fields = {
              userId: {
                present: true,
                hasValue: true,
                valid: true,
                invalid: false,
              },
              account: {
                present: true,
                hasValue: true,
                valid: true,
                invalid: false,
              },
              password: {
                present: true,
                hasValue: true,
                valid: true,
                invalid: false,
              },
              captcha: {
                present: true,
                hasValue: true,
                valid: true,
                invalid: false,
              },
            };
            const buttonSelector = String(args[0] ?? "");
            if (
              submitButtonState === "missing" ||
              !buttonSelector.includes("button.btn.btn-primary.w-100")
            ) {
              return { found: false, disabled: false, fields };
            }
            if (submitButtonState === "disabled") {
              return { found: true, disabled: true, fields };
            }
            if (submitButtonState === "invalid-account") {
              fields.account.valid = false;
              fields.account.invalid = true;
              return { found: true, disabled: true, fields };
            }
            currentOutcome = outcomes[submitCount] ?? "captcha";
            submitCount += 1;
            if (currentOutcome === "credential") {
              emit(
                "request",
                request(
                  "https://ib.kgibank.com.tw/gateway/prod-oidc/connect/token",
                ),
              );
              emit("response", response(400, { error: "invalid_grant" }));
            }
            if (currentOutcome === "success") {
              emit(
                "request",
                request(
                  "https://ib.kgibank.com.tw/gateway/prod-oidc/connect/token",
                ),
              );
              emit("response", response(200));
              emit(
                "request",
                request(
                  "https://ib.kgibank.com.tw/gateway/prod-aggregators/api/bootstrap",
                  {
                    authorization: "Bearer test",
                    "ocp-apim-subscription-key": "subscription",
                  },
                ),
              );
            }
            return { found: true, disabled: false, fields };
          }
          if (source.includes("innerText")) {
            return currentOutcome === "captcha" ? "驗證碼有誤" : "";
          }
          const selectors = args.find(
            (value): value is { ionic: string; legacy: string } =>
              typeof value === "object" &&
              value !== null &&
              "ionic" in value &&
              "legacy" in value,
          );
          if (selectors?.legacy === 'img[src^="data:image"]') {
            if (
              captchaRenderer === "ionic" &&
              selectors.ionic !== "ion-img.recaptcha-image"
            ) {
              return "";
            }
            return "data:image/png;base64,AQID";
          }
          if (source.includes("fetch(url")) {
            const url = String(args[0]);
            if (url.includes("AcctQuery")) {
              return {
                status: 200,
                body: JSON.stringify({
                  items: [
                    {
                      acctNo: "00012345678901",
                      acctBal: 100,
                      availBal: 100,
                      acctTypeName: "活期儲蓄存款",
                    },
                  ],
                }),
              };
            }
            if (url.includes("TxnQuery")) {
              return { status: 200, body: JSON.stringify({ items: [] }) };
            }
            return { status: 200, body: "" };
          }
          return undefined;
        },
      ),
  };
  const page = {
    frames: vi.fn().mockReturnValue([frame]),
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi
      .fn()
      .mockImplementation(
        (event: string, listener: (value: unknown) => void) => {
          const eventListeners = listeners.get(event) ?? new Set();
          eventListeners.add(listener);
          listeners.set(event, eventListeners);
        },
      ),
    off: vi
      .fn()
      .mockImplementation(
        (event: string, listener: (value: unknown) => void) => {
          listeners.get(event)?.delete(listener);
        },
      ),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockResolvedValue([page]),
    newPage: vi.fn().mockResolvedValue(page),
  };
  return {
    browser,
    frame,
    page,
    get submitCount() {
      return submitCount;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMock.sessions.mockResolvedValue([]);
  puppeteerMock.limits.mockResolvedValue({
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

describe("KGI Bank automatic CAPTCHA login", () => {
  it("reads the current Ionic ion-img CAPTCHA host", async () => {
    const scenario = browserScenario(["success"], "ionic");
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");

    const result = await createKgibankConnector({} as Fetcher, recognize).sync(
      credentials,
    );

    expect(recognize).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "image/png",
      6,
    );
    expect(result.bankAccounts).toHaveLength(1);
    expect(scenario.frame.type).not.toHaveBeenCalled();
    expect(scenario.frame.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      "#loginInputIdNo",
      credentials.userId,
    );
    const submissionCallback = scenario.frame.evaluate.mock.calls.find(([fn]) =>
      String(fn).includes("button.click"),
    )?.[0];
    expect(String(submissionCallback)).not.toContain("fieldState");
    expect(String(submissionCallback)).not.toContain("__name");
  });

  it("loads a fresh CAPTCHA after rejection and succeeds on the next OCR attempt", async () => {
    const scenario = browserScenario(["captcha", "success"]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi
      .fn()
      .mockResolvedValueOnce("000000")
      .mockResolvedValueOnce("123456");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await createKgibankConnector(
        {} as Fetcher,
        recognize,
      ).sync(credentials);

      expect(recognize).toHaveBeenCalledTimes(2);
      expect(recognize).toHaveBeenCalledWith(
        expect.any(ArrayBuffer),
        "image/png",
        6,
      );
      expect(scenario.page.goto).toHaveBeenCalledTimes(2);
      expect(scenario.submitCount).toBe(2);
      expect(result.bankAccounts).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("stops immediately after credential rejection without retrying OCR", async () => {
    const scenario = browserScenario(["credential"]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");

    await expect(
      createKgibankConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toBeInstanceOf(KgibankCredentialRejectedError);

    expect(recognize).toHaveBeenCalledOnce();
    expect(scenario.submitCount).toBe(1);
    expect(scenario.page.goto).toHaveBeenCalledOnce();
  });

  it("falls back to user action after three rejected CAPTCHA images", async () => {
    const scenario = browserScenario(["captcha", "captcha", "captcha"]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        createKgibankConnector({} as Fetcher, recognize).sync(credentials),
      ).rejects.toMatchObject({
        name: KgibankVerificationRequiredError.name,
        message: expect.stringContaining("連續失敗 3 次"),
      });

      expect(recognize).toHaveBeenCalledTimes(3);
      expect(scenario.submitCount).toBe(3);
      expect(scenario.page.goto).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("loads a fresh CAPTCHA when Workers AI cannot read the image", async () => {
    const scenario = browserScenario(["success"]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi
      .fn()
      .mockRejectedValueOnce(new Error("unreadable image"))
      .mockRejectedValueOnce(new Error("invalid response"))
      .mockResolvedValueOnce("123456");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await createKgibankConnector(
        {} as Fetcher,
        recognize,
      ).sync(credentials);

      expect(recognize).toHaveBeenCalledTimes(3);
      expect(scenario.page.goto).toHaveBeenCalledTimes(3);
      expect(scenario.submitCount).toBe(1);
      expect(result.bankAccounts).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("starts a fresh automatic browser instead of reconnecting a prepared manual session", async () => {
    const scenario = browserScenario(["success"]);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "prepared-session", startTime: Date.now() },
    ]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");

    await createKgibankConnector({} as Fetcher, recognize).sync({
      ...credentials,
      browserSessionId: "prepared-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(puppeteerMock.launch).toHaveBeenCalledOnce();
    expect(puppeteerMock.connect).not.toHaveBeenCalled();
  });

  it("does not retry when submitting credentials throws", async () => {
    const scenario = browserScenario(
      ["unknown"],
      "legacy",
      "enabled",
      new Error("Protocol error after click"),
    );
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");

    await expect(
      createKgibankConnector({} as Fetcher, recognize).sync(credentials),
    ).rejects.toMatchObject({
      name: KgibankConnectionError.name,
      message: expect.stringContaining("登入送出狀態不明"),
    });

    expect(recognize).toHaveBeenCalledOnce();
    expect(scenario.page.goto).toHaveBeenCalledOnce();
  });

  it("does not resubmit credentials when the login result is unknown", async () => {
    vi.useFakeTimers();
    const scenario = browserScenario(["unknown"]);
    puppeteerMock.launch.mockResolvedValue(scenario.browser);
    const recognize = vi.fn().mockResolvedValue("123456");
    const sync = createKgibankConnector({} as Fetcher, recognize).sync(
      credentials,
    );
    const rejected = expect(sync).rejects.toBeInstanceOf(
      KgibankConnectionError,
    );

    try {
      await vi.advanceTimersByTimeAsync(26_000);
      await rejected;
      expect(recognize).toHaveBeenCalledOnce();
      expect(scenario.submitCount).toBe(1);
      expect(scenario.page.goto).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["missing", "沒有找到登入按鈕"],
    ["disabled", "登入表單尚未完成"],
    ["invalid-account", "未通過格式檢查（account）"],
  ] as const)(
    "stops before waiting when the submit button is %s",
    async (buttonState, message) => {
      const scenario = browserScenario(["unknown"], "legacy", buttonState);
      puppeteerMock.launch.mockResolvedValue(scenario.browser);
      const recognize = vi.fn().mockResolvedValue("123456");

      await expect(
        createKgibankConnector({} as Fetcher, recognize).sync(credentials),
      ).rejects.toThrow(message);

      expect(recognize).toHaveBeenCalledOnce();
      expect(scenario.submitCount).toBe(0);
    },
  );

  it("keeps the prepared manual CAPTCHA session as a fallback", async () => {
    const scenario = browserScenario(["success"]);
    puppeteerMock.sessions.mockResolvedValue([
      { sessionId: "kgibank-session", startTime: Date.now() },
    ]);
    puppeteerMock.connect.mockResolvedValue(scenario.browser);

    const result = await createKgibankConnector({} as Fetcher).sync({
      ...credentials,
      browserSessionId: "kgibank-session",
      browserSessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      captchaDigitCount: 6,
      captcha: "123456",
    });

    expect(puppeteerMock.connect).toHaveBeenCalledWith(
      expect.anything(),
      "kgibank-session",
    );
    expect(scenario.page.goto).not.toHaveBeenCalled();
    expect(scenario.submitCount).toBe(1);
    expect(result.bankAccounts).toHaveLength(1);
  });
});
