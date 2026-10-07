import puppeteer, {
  type Browser,
  type Page,
  type HTTPRequest,
  type HTTPResponse,
} from "@cloudflare/puppeteer";

type SyncBrowserBinding = Parameters<typeof puppeteer.launch>[0] & {
  syncSignal?: AbortSignal;
};

function watchBrowserCancellation(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  binding: SyncBrowserBinding,
) {
  const signal = binding.syncSignal;
  if (!signal) return browser;
  const close = () => {
    void closeBrowserSession(binding, browser);
  };
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", close, { once: true });
  browser.once("disconnected", () =>
    signal.removeEventListener("abort", close),
  );
  return browser;
}

export async function connectBrowserWithCancellation(
  binding: SyncBrowserBinding,
  sessionId: string,
) {
  binding.syncSignal?.throwIfAborted();
  return watchBrowserCancellation(
    await puppeteer.connect(binding, sessionId),
    binding,
  );
}

const RETRY_DELAYS_MS = [2_000, 5_000] as const;
const DAY_MS = 86_400_000;

export type BrowserRunCapacityKind =
  "daily_quota" | "rate_limit" | "acquisition_rate_limit";

export class BrowserRunCapacityError extends Error {
  constructor(
    readonly kind: BrowserRunCapacityKind,
    readonly retryAfterSeconds: number,
  ) {
    super(
      kind === "daily_quota"
        ? "Cloudflare 瀏覽器今日使用額度已用完。額度每日台灣時間早上 8 點重置，請於重置後再試。"
        : kind === "acquisition_rate_limit"
          ? "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再試。"
          : "Cloudflare 瀏覽器暫時達到使用上限，請稍後再試。",
    );
    this.name = "BrowserRunCapacityError";
  }
}

/** Classify errors from Browser Run acquisition, never bank API responses. */
export function classifyBrowserRunCapacityError(
  error: unknown,
): BrowserRunCapacityError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/Browser time limit exceeded for today/i.test(message)) {
    const now = Date.now();
    return new BrowserRunCapacityError(
      "daily_quota",
      Math.ceil(((Math.floor(now / DAY_MS) + 1) * DAY_MS - now) / 1_000),
    );
  }

  const status = /code:\s*(\d+)/i.exec(message)?.[1];
  if (status && status !== "429") return undefined;
  if (
    status === "429" ||
    /rate limit|too many requests|capacity/i.test(message)
  ) {
    return new BrowserRunCapacityError("rate_limit", 20);
  }
  return undefined;
}

/** Retry only rejected browser acquisition, before a session or login exists. */
export async function launchBrowserWithRetry(
  binding: SyncBrowserBinding,
  options?: Parameters<typeof puppeteer.launch>[1],
) {
  try {
    binding.syncSignal?.throwIfAborted();
    const browser = await puppeteer.launch(
      {
        async fetch(input, init) {
          binding.syncSignal?.throwIfAborted();
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          const method =
            init?.method ?? (input instanceof Request ? input.method : "GET");
          // This is the acquisition endpoint used by the pinned Puppeteer SDK.
          // Session/CDP requests must pass through without retrying.
          if (
            method.toUpperCase() !== "POST" ||
            url.pathname !== "/v1/devtools/browser"
          ) {
            return binding.fetch(input, init);
          }

          const request = new Request(input, init);
          for (let attempt = 0; ; attempt++) {
            binding.syncSignal?.throwIfAborted();
            const response = await binding.fetch(request.clone() as Request);
            if (response.status !== 503) return response;

            const delayMs = RETRY_DELAYS_MS[attempt];
            console.warn(
              JSON.stringify({
                event: "browser_acquisition_failed",
                status: response.status,
                attempt: attempt + 1,
                retryDelayMs: delayMs ?? null,
              }),
            );
            // Leave the final response intact for Puppeteer's error handling.
            if (delayMs === undefined) return response;
            await response.body?.cancel();
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          }
        },
      },
      options,
    );
    return watchBrowserCancellation(browser, binding);
  } catch (error) {
    throw classifyBrowserRunCapacityError(error) ?? error;
  }
}

const LOGIN_PREPARATION_ATTEMPTS = 3;
const LOGIN_PREPARATION_TIMEOUT_MS = 15_000;
const LOGIN_PREPARATION_BUDGET_MS = 45_000;

class BrowserLoginPreparationTimeoutError extends Error {
  constructor() {
    super("登入頁沒有在期限內載入完整表單，請稍後再試。");
    this.name = "BrowserLoginPreparationTimeoutError";
  }
}

