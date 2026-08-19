import puppeteer, {
  type Browser,
  type Dialog,
  type Frame,
  type Page,
} from "@cloudflare/puppeteer";
import { parseHncbData, type HncbConfig } from "@taiwan-fin-hub/connectors";
import type { SyncResult } from "@taiwan-fin-hub/core";

const LOGIN_URL =
  "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";
const PERSONAL_JSP =
  "https://netbank.hncb.com.tw/netbank/pages/jsp/Personal_new/html/personal.jsp";
const DEPOSIT_OVERVIEW_PATH =
  "/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt";
const CREDIT_CARD_BILL_RANGES = ["0", "1", "2", "3"] as const;

export const HNCB_AUTO_LOGIN_ATTEMPTS = 3;
export const HNCB_CAPTCHA_DIGIT_COUNT = 4;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const CAPTCHA_IMAGE_TIMEOUT_MS = 10_000;
const CAPTCHA_PAGE_RETRY_ATTEMPTS = 1;
const LOGIN_RESULT_ATTEMPTS = 10;
const LOGIN_RESULT_POLL_MS = 500;
const MAIN_FRAME_TIMEOUT_MS = 15_000;
const SESSION_FRAME_TIMEOUT_MS = 6_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const FRAME_READ_ATTEMPTS = 12;
const FRAME_READ_RETRY_MS = 250;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class HncbVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HncbVerificationRequiredError";
  }
}

export class HncbCredentialRejectedError extends HncbVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "HncbCredentialRejectedError";
  }
}

export class HncbCaptchaRejectedError extends HncbVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "HncbCaptchaRejectedError";
  }
}

export class HncbConnectionError extends Error {
  constructor(
    message: string,
    readonly sessionCookies?: string,
    readonly sessionCreatedAt?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "HncbConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

class HncbCaptchaUnavailableError extends HncbConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "HncbCaptchaUnavailableError";
  }
}

class HncbActionTimeoutError extends Error {
  constructor() {
    super("華南瀏覽器操作沒有在期限內回應。");
    this.name = "HncbActionTimeoutError";
  }
}

export class HncbBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "HncbBrowserCapacityError";
  }
}

type PreparedHncbCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

export function createHncbConnector(
  browserFetcher?: Fetcher,
  recognizeCaptcha?: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  return {
    id: "hncb" as const,
    async sync(
      config: HncbConfig,
      _cursor?: string,
    ): Promise<SyncResult<unknown>> {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new HncbConnectionError("Browser binding is unavailable.");
      }

      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      let authenticated = false;
      try {
        if (config.browserSessionId && config.captcha) {
          if (
            !config.browserSessionExpiresAt ||
            new Date(config.browserSessionExpiresAt) <= new Date()
          ) {
            throw new HncbVerificationRequiredError(
              "華南圖形驗證碼已逾時，請重新取得驗證碼。",
            );
          }
          assertCaptcha(config.captcha, config.captchaDigitCount);
        }

        browserInstance = await acquireBrowser(
          browserFetcher,
          config.browserSessionId,
        );
        const pages = await browserInstance.pages();
        page = pages[0] ?? (await browserInstance.newPage());
        await configurePage(page);

        let loggedIn = false;
        if (config.browserSessionId && config.captcha) {
          const dialogMessage = await submitLogin(page, config.captcha);
          const outcome = await waitForLoginResult(page, dialogMessage);
          if (outcome === "credential") {
            throw new HncbCredentialRejectedError(
              "華南銀行身分證字號、代號或密碼錯誤。",
            );
          }
          if (outcome !== "success") {
            throw new HncbCaptchaRejectedError(
              "華南圖形驗證碼錯誤，請重新取得驗證碼。",
            );
          }
          loggedIn = true;
        } else if (config.sessionCookies) {
          await importCookies(page, config.sessionCookies);
          await gotoAllowingTimeout(page, PERSONAL_JSP);
          // 失效 session 仍可能停在 personal.jsp，必須看到 main 頁框才算登入成功。
          loggedIn = await hasMainFrame(page, SESSION_FRAME_TIMEOUT_MS);
        }

        if (!loggedIn) {
          if (!recognizeCaptcha) {
            throw new HncbVerificationRequiredError(
              "華南銀行 session 已失效，需要重新登入。",
            );
          }
          await loginWithOcr(page, config, recognizeCaptcha);
        }
        authenticated = true;
        await waitForMainFrame(page);

        const depositOverviewHtml = await fetchDepositOverview(page);
        const unbilledHtml = await fetchCreditCardBill(page, "0");
        const billsHtml: string[] = [];
        for (const range of CREDIT_CARD_BILL_RANGES.slice(1)) {
          const billHtml = await fetchCreditCardBill(page, range);
          if (billHtml) billsHtml.push(billHtml);
        }

        if (!depositOverviewHtml && !unbilledHtml && billsHtml.length === 0) {
          throw new HncbConnectionError(
            "未能從華南網銀載入帳戶或帳單頁面，請確認登入狀態或重試。",
          );
        }

        const data = parseHncbData({
          depositOverviewHtml,
          unbilledHtml,
          billsHtml,
        });

        if (
          data.bankAccounts.length === 0 &&
          data.bankTransactions.length === 0 &&
          data.creditCardBills.length === 0
        ) {
          throw new HncbConnectionError(
            "華南網銀頁面解析結果為空，請確認網頁結構。",
          );
        }

        const now = new Date();
        return {
          records: [],
          ...data,
          cursor: JSON.stringify({
            sessionCookies: JSON.stringify(await page.cookies()),
            sessionCreatedAt: now.toISOString(),
            syncedAt: now.toISOString(),
          }),
        };
      } catch (error) {
        const normalized = mapHncbError(error);
        if (
          authenticated &&
          normalized instanceof HncbConnectionError &&
          page
        ) {
          const sessionCookies = await page
            .cookies()
            .then((cookies) => JSON.stringify(cookies))
            .catch(() => undefined);
          if (sessionCookies) {
            throw new HncbConnectionError(
              normalized.message,
              sessionCookies,
              new Date().toISOString(),
              normalized.cause,
            );
          }
        }
        throw normalized;
      } finally {
        if (browserInstance) await closeHncbBrowser(browserInstance);
      }
    },
  };
}

