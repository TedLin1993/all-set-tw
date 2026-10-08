import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import {
  BrowserRunCapacityError,
  BrowserSessionCleanupError,
  prepareBrowserLoginWithRetry,
} from "../../src/sources/browser";

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn(), limits: vi.fn() },
}));

function browserSession(id: string) {
  return {
    sessionId: () => id,
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
  } as unknown as Browser;
}

function diagnosticPage(maintenance = false) {
  const listeners = new Map<string, (value: unknown) => void>();
  const send = vi.fn(async (method: string) =>
    method === "Page.getFrameTree"
      ? {
          frameTree: {
            frame: {
              url: "https://bank.example/login?token=private-token#secret",
            },
          },
        }
      : { result: { value: maintenance } },
  );
  const detach = vi.fn().mockResolvedValue(undefined);
  const page = {
    url: () => "https://bank.example/login?token=private-token#secret",
    on: (event: string, handler: (value: unknown) => void) =>
      listeners.set(event, handler),
    off: (event: string) => listeners.delete(event),
    createCDPSession: vi.fn().mockResolvedValue({ send, detach }),
  } as unknown as Page;
  return { page, listeners, send };
}

const allowed = {
  allowedBrowserAcquisitions: 1,
  timeUntilNextAllowedBrowserAcquisition: 0,
  activeSessions: [],
  maxConcurrentSessions: 2,
};

