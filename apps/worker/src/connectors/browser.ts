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
