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
      prepare: async (_browser, observePage) => {
        if (++attempts > 1) return "ready";
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
    expect(listeners.size).toBe(0);
  });

  it("停滯最多三次、每次十五秒；每次失敗都關閉 session", async () => {
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
    await vi.advanceTimersByTimeAsync(45_000);
    await failed;
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(puppeteer.launch).toHaveBeenCalledTimes(3);
    for (const session of sessions)
      expect(session.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
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
    const prepare = vi.fn(() => new Promise<never>(() => {}));
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

  it("限流等待發生在舊 session 關閉後", async () => {
    vi.mocked(puppeteer.limits)
      .mockResolvedValueOnce(allowed)
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
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ value: "ready" });
    expect(puppeteer.launch).toHaveBeenCalledTimes(2);
  });

  it.each(["credentials", "quota", "maintenance"])(
    "帳密、每日額度與維護不重試（%s）",
    async (kind) => {
      const error =
        kind === "quota"
          ? new BrowserRunCapacityError("daily_quota", 100)
          : new Error("銀行拒絕登入");
      const prepare = vi.fn().mockRejectedValue(error);
      if (kind === "quota")
        vi.mocked(puppeteer.launch).mockRejectedValue(error);
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
      expect(prepare).toHaveBeenCalledTimes(kind === "quota" ? 0 : 1);
    },
  );

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