export async function prepareHncbCaptcha(
  browserFetcher?: Fetcher,
  config?: HncbConfig,
): Promise<PreparedHncbCaptcha> {
  if (!config) {
    throw new HncbVerificationRequiredError(
      "請填寫身分證字號、使用者代號與網銀密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new HncbConnectionError("Browser binding is unavailable.");
  }

  const browserInstance = await acquireBrowser(
    browserFetcher,
    config.browserSessionId,
  );
  const pages = await browserInstance.pages();
  const page = pages[0] ?? (await browserInstance.newPage());
  let preserved = false;
  try {
    await configurePage(page);
    const captcha = await openLoginAndCaptureCaptcha(page, config);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: HNCB_CAPTCHA_DIGIT_COUNT,
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(captcha.bytes)}`,
    };
  } finally {
    if (!preserved) await closeHncbBrowser(browserInstance);
  }
}

async function loginWithOcr(
  page: Page,
  config: HncbConfig,
  recognizeCaptcha: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= HNCB_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    try {
      const captcha = await openLoginAndCaptureCaptcha(page, config);
      const answer = await recognizeCaptcha(
        toArrayBuffer(captcha.bytes),
        HNCB_CAPTCHA_DIGIT_COUNT,
      );
      assertCaptcha(answer, HNCB_CAPTCHA_DIGIT_COUNT);
      const dialogMessage = await submitLogin(page, answer);
      const outcome = await waitForLoginResult(page, dialogMessage);
      if (outcome === "success") return;
      if (outcome === "credential") {
        throw new HncbCredentialRejectedError(
          "華南銀行身分證字號、代號或密碼錯誤。",
        );
      }
      lastError = new HncbCaptchaRejectedError(
        "華南圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    } catch (error) {
      if (error instanceof HncbCredentialRejectedError) throw error;
      lastError = error;
    }
  }
  if (lastError instanceof HncbVerificationRequiredError) throw lastError;
  throw new HncbVerificationRequiredError(
    `華南自動驗證連續失敗 ${HNCB_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

async function openLoginAndCaptureCaptcha(page: Page, config: HncbConfig) {
  for (let retry = 0; retry <= CAPTCHA_PAGE_RETRY_ATTEMPTS; retry += 1) {
    await openLoginAndFill(page, config);
    try {
      return await captureCaptcha(page);
    } catch (error) {
      if (
        !(error instanceof HncbCaptchaUnavailableError) ||
        retry >= CAPTCHA_PAGE_RETRY_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new HncbCaptchaUnavailableError(
    "華南登入頁沒有在期限內取得圖形驗證碼。",
  );
}

async function openLoginAndFill(page: Page, config: HncbConfig) {
  await gotoAllowingTimeout(page, LOGIN_URL);
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { doSubmit?: () => void }).doSubmit ===
        "function" && Boolean(document.getElementById("USERIDTEXT")),
    { timeout: 15_000 },
  );
  await fillInput(page, "#USERIDTEXT", config.userId ?? "");
  await withActionTimeout(
    page.evaluate(() => {
      const visible = document.getElementById(
        "USERIDTEXT",
      ) as HTMLInputElement | null;
      const hidden = document.getElementById(
        "USERID",
      ) as HTMLInputElement | null;
      if (visible && hidden) hidden.value = visible.value;
    }),
  );
  await fillInput(page, "#NICKNAME", config.account ?? "");
  await fillInput(page, "#password", config.password ?? "");
}

async function captureCaptcha(page: Page) {
  try {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          '#code_Cap, img[src*="CaptchaImage"]',
        );
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      { timeout: CAPTCHA_IMAGE_TIMEOUT_MS },
    );
  } catch {
    throw new HncbCaptchaUnavailableError(
      "華南登入頁沒有在期限內取得圖形驗證碼。",
    );
  }
  const image = await page.$('#code_Cap, img[src*="CaptchaImage"]');
  if (!image) {
    throw new HncbCaptchaUnavailableError("華南登入頁沒有取得圖形驗證碼。");
  }
  const screenshot = await image.screenshot({ type: "jpeg", quality: 90 });
  return {
    bytes:
      typeof screenshot === "string" ? screenshot : new Uint8Array(screenshot),
  };
}

async function submitLogin(page: Page, captcha: string) {
  await fillInput(page, "#TrxCaptchaKey", captcha);
  const dialog = captureDialogs(page);
  try {
    const navigation = page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      })
      .catch(() => {});
    try {
      await withActionTimeout(
        page.evaluate(() => {
          const submit = (window as unknown as { doSubmit?: () => void })
            .doSubmit;
          if (typeof submit === "function") {
            setTimeout(() => submit(), 0);
            return;
          }
          const button = document.querySelector<HTMLElement>(
            'a[onclick*="doSubmit"]',
          );
          if (button) setTimeout(() => button.click(), 0);
        }),
      );
    } catch (error) {
      if (!isRecoverableFrameError(error)) throw error;
    }
    await navigation;
    return dialog.message;
  } finally {
    dialog.dispose();
  }
}