describe("Browser Run 登入前復原與用量限制", () => {
  let binding: Parameters<typeof prepareBrowserLoginWithRetry>[0]["binding"];
  let fetch: ReturnType<typeof vi.fn>;

  // Exercise the binding fetch wrapper, including headers discarded by the SDK.
  function acquireFromResponses(responses: Response[]) {
    let sessions = 0;
    vi.mocked(puppeteer.launch).mockImplementation(async (wrappedBinding) => {
      const response = await wrappedBinding.fetch(
        "https://fake.host/v1/devtools/browser?keep_alive=60000",
        { method: "POST" },
      );
      const body = await response.text();
      if (response.status !== 200)
        throw new Error(
          `Unable to create new browser: code: ${response.status}: message: ${body}`,
        );
      return browserSession(`session-${++sessions}`);
    });
    fetch.mockImplementation(
      async (input: Request | string, init?: RequestInit) => {
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method === "DELETE") return new Response(null, { status: 200 });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected browser acquisition");
        return response;
      },
    );
  }

  function logEntries(event: string) {
    return vi
      .mocked(console.warn)
      .mock.calls.map(([value]) => JSON.parse(String(value)))
      .filter((entry) => entry.event === event);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    binding = { fetch } as unknown as typeof binding;
    vi.mocked(puppeteer.limits).mockResolvedValue(allowed);
    vi.mocked(puppeteer.launch).mockImplementation(async () =>
      browserSession("fresh-session"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("準備成功只開一次，保留該 session 給後續登入", async () => {
    const prepare = vi.fn().mockResolvedValue({ captcha: "prepared-image" });
    const result = await prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    expect(result.value).toEqual({ captcha: "prepared-image" });
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(result.browser.close).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("準備花四十秒仍可成功，不會在十五秒時重開", async () => {
    const prepare = vi.fn(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("ready"), 40_000),
        ),
    );
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(pending).resolves.toMatchObject({ value: "ready" });
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("遠端確認關閉前不開下一個 session，診斷移除敏感內容", async () => {
    const first = browserSession("first-session");
    const second = browserSession("second-session");
    vi.mocked(first.close).mockRejectedValue(new Error("CDP unresponsive"));
    vi.mocked(puppeteer.launch)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    let confirmClose: (() => void) | undefined;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          confirmClose = () => resolve(new Response(null, { status: 200 }));
        }),
    );
    const { page, listeners } = diagnosticPage();
    let attempts = 0;
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: async (
        _browser,
        observePage,
        _signal,
        _attempt,
        reportStage,
      ) => {
        if (++attempts > 1) return "ready";
        reportStage("restore_session");
        observePage(page);
        listeners.get("requestfailed")?.({
          url: () =>
            "https://user:private-password@bank.example/login?cookie=private-cookie",
          failure: () => ({
            errorText: "net::ERR_CONNECTION_RESET private-token",
          }),
        });
        listeners.get("response")?.({
          url: () => "https://bank.example/login?password=private-password",
          status: () => 503,
        });
        throw new Error("net::ERR_CONNECTION_RESET private-password");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    confirmClose!();
    await expect(pending).resolves.toMatchObject({
      browser: second,
      value: "ready",
    });
    const log = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(log).toContain("bank.example/login");
    expect(log).toContain("net::ERR_CONNECTION_RESET");
    expect(log).toContain('\\"cdpResponsive\\":true');
    expect(log).not.toMatch(/private-|token=|cookie=|password=|#secret/);
    expect(logEntries("browser_login_preparation_failed")[0]).toMatchObject({
      stage: "restore_session",
      timeoutSource: null,
      totalElapsedMs: 0,
    });
    expect(listeners.size).toBe(0);
  });

  it("停滯最多三次、每次六十秒；每次失敗都關閉 session", async () => {
    const sessions: Browser[] = [];
    vi.mocked(puppeteer.launch).mockImplementation(async () => {
      const session = browserSession(`session-${sessions.length}`);
      sessions.push(session);
      return session;
    });
    const prepare = vi.fn(() => new Promise<never>(() => {}));
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(180_000);
    await failed;
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(puppeteer.launch).toHaveBeenCalledTimes(3);
    for (const session of sessions)
      expect(session.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logEntries("browser_login_preparation_failed")[0]).toMatchObject({
      stage: "initialize_page",
      timeoutSource: "page_preparation",
      preparationElapsedMs: 60_000,
      totalElapsedMs: 60_000,
    });
  });

  it.each(["timeout", "http_error"])(
    "清理無法確認時停止重開（%s）",
    async (mode) => {
      if (mode === "timeout") {
        fetch.mockImplementation(() => new Promise<never>(() => {}));
      } else {
        fetch.mockResolvedValue(new Response(null, { status: 503 }));
      }
      const prepare = vi
        .fn()
        .mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
      const pending = prepareBrowserLoginWithRetry({
        binding,
        connectorId: "bank",
        prepare,
      });
      const failed = expect(pending).rejects.toBeInstanceOf(
        BrowserSessionCleanupError,
      );
      await vi.advanceTimersByTimeAsync(4_000);
      await failed;
      expect(puppeteer.launch).toHaveBeenCalledOnce();
    },
  );

  it("沿用來源固定期限，第二輪不重設剩餘時間", async () => {
    const deadline = Date.now() + 20_000;
    const prepare = vi.fn(
      async (_browser, _observePage, _signal, attempt, reportStage) => {
        reportStage("captcha");
        if (attempt === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
          throw new Error("net::ERR_CONNECTION_RESET");
        }
        return new Promise<never>(() => {});
      },
    );
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      remainingMs: () => deadline - Date.now(),
      prepare,
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logEntries("browser_login_preparation_failed")[1]).toMatchObject({
      stage: "captcha",
      timeoutSource: "connector_deadline",
      preparationElapsedMs: 15_000,
      totalElapsedMs: 20_000,
    });
  });

  it("限流等待占用一百八十秒總預算，最後一輪只用剩餘四十秒", async () => {
    vi.mocked(puppeteer.limits)
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce({
        ...allowed,
        allowedBrowserAcquisitions: 0,
        timeUntilNextAllowedBrowserAcquisition: 20_000,
      });
    const prepare = vi.fn(() => new Promise<never>(() => {}));
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(180_000);
    await failed;
    expect(puppeteer.launch).toHaveBeenCalledTimes(3);
    expect(logEntries("browser_login_preparation_failed")[2]).toMatchObject({
      timeoutSource: "shared_budget",
      preparationElapsedMs: 40_000,
      totalElapsedMs: 180_000,
    });
  });

  it("查詢額度逾時只等十五秒，不會開始未知額度的 acquisition", async () => {
    vi.mocked(puppeteer.limits).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: vi.fn(),
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(puppeteer.launch).not.toHaveBeenCalled();
    expect(logEntries("browser_login_acquisition_failed")[0]).toMatchObject({
      timeoutSource: "limits_lookup",
    });
  });

  it("CDP 診斷不回應時只等一秒，之後關閉並重試", async () => {
    const { page, send } = diagnosticPage();
    send.mockImplementation(() => new Promise<never>(() => {}));
    let attempts = 0;
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: async (_browser, observePage) => {
        if (++attempts > 1) return "ready";
        observePage(page);
        throw new Error("net::ERR_CONNECTION_RESET");
      },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ value: "ready" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  it("取得瀏覽器逾時不再啟動，遲到的 session 仍會清理", async () => {
    let finishAcquisition: ((browser: Browser) => void) | undefined;
    vi.mocked(puppeteer.launch).mockImplementation(
      () =>
        new Promise<Browser>((resolve) => {
          finishAcquisition = resolve;
        }),
    );
    const prepare = vi.fn();
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    const late = browserSession("late-session");
    finishAcquisition!(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(logEntries("browser_login_acquisition_failed")[0]).toMatchObject({
      timeoutSource: "browser_acquisition",
    });
  });

  it("分頁已消失、診斷讀取失敗時仍須關閉遠端 session", async () => {
    const { page } = diagnosticPage();
    page.url = () => {
      throw new Error("Requesting main frame too early");
    };
    let attempts = 0;
    const result = await prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: async (_browser, observePage) => {
        if (++attempts > 1) return "ready";
        observePage(page);
        throw Object.assign(new Error("Target closed"), {
          name: "TargetCloseError",
        });
      },
    });
    expect(result.value).toBe("ready");
    expect(fetch).toHaveBeenCalledOnce();
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  it("舊 session 關閉後等待限流，醒來重新檢查，額度仍不足就繼續等", async () => {
    vi.mocked(puppeteer.limits)
      .mockResolvedValueOnce(allowed)
      .mockResolvedValueOnce({
        ...allowed,
        allowedBrowserAcquisitions: 0,
        timeUntilNextAllowedBrowserAcquisition: 20_000,
      })
      .mockResolvedValueOnce({
        ...allowed,
        allowedBrowserAcquisitions: 0,
        timeUntilNextAllowedBrowserAcquisition: 2_000,
      });
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"))
      .mockResolvedValue("ready");
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(puppeteer.limits).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ value: "ready" });
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(puppeteer.limits).toHaveBeenCalledTimes(4);
  });

  it.each(["credentials", "maintenance"])(
    "帳密與維護不重試（%s）",
    async (kind) => {
      const error = new Error("銀行拒絕登入");
      const prepare = vi.fn().mockRejectedValue(error);
      if (kind === "maintenance") {
        const { page } = diagnosticPage(true);
        prepare.mockImplementation(
          async (_browser, observePage: (page: Page) => void) => {
            observePage(page);
            throw Object.assign(new Error("form timeout"), {
              name: "TimeoutError",
            });
          },
        );
      }
      const pending = prepareBrowserLoginWithRetry({
        binding,
        connectorId: "bank",
        prepare,
      });
      if (kind === "maintenance")
        await expect(pending).rejects.toThrow("form timeout");
      else await expect(pending).rejects.toBe(error);
      expect(puppeteer.launch).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each(["seconds", "http_date", "missing"])(
    "重開收到真正的 429，依 Retry-After 或預設等待再查額度（%s）",
    async (headerKind) => {
      const waitSeconds = headerKind === "missing" ? 20 : 25;
      const headers =
        headerKind === "missing"
          ? undefined
          : {
              "Retry-After":
                headerKind === "seconds"
                  ? "25"
                  : new Date(Date.now() + 25_000).toUTCString(),
            };
      acquireFromResponses([
        new Response(null, { status: 200 }),
        new Response("Too many requests private-token", {
          status: 429,
          headers,
        }),
        new Response(null, { status: 200 }),
      ]);
      vi.mocked(puppeteer.limits)
        .mockResolvedValueOnce(allowed)
        .mockRejectedValueOnce(new Error("limits unavailable private-token"));
      const prepare = vi
        .fn()
        .mockRejectedValueOnce(new Error("net::ERR_CONNECTION_RESET"))
        .mockResolvedValue("ready");
      const pending = prepareBrowserLoginWithRetry({
        binding,
        connectorId: "bank",
        prepare,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(puppeteer.launch).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledOnce();
      expect(puppeteer.limits).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(waitSeconds * 1_000 - 15_000);
      await expect(pending).resolves.toMatchObject({ value: "ready" });
      expect(puppeteer.launch).toHaveBeenCalledTimes(3);
      expect(puppeteer.limits).toHaveBeenCalledTimes(3);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(logEntries("browser_login_acquisition_wait")[0]).toMatchObject({
        waitMs: waitSeconds * 1_000,
        limitsStatus: "unavailable",
      });
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        "private-token",
      );
    },
  );

  it.each(["limits", "http_429"])(
    "首次取得不足保留原政策，不在登入前等待（%s）",
    async (mode) => {
      if (mode === "limits") {
        vi.mocked(puppeteer.limits).mockResolvedValue({
          ...allowed,
          allowedBrowserAcquisitions: 0,
          timeUntilNextAllowedBrowserAcquisition: 20_000,
        });
      } else {
        acquireFromResponses([
          new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": "25" },
          }),
        ]);
      }
      const prepare = vi.fn();
      await expect(
        prepareBrowserLoginWithRetry({ binding, connectorId: "bank", prepare }),
      ).rejects.toBeInstanceOf(BrowserRunCapacityError);
      expect(puppeteer.launch).toHaveBeenCalledTimes(mode === "limits" ? 0 : 1);
      expect(prepare).not.toHaveBeenCalled();
      expect(logEntries("browser_login_acquisition_wait")).toHaveLength(0);
    },
  );

  it.each(["initial", "replacement"])(
    "每日額度耗盡的 429 立即停止（%s）",
    async (mode) => {
      acquireFromResponses([
        ...(mode === "replacement"
          ? [new Response(null, { status: 200 })]
          : []),
        new Response("Browser time limit exceeded for today private-token", {
          status: 429,
          headers: { "Retry-After": "20" },
        }),
      ]);
      const prepare = vi
        .fn()
        .mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
      await expect(
        prepareBrowserLoginWithRetry({ binding, connectorId: "bank", prepare }),
      ).rejects.toMatchObject({ kind: "daily_quota" });
      expect(puppeteer.launch).toHaveBeenCalledTimes(
        mode === "initial" ? 1 : 2,
      );
      expect(prepare).toHaveBeenCalledTimes(mode === "initial" ? 0 : 1);
      expect(logEntries("browser_login_acquisition_wait")).toHaveLength(0);
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
        "private-token",
      );
    },
  );

  it("重開持續收到 429，最多三次 acquisition，沒有額外頁面重試", async () => {
    acquireFromResponses([
      new Response(null, { status: 200 }),
      ...Array.from(
        { length: 3 },
        () => new Response("Too many requests", { status: 429 }),
      ),
    ]);
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const failed = expect(pending).rejects.toMatchObject({
      kind: "rate_limit",
      retryAfterSeconds: 20,
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await failed;
    expect(puppeteer.launch).toHaveBeenCalledTimes(4);
    expect(prepare).toHaveBeenCalledOnce();
    expect(logEntries("browser_login_acquisition_failed")[0]).toMatchObject({
      attempt: 2,
      acquisitionAttempt: 3,
      waitedMs: 40_000,
    });
  });

  it("剩餘期限不足以等 429 時立即停止，保留樂天 OCR 預算", async () => {
    const syncStartedAt = Date.now();
    acquireFromResponses([
      new Response(null, { status: 200 }),
      new Response("Too many requests", { status: 429 }),
    ]);
    const prepare = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      throw new Error("net::ERR_CONNECTION_RESET");
    });
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "rakuten",
      remainingMs: () => 55_000 - (Date.now() - syncStartedAt) - 12_000,
      prepare,
    });
    const failed = expect(pending).rejects.toMatchObject({
      kind: "rate_limit",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(logEntries("browser_login_acquisition_wait")).toHaveLength(0);
    expect(Date.now() - syncStartedAt).toBe(30_000);
  });

  it("503 仍只重試建立請求，耗盡後保留 SDK 錯誤", async () => {
    acquireFromResponses(
      Array.from(
        { length: 3 },
        () => new Response("service unavailable", { status: 503 }),
      ),
    );
    const prepare = vi.fn();
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const failed = expect(pending).rejects.toThrow(
      "code: 503: message: service unavailable",
    );
    await vi.advanceTimersByTimeAsync(7_000);
    await failed;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("CDP 建立連線失敗即使含 429 也不重新取得 session", async () => {
    vi.mocked(puppeteer.launch)
      .mockResolvedValueOnce(browserSession("first-session"))
      .mockImplementation(async (wrappedBinding) => {
        const response = await wrappedBinding.fetch(
          "https://fake.host/v1/devtools/browser/new-session",
          { method: "GET" },
        );
        throw new Error(
          `WebSocket upgrade failed: code: ${response.status}: message: ${await response.text()}`,
        );
      });
    fetch.mockImplementation(
      async (_input: Request | string, init?: RequestInit) =>
        new Response(null, { status: init?.method === "DELETE" ? 200 : 429 }),
    );
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
    await expect(
      prepareBrowserLoginWithRetry({ binding, connectorId: "bank", prepare }),
    ).rejects.toBeInstanceOf(BrowserRunCapacityError);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logEntries("browser_login_acquisition_wait")).toHaveLength(0);
  });

  it("未知 acquisition 逾時後停止內部 503 重試", async () => {
    acquireFromResponses([]);
    let finishRequest: ((response: Response) => void) | undefined;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: vi.fn(),
    });
    const failed = expect(pending).rejects.toThrow("登入頁沒有在期限內");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    finishRequest!(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect((fetch.mock.calls[0][0] as Request).signal.aborted).toBe(true);
  });

  it("等待 429 期間取消，不再查額度或重開 session", async () => {
    const controller = new AbortController();
    binding.syncSignal = controller.signal;
    acquireFromResponses([
      new Response(null, { status: 200 }),
      new Response("Too many requests", { status: 429 }),
    ]);
    const prepare = vi
      .fn()
      .mockRejectedValue(new Error("net::ERR_CONNECTION_RESET"));
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare,
    });
    const reason = new Error("sync cancelled");
    const failed = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort(reason);
    await failed;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
    expect(puppeteer.limits).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("同步取消會關閉進行中的 session，並停止後續嘗試", async () => {
    const controller = new AbortController();
    binding.syncSignal = controller.signal;
    let preparationSignal: AbortSignal | undefined;
    const pending = prepareBrowserLoginWithRetry({
      binding,
      connectorId: "bank",
      prepare: async (_browser, _observe, signal) => {
        preparationSignal = signal;
        return new Promise<never>(() => {});
      },
    });
    const reason = new Error("sync cancelled");
    const failed = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await failed;
    expect(preparationSignal?.aborted).toBe(true);
    expect(puppeteer.launch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
