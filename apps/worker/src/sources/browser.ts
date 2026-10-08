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

// A launch can also fail during CDP setup, after a session was acquired.
// Only a confirmed rejection of POST /v1/devtools/browser is safe to retry.
const rejectedBrowserAcquisitions = new WeakSet<BrowserRunCapacityError>();

/** Classify errors from Browser Run acquisition, never bank API responses. */
export function classifyBrowserRunCapacityError(
  error: unknown,
): BrowserRunCapacityError | undefined {
  if (error instanceof BrowserRunCapacityError) return error;
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
            const response = await binding.fetch(
              new Request(request.clone() as Request, {
                signal: binding.syncSignal
                  ? AbortSignal.any([request.signal, binding.syncSignal])
                  : request.signal,
              }),
            );
            if (response.status === 429) {
              // The SDK drops response headers when constructing its error.
              // Classify here, without logging the response body.
              const capacity = classifyBrowserRunCapacityError(
                await response.text(),
              );
              const error =
                capacity?.kind === "daily_quota"
                  ? capacity
                  : new BrowserRunCapacityError(
                      "rate_limit",
                      browserRetryAfterSeconds(response.headers),
                    );
              rejectedBrowserAcquisitions.add(error);
              console.warn(
                JSON.stringify({
                  event: "browser_acquisition_failed",
                  status: 429,
                  attempt: attempt + 1,
                  capacityKind: error.kind,
                  retryAfterSeconds: error.retryAfterSeconds,
                }),
              );
              throw error;
            }
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
            await waitForBrowserRetry(delayMs, binding.syncSignal);
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

function browserRetryAfterSeconds(headers: Headers): number {
  const value = headers.get("Retry-After");
  if (!value?.trim()) return 20;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? Math.max(1, Math.ceil(seconds)) : 20;
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(1, Math.ceil((date - Date.now()) / 1_000))
    : 20;
}

async function waitForBrowserRetry(delayMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const LOGIN_PREPARATION_ATTEMPTS = 3;
const LOGIN_PREPARATION_TIMEOUT_MS = 60_000;
const LOGIN_PREPARATION_BUDGET_MS = 180_000;
const BROWSER_LIMITS_TIMEOUT_MS = 15_000;
const BROWSER_ACQUISITION_TIMEOUT_MS = 15_000;
const BROWSER_ACQUISITION_ATTEMPTS = 3;

export type BrowserLoginPreparationStage =
  | "initialize_page"
  | "configure_page"
  | "restore_session"
  | "navigate"
  | "form"
  | "captcha";

export type ReportBrowserLoginStage = (
  stage: BrowserLoginPreparationStage,
) => void;

type BrowserTimeoutSource =
  | "page_preparation"
  | "limits_lookup"
  | "browser_acquisition"
  | "shared_budget"
  | "connector_deadline"
  | "connector_operation";

class BrowserLoginPreparationTimeoutError extends Error {
  constructor(readonly source: BrowserTimeoutSource = "page_preparation") {
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
    reportStage: ReportBrowserLoginStage,
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
  const startedAt = Date.now();
  const deadline = startedAt + LOGIN_PREPARATION_BUDGET_MS;
  const remaining = () =>
    Math.min(deadline - Date.now(), options.remainingMs?.() ?? Infinity);
  const operationBudget = (maximumMs: number, source: BrowserTimeoutSource) => {
    const sharedMs = deadline - Date.now();
    const connectorMs = options.remainingMs?.() ?? Infinity;
    return {
      timeoutMs: Math.min(maximumMs, sharedMs, connectorMs),
      timeoutSource:
        connectorMs <= Math.min(maximumMs, sharedMs)
          ? ("connector_deadline" as const)
          : sharedMs <= maximumMs
            ? ("shared_budget" as const)
            : source,
    };
  };
  const checkRemaining = () => {
    signal.throwIfAborted();
    const { timeoutMs, timeoutSource } = operationBudget(
      Infinity,
      "shared_budget",
    );
    if (timeoutMs <= 0)
      throw new BrowserLoginPreparationTimeoutError(timeoutSource);
  };

  for (let attempt = 1; attempt <= LOGIN_PREPARATION_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now();
    let acquisitionAttempt = 0;
    let waitedMs = 0;
    let acquisitionStage = "limits_lookup";
    let limitsStatus: "allowed" | "rate_limited" | "unavailable" =
      "unavailable";
    let allowedBrowserAcquisitions: number | undefined;
    let timeUntilNextAllowedBrowserAcquisition: number | undefined;
    const waitForCapacity = async (error: BrowserRunCapacityError) => {
      checkRemaining();
      const waitMs = error.retryAfterSeconds * 1_000;
      if (waitMs >= remaining()) throw error;
      acquisitionStage = "rate_limit_wait";
      console.warn(
        JSON.stringify({
          event: "browser_login_acquisition_wait",
          connectorId,
          attempt,
          acquisitionAttempt,
          capacityKind: error.kind,
          waitMs,
          limitsStatus,
          allowedBrowserAcquisitions,
          timeUntilNextAllowedBrowserAcquisition,
          totalElapsedMs: Date.now() - startedAt,
        }),
      );
      await waitForBrowserRetry(waitMs, signal);
      waitedMs += waitMs;
    };
    const acquire = async (): Promise<Browser> => {
      for (;;) {
        checkRemaining();
        acquisitionStage = "limits_lookup";
        const limitsBudget = operationBudget(
          BROWSER_LIMITS_TIMEOUT_MS,
          "limits_lookup",
        );
        const limits = await boundedBrowserOperation(
          puppeteer.limits(scopedBinding),
          limitsBudget.timeoutMs,
          signal,
          limitsBudget.timeoutSource,
        ).catch((error: unknown) => {
          signal.throwIfAborted();
          if (error instanceof BrowserLoginPreparationTimeoutError) throw error;
          return undefined;
        });
        allowedBrowserAcquisitions = limits?.allowedBrowserAcquisitions;
        timeUntilNextAllowedBrowserAcquisition =
          limits?.timeUntilNextAllowedBrowserAcquisition;
        limitsStatus = !limits
          ? "unavailable"
          : limits.allowedBrowserAcquisitions < 1
            ? "rate_limited"
            : "allowed";
        if (limits && limits.allowedBrowserAcquisitions < 1) {
          const error = new BrowserRunCapacityError(
            "acquisition_rate_limit",
            Math.max(
              1,
              Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1_000),
            ),
          );
          // Initial failures retain the caller's existing capacity policy.
          // Replacement sessions wait only after confirmed remote closure.
          if (attempt === 1) throw error;
          await waitForCapacity(error);
          continue; // Recheck limits after every wait, before acquisition.
        }

        checkRemaining();
        acquisitionStage = "browser_acquisition";
        acquisitionAttempt++;
        const acquisitionBudget = operationBudget(
          BROWSER_ACQUISITION_TIMEOUT_MS,
          "browser_acquisition",
        );
        const controller = new AbortController();
        const acquisitionBinding: SyncBrowserBinding = {
          ...scopedBinding,
          syncSignal: AbortSignal.any([signal, controller.signal]),
        };
        // Unknown/timed-out acquisitions never trigger another launch. Stop
        // pending HTTP retries, and close any session that arrives late.
        let acquisitionStopped = false;
        const acquisition = launchBrowserWithRetry(
          acquisitionBinding,
          options.launchOptions ?? { keep_alive: 60_000 },
        ).then(async (browser) => {
          if (acquisitionStopped) {
            await closeBrowserSession(binding, browser);
            throw new BrowserLoginPreparationTimeoutError(
              acquisitionBudget.timeoutSource,
            );
          }
          return browser;
        });
        try {
          return await boundedBrowserOperation(
            acquisition,
            acquisitionBudget.timeoutMs,
            signal,
            acquisitionBudget.timeoutSource,
          );
        } catch (error) {
          acquisitionStopped = true;
          controller.abort(error);
          signal.throwIfAborted();
          if (
            attempt === 1 ||
            acquisitionAttempt >= BROWSER_ACQUISITION_ATTEMPTS ||
            !(error instanceof BrowserRunCapacityError) ||
            !rejectedBrowserAcquisitions.has(error) ||
            error.kind === "daily_quota"
          ) {
            throw error;
          }
          await waitForCapacity(error);
        }
      }
    };
    let browser: Browser;
    try {
      browser = await acquire();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "browser_login_acquisition_failed",
          connectorId,
          attempt,
          acquisitionAttempt,
          stage: acquisitionStage,
          timeoutSource: browserTimeoutSource(error),
          elapsedMs: Date.now() - attemptStartedAt,
          totalElapsedMs: Date.now() - startedAt,
          waitedMs,
          limitsStatus,
          allowedBrowserAcquisitions,
          timeUntilNextAllowedBrowserAcquisition,
          capacityKind:
            error instanceof BrowserRunCapacityError ? error.kind : undefined,
          retryAfterSeconds:
            error instanceof BrowserRunCapacityError
              ? error.retryAfterSeconds
              : undefined,
        }),
      );
      throw error;
    }

    const preparationStartedAt = Date.now();
    let stage: BrowserLoginPreparationStage = "initialize_page";
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    const diagnostics = observeLoginPreparation();
    try {
      options.onBrowser?.(browser);
      const preparationBudget = operationBudget(
        LOGIN_PREPARATION_TIMEOUT_MS,
        "page_preparation",
      );
      checkRemaining();
      const value = await boundedBrowserOperation(
        options.prepare(
          browser,
          diagnostics.observePage,
          attemptSignal,
          attempt,
          (value) => {
            attemptSignal.throwIfAborted();
            stage = value;
          },
        ),
        preparationBudget.timeoutMs,
        attemptSignal,
        preparationBudget.timeoutSource,
      );
      attemptSignal.throwIfAborted();
      return { browser, value };
    } catch (error) {
      const preparationElapsedMs = Date.now() - preparationStartedAt;
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
          stage,
          timeoutSource: browserTimeoutSource(error),
          preparationElapsedMs,
          elapsedMs: Date.now() - attemptStartedAt,
          totalElapsedMs: Date.now() - startedAt,
          waitedMs,
          limitsStatus,
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
  throw new BrowserLoginPreparationTimeoutError("shared_budget");
}

function browserTimeoutSource(error: unknown): BrowserTimeoutSource | null {
  if (!(error instanceof Error)) return null;
  if (error instanceof BrowserLoginPreparationTimeoutError) return error.source;
  if (/Timeout|Deadline/.test(error.name)) return "connector_operation";
  return error.cause !== undefined && error.cause !== error
    ? browserTimeoutSource(error.cause)
    : null;
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
  timeoutSource: BrowserTimeoutSource = "page_preparation",
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
          () => reject(new BrowserLoginPreparationTimeoutError(timeoutSource)),
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