async function waitForLoginResult(
  page: Page,
  dialogMessage: string,
): Promise<"success" | "credential" | "captcha" | "unknown"> {
  const immediate = classifyLoginMessage(dialogMessage);
  if (immediate === "credential" || immediate === "captcha") return immediate;

  for (let attempt = 0; attempt < LOGIN_RESULT_ATTEMPTS; attempt += 1) {
    if (await isLoggedIn(page)) return "success";
    const pageText = await withActionTimeout(
      page.evaluate(() => document.body?.innerText ?? ""),
    ).catch(() => "");
    const classified = classifyLoginMessage(`${dialogMessage}\n${pageText}`);
    if (classified === "credential" || classified === "captcha") {
      return classified;
    }
    await delay(LOGIN_RESULT_POLL_MS);
  }
  if (await isLoggedIn(page)) return "success";
  return "unknown";
}

function classifyLoginMessage(text: string) {
  if (
    /密碼錯誤|代號錯誤|使用者代號或密碼|帳號密碼不符|(身分證|統編).*(錯|不符)/.test(
      text,
    )
  ) {
    return "credential" as const;
  }
  if (
    /驗證碼.*(錯|不符|失敗)|圖形驗證碼.*(錯|不符)|請輸入4碼|只能輸入數字/.test(
      text,
    )
  ) {
    return "captcha" as const;
  }
  return "unknown" as const;
}

async function isLoggedIn(page: Page) {
  const currentUrl = page.url();
  if (currentUrl.includes("personal.jsp")) return true;
  if (findMainFrame(page)) return true;
  return Boolean(await withActionTimeout(page.$("frameset")).catch(() => null));
}

async function fetchDepositOverview(page: Page): Promise<string> {
  try {
    let html = await submitMainFrameAction(page, (frame) =>
      frame.evaluate((path) => {
        setTimeout(() => {
          window.location.href = path;
        }, 0);
      }, DEPOSIT_OVERVIEW_PATH),
    );
    if (looksLikeDepositOverview(html)) return html;

    html = await submitMainFrameAction(page, (frame) =>
      frame.evaluate(() => {
        const clickable = Array.from(
          document.querySelectorAll("a, input, button"),
        );
        const target = clickable.find((element) => {
          const label = [
            (element as HTMLElement).innerText,
            (element as HTMLInputElement).value,
            element.getAttribute("onclick"),
          ].join(" ");
          return /查詢|確定|送出|doInquire|doSubmit/.test(label);
        });
        if (target instanceof HTMLElement) {
          setTimeout(() => target.click(), 0);
          return true;
        }
        const form = document.querySelector("form");
        if (form) {
          const state = form.querySelector<HTMLInputElement>('[name="state"]');
          if (state) state.value = "result";
          setTimeout(() => form.submit(), 0);
          return true;
        }
        return false;
      }),
    );
    if (looksLikeDepositOverview(html)) return html;

    return await postTrx(page, {
      trx: "com.lb.wibc.trx.AcctInfoInq",
      state: "result",
    });
  } catch (error) {
    console.warn("[hncb] fetchDepositOverview failed:", error);
    return "";
  }
}