export class BrowserSessionCleanupError extends Error {
  constructor() {
    super("無法確認前一個瀏覽器工作階段已關閉，已停止重開，請稍後再試。");
    this.name = "BrowserSessionCleanupError";
  }
}

const browserClosures = new WeakMap<Browser, Promise<boolean>>();

/** Close remotely as well as locally: the SDK can swallow DELETE failures. */
export function closeBrowserSession(
  binding: SyncBrowserBinding,
  browser: Browser,
): Promise<boolean> {
  const existing = browserClosures.get(browser);
  if (existing) return existing;
  const closing = closeRemoteBrowserSession(binding, browser);
  browserClosures.set(browser, closing);
  return closing;
}

async function closeRemoteBrowserSession(
  binding: SyncBrowserBinding,
  browser: Browser,
): Promise<boolean> {
  // Both operations share a four-second deadline. Start the REST request even
  // when CDP is unresponsive, and never infer remote closure from disconnect().
  const deadline = Date.now() + 4_000;
  void browser.close().catch(() => undefined);
  try {
    const response = await boundedBrowserOperation(
      binding.fetch(
        `https://fake.host/v1/devtools/browser/${encodeURIComponent(browser.sessionId())}`,
        { method: "DELETE", signal: AbortSignal.timeout(4_000) },
      ),
      deadline - Date.now(),
    );
    return response.ok || response.status === 404 || response.status === 410;
  } catch {
    return false;
  } finally {
    void browser.disconnect().catch(() => undefined);
  }
}

type LoginPreparationOptions<T> = {
  binding: SyncBrowserBinding;
  connectorId: string;
  launchOptions?: Parameters<typeof puppeteer.launch>[1];
  signal?: AbortSignal;
  remainingMs?: () => number;
  isRetryable?: (error: unknown) => boolean;
  onBrowser?: (browser: Browser | undefined) => void;
  // Only page/session restoration and form/CAPTCHA preparation belong here.
  // OCR, submitting credentials, and fetching financial data MUST stay outside.
  prepare: (
    browser: Browser,
    observePage: (page: Page) => void,
    signal: AbortSignal,
    attempt: number,
  ) => Promise<T>;
};

/** Recover a stalled login page with at most three fresh, sequential sessions. */
export async function prepareBrowserLoginWithRetry<T>(
  options: LoginPreparationOptions<T>,
): Promise<{ browser: Browser; value: T }> {
  const { binding, connectorId } = options;
  const signals = [binding.syncSignal, options.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const signal = AbortSignal.any(signals);
  const scopedBinding: SyncBrowserBinding = {
    fetch: binding.fetch.bind(binding),
    syncSignal: signal,
  };
  const deadline = Date.now() + LOGIN_PREPARATION_BUDGET_MS;
  const remaining = () =>
    Math.min(deadline - Date.now(), options.remainingMs?.() ?? Infinity);

  for (let attempt = 1; attempt <= LOGIN_PREPARATION_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    if (remaining() <= 0) throw new BrowserLoginPreparationTimeoutError();
    const limits = await boundedBrowserOperation(
      puppeteer.limits(scopedBinding),
      Math.min(LOGIN_PREPARATION_TIMEOUT_MS, remaining()),
      signal,
    ).catch((error: unknown) => {
      signal.throwIfAborted();
      if (error instanceof BrowserLoginPreparationTimeoutError) throw error;
      return undefined;
    });
    if (limits && limits.allowedBrowserAcquisitions < 1) {
      const waitMs = Math.max(1, limits.timeUntilNextAllowedBrowserAcquisition);
      // A retry may wait only after the previous session has been closed.
      // Initial capacity failures retain the existing caller's quota policy.
      if (attempt === 1 || waitMs >= remaining()) {
        throw new BrowserRunCapacityError(
          "acquisition_rate_limit",
          Math.max(1, Math.ceil(waitMs / 1_000)),
        );
      }
      await boundedBrowserOperation(
        new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
        remaining(),
        signal,
      );
    }

    // Acquisition errors are not bank page failures. In particular, never
    // spend more sessions on a daily quota/capacity error or an unknown launch.
    let acquisitionStopped = false;
    const acquisition = launchBrowserWithRetry(
      scopedBinding,
      options.launchOptions ?? { keep_alive: 60_000 },
    ).then(async (browser) => {
      if (acquisitionStopped) {
        await closeBrowserSession(binding, browser);
        throw new BrowserLoginPreparationTimeoutError();
      }
      return browser;
    });
    let browser: Browser;
    try {
      browser = await boundedBrowserOperation(
        acquisition,
        Math.min(LOGIN_PREPARATION_TIMEOUT_MS, remaining()),
        signal,
      );
    } catch (error) {
      acquisitionStopped = true;
      throw error;
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    const diagnostics = observeLoginPreparation();
    try {
      options.onBrowser?.(browser);
      const value = await boundedBrowserOperation(
        options.prepare(
          browser,
          diagnostics.observePage,
          attemptSignal,
          attempt,
        ),
        Math.min(LOGIN_PREPARATION_TIMEOUT_MS, remaining()),
        attemptSignal,
      );
      attemptSignal.throwIfAborted();
      return { browser, value };
    } catch (error) {
      controller.abort(error);
      const snapshot = signal.aborted
        ? { cdpResponsive: false }
        : await diagnostics.snapshot().catch(() => ({ cdpResponsive: false }));
      const retryable =
        !("maintenance" in snapshot && snapshot.maintenance) &&
        (isRetryableLoginPreparationError(error) ||
          Boolean(options.isRetryable?.(error)));
      diagnostics.dispose();
      const closed = await closeBrowserSession(binding, browser);
      options.onBrowser?.(undefined);
      console.warn(
        JSON.stringify({
          event: "browser_login_preparation_failed",
          connectorId,
          attempt,
          elapsedMs: Date.now() - startedAt,
          retryable,
          sessionClosed: closed,
          ...snapshot,
        }),
      );
      signal.throwIfAborted();
      if (!closed) throw new BrowserSessionCleanupError();
      if (!retryable || attempt === LOGIN_PREPARATION_ATTEMPTS) throw error;
    } finally {
      diagnostics.dispose();
    }
  }
  throw new BrowserLoginPreparationTimeoutError();
}

function isRetryableLoginPreparationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof BrowserLoginPreparationTimeoutError ||
    error.name === "TimeoutError" ||
    /net::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR)/.test(
      error.message,
    ) ||
    /(?:Target|Session) closed|Protocol error.*(?:timed out|timeout)/i.test(
      error.message,
    )
  ) {
    return true;
  }
  return error.cause !== undefined && error.cause !== error
    ? isRetryableLoginPreparationError(error.cause)
    : false;
}

