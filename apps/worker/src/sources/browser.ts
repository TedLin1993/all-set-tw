import puppeteer from "@cloudflare/puppeteer";

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
    void browser.close().catch(() => undefined);
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