async function fetchCreditCardBill(page: Page, range: string): Promise<string> {
  try {
    return await postTrx(page, {
      trx: "com.lb.wibc.trx.CrdDetailInq",
      state: "result",
      TYPE: "001",
      RANGE: range,
    });
  } catch (error) {
    console.warn(`[hncb] fetchCreditCardBill range=${range} failed:`, error);
    return "";
  }
}

async function postTrx(
  page: Page,
  fields: Record<string, string>,
): Promise<string> {
  return submitMainFrameAction(page, (frame) =>
    frame.evaluate((entries) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/netbank/servlet/TrxDispatcher";
      for (const [name, value] of entries) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      setTimeout(() => form.submit(), 0);
    }, Object.entries(fields)),
  );
}

async function submitMainFrameAction(
  page: Page,
  action: (frame: Frame) => Promise<unknown>,
): Promise<string> {
  const frame = await waitForMainFrame(page);
  const navigation = frame
    .waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  try {
    await withActionTimeout(action(frame));
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
  await navigation;
  return readMainFrameHtml(page);
}

async function withActionTimeout<T>(action: Promise<T>): Promise<T> {
  action.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HncbActionTimeoutError()),
          ACTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readMainFrameHtml(page: Page): Promise<string> {
  const deadline = Date.now() + MAIN_FRAME_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < FRAME_READ_ATTEMPTS; attempt += 1) {
    const frame = findMainFrame(page);
    if (frame) {
      try {
        return await serializeHncbFrame(frame);
      } catch (error) {
        lastError = error;
        if (!isRecoverableFrameError(error)) throw error;
      }
    }
    if (Date.now() >= deadline) break;
    await delay(FRAME_READ_RETRY_MS);
  }
  if (lastError) throw lastError;
  return "";
}

async function serializeHncbFrame(frame: Frame): Promise<string> {
  const serialized = await withActionTimeout(
    frame.evaluate(() => {
      const escape = (value: string) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const tables = Array.from(document.querySelectorAll("table"));
      const tableHtml = tables
        .map((table) => {
          const rows = Array.from(table.rows);
          if (rows.length === 0) return "";
          return `<table>${rows
            .map((row) => {
              const cells = Array.from(row.cells)
                .map((cell) => {
                  const text = (cell.innerText || cell.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim();
                  return `<td>${escape(text)}</td>`;
                })
                .join("");
              return `<tr>${cells}</tr>`;
            })
            .join("")}</table>`;
        })
        .join("\n");
      const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      return `${tableHtml}\n<div id="hncb-page-text">${escape(text)}</div>`;
    }),
  );
  if (
    typeof serialized === "string" &&
    serialized.replace(/<[^>]+>/g, "").trim()
  ) {
    return serialized;
  }
  return (await withActionTimeout(frame.content())) || "";
}

function looksLikeDepositOverview(html: string) {
  const text = html.replace(/<[^>]+>/g, " ");
  return (
    /\d{10,16}/.test(text) && /活|支|定|儲|餘額|帳號|新台幣|臺幣/.test(text)
  );
}

function isDestroyedExecutionContext(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context|detached Frame|Target closed/i.test(
    message,
  );
}

function isNavigationTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Navigation timeout of \d+ ms exceeded/i.test(message);
}

function isProtocolTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out.*protocolTimeout|Runtime\.callFunctionOn timed out/i.test(
    message,
  );
}

function isRecoverableFrameError(error: unknown) {
  return (
    error instanceof HncbActionTimeoutError ||
    isDestroyedExecutionContext(error) ||
    isNavigationTimeout(error) ||
    isProtocolTimeout(error)
  );
}

async function gotoAllowingTimeout(page: Page, url: string) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (!isNavigationTimeout(error)) throw error;
  }
}

async function waitForMainFrame(page: Page, timeoutMs = MAIN_FRAME_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = findMainFrame(page);
    if (frame) return frame;
    await delay(FRAME_READ_RETRY_MS);
  }
  throw new HncbConnectionError(
    "未能從華南網銀載入帳戶頁框，請確認登入狀態或重試。",
  );
}