async function boundedBrowserOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  // Callers may have already started the operation before cancellation raced
  // with this function; still consume its eventual rejection.
  void operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(
          () => reject(new BrowserLoginPreparationTimeoutError()),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function describeBrowserUrl(value: string) {
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? `${url.host}${url.pathname}`
      : url.protocol;
  } catch {
    return "unknown";
  }
}

function observeLoginPreparation() {
  let page: Page | undefined;
  const failures: { url: string; networkError?: string; status?: number }[] =
    [];
  const onFailed = (request: HTTPRequest) => {
    if (failures.length >= 8) return;
    failures.push({
      url: describeBrowserUrl(request.url()),
      networkError: /net::ERR_[A-Z0-9_]+/.exec(
        request.failure()?.errorText ?? "",
      )?.[0],
    });
  };
  const onResponse = (response: HTTPResponse) => {
    if (response.status() < 400 || failures.length >= 8) return;
    failures.push({
      url: describeBrowserUrl(response.url()),
      status: response.status(),
    });
  };
  const dispose = () => {
    page?.off("requestfailed", onFailed);
    page?.off("response", onResponse);
  };
  return {
    observePage(value: Page) {
      dispose();
      page = value;
      page.on("requestfailed", onFailed);
      page.on("response", onResponse);
    },
    dispose,
    async snapshot() {
      if (!page) return { cdpResponsive: false, failures };
      const url = describeBrowserUrl(page.url());
      let session: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
      const read = async () => {
        session = await page!.createCDPSession();
        try {
          const { frameTree } = await session.send("Page.getFrameTree");
          const { result } = await session.send("Runtime.evaluate", {
            // Return only a boolean; no page text or credential values leave CDP.
            expression:
              '/系統維護中|維護作業中|系統暫停服務|system (?:is )?(?:under maintenance|unavailable)/i.test(document.body?.innerText ?? "")',
            returnByValue: true,
          });
          return {
            cdpResponsive: true,
            url: describeBrowserUrl(frameTree.frame.url),
            maintenance: result.value === true,
          };
        } finally {
          void session.detach().catch(() => undefined);
        }
      };
      try {
        return {
          ...(await boundedBrowserOperation(read(), 1_000)),
          failures,
        };
      } catch {
        return { cdpResponsive: false, url, failures };
      }
    },
  };
}
