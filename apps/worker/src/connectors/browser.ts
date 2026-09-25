import puppeteer from "@cloudflare/puppeteer";

const RETRY_DELAYS_MS = [2_000, 5_000] as const;

/** Retry only rejected browser acquisition, before a session or login exists. */
export async function launchBrowserWithRetry(
  binding: Parameters<typeof puppeteer.launch>[0],
  options?: Parameters<typeof puppeteer.launch>[1],
) {
  return puppeteer.launch(
    {
      async fetch(input, init) {
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
}

/** Browser Run rejected a new browser because of daily quota or rate limits. */
export class BrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "BrowserCapacityError";
  }
}

/** Map a failed browser launch to a user-facing capacity error, if applicable. */
export function classifyBrowserCapacityError(
  error: unknown,
): BrowserCapacityError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/Browser time limit exceeded for today/i.test(message)) {
    return new BrowserCapacityError(
      "Cloudflare 瀏覽器今日使用額度已用完，請於額度重置後再試。",
      60,
    );
  }
  if (/code:\s*429|rate limit exceeded/i.test(message)) {
    return new BrowserCapacityError(
      "Cloudflare 瀏覽器暫時達到使用上限，請稍後再試。",
      20,
    );
  }
  return undefined;
}

/** Launch a browser, converting Browser Run capacity failures. */
export async function launchBrowserOrCapacityError(
  binding: Parameters<typeof puppeteer.launch>[0],
  options?: Parameters<typeof puppeteer.launch>[1],
) {
  try {
    return await launchBrowserWithRetry(binding, options);
  } catch (error) {
    throw classifyBrowserCapacityError(error) ?? error;
  }
}