async function hasMainFrame(page: Page, timeoutMs: number) {
  try {
    await waitForMainFrame(page, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof HncbConnectionError) return false;
    throw error;
  }
}

function findMainFrame(page: Page) {
  const frames = page.frames().filter((frame) => !isDetachedFrame(frame));
  return (
    frames.find((frame) => frame.name() === "main") ??
    frames.find((frame) => /^main$/i.test(frame.name())) ??
    frames.find((frame) => /AcctInfoInq|CrdDetailInq/i.test(frame.url()))
  );
}

function isDetachedFrame(frame: Frame) {
  return Boolean((frame as Frame & { detached?: boolean }).detached);
}

async function acquireBrowser(
  browserFetcher: Fetcher,
  preferredSessionId?: string,
) {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      throw new HncbBrowserCapacityError(
        "華南驗證碼正在產生中，請稍候再試。",
        3,
      );
    }
    if (preferred) {
      try {
        return await puppeteer.connect(browserFetcher, preferred.sessionId);
      } catch {
        throw new HncbBrowserCapacityError(
          "前一個華南驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
  }

  const limits = await puppeteer.limits(browserFetcher).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new HncbBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再取得驗證碼。",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  return launchBrowser(browserFetcher);
}

async function launchBrowser(browserFetcher: Fetcher): Promise<Browser> {
  try {
    return await puppeteer.launch(browserFetcher, {
      keep_alive: CAPTCHA_KEEP_ALIVE_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new HncbBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完，請於額度重置後再試。",
        60,
      );
    }
    if (/429|rate limit|capacity/i.test(message)) {
      throw new HncbBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限，請稍後重試。",
      );
    }
    throw error;
  }
}

async function closeHncbBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "hncb_browser_cleanup_failed",
        connectorId: "hncb",
        stage: "close_browser",
        errorName: error instanceof Error ? error.name : typeof error,
        message:
          error instanceof Error
            ? error.message
            : "瀏覽器關閉失敗，但未取得錯誤原因。",
      }),
    );
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

async function fillInput(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector, { timeout: 10_000 });
  await withActionTimeout(
    page.evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>(target);
      if (!input) return;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, selector),
  );
  await page.type(selector, value, { delay: 15 });
}

function captureDialogs(page: Page) {
  let message = "";
  const onDialog = async (dialog: Dialog) => {
    message = dialog.message();
    await dialog.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  return {
    get message() {
      return message;
    },
    dispose() {
      page.off("dialog", onDialog);
    },
  };
}

async function importCookies(page: Page, serialized: string) {
  let cookies: unknown;
  try {
    cookies = JSON.parse(serialized);
  } catch {
    throw new HncbVerificationRequiredError(
      "華南銀行 session 格式無效，需要重新登入。",
    );
  }
  if (!Array.isArray(cookies)) {
    throw new HncbVerificationRequiredError(
      "華南銀行 session 格式無效，需要重新登入。",
    );
  }
  const safeCookies = cookies.filter(isRecord).filter((cookie) => {
    const domain = String(cookie.domain ?? "")
      .replace(/^\./, "")
      .toLowerCase();
    return (
      !domain ||
      domain === "netbank.hncb.com.tw" ||
      domain === "hncb.com.tw" ||
      domain.endsWith(".hncb.com.tw")
    );
  });
  if (safeCookies.length === 0) return;
  await page.setCookie(
    ...(safeCookies as unknown as Parameters<Page["setCookie"]>),
  );
}

function requireCredentials(config: HncbConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new HncbVerificationRequiredError(
      "請填寫身分證字號、使用者代號與網銀密碼。",
    );
  }
}

function assertCaptcha(value: string, digitCount = HNCB_CAPTCHA_DIGIT_COUNT) {
  const expected = digitCount ?? HNCB_CAPTCHA_DIGIT_COUNT;
  if (!new RegExp(`^\\d{${expected}}$`).test(value)) {
    throw new HncbCaptchaRejectedError(`華南驗證碼必須是 ${expected} 位數字。`);
  }
}

function mapHncbError(error: unknown): Error {
  if (
    error instanceof HncbVerificationRequiredError ||
    error instanceof HncbBrowserCapacityError ||
    error instanceof HncbConnectionError
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HncbConnectionError(
    `華南銀行連線失敗：${message}`,
    undefined,
    undefined,
    error,
  );
}

function bytesToBase64(bytes: Uint8Array | string) {
  if (typeof bytes === "string") return bytes;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array | string) {
  if (typeof bytes !== "string") {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  const binary = atob(bytes);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    decoded[index] = binary.charCodeAt(index);
  return decoded.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
