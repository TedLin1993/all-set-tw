import puppeteer, {
  type Browser,
  type CDPSession,
  type CookieParam,
  type Dialog,
  type Frame,
  type Page,
} from "@cloudflare/puppeteer";
import {
  parseFirstbankData,
  type FirstbankConfig,
  type FirstbankPayloads,
} from "@taiwan-fin-hub/connectors";
import type { SyncResult } from "@taiwan-fin-hub/core";

const ORIGIN = "https://ibank.firstbank.com.tw";
const LOGIN_URL = `${ORIGIN}/NetBank/index103.html`;
const ACCOUNT_OVERVIEW_URL = `${ORIGIN}/NetBank/1/acntReviewAll.html`;
const HOME_URL = `${ORIGIN}/NetBank/1/01.jsp`;
const DEPOSIT_AJAX_PATH = "/NetBank/ajax/acntReview1.html";
const TRANSACTION_URL = `${ORIGIN}/NetBank/2/0101.html`;
const CAPTCHA_SELECTOR = 'img[src*="code_verify1.jpg"]';
const CAPTCHA_DIGIT_MIN = 4;
const CAPTCHA_DIGIT_MAX = 8;

export const FIRSTBANK_AUTO_LOGIN_ATTEMPTS = 3;
export const FIRSTBANK_CAPTCHA_DIGIT_COUNT = 4;

const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const CAPTCHA_IMAGE_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;
const LOGIN_RESULT_ATTEMPTS = 30;
const LOGIN_RESULT_POLL_MS = 500;
const FRAME_TIMEOUT_MS = 15_000;
const FRAME_READ_RETRY_MS = 250;
// 010103 may replace and detach its iframe in Browser Rendering. Arm a
// document-body waiter before submit, intercept 010103 at Fetch response
// stage, and keep listeners attached so a delayed or non-Document body
// can still settle. If the bank's search handler emits verifyDV, the result
// budget restarts once that verification settles; missing verifyDV CDP
// events must not block a new live result frame or already-captured HTML.
const RESULT_CAPTURE_WAIT_MS = 10_000;
const RESULT_CAPTURE_MAX_WAIT_MS = 30_000;
const DEPOSIT_CAPTURE_WAIT_MS = 15_000;
const FRAME_PROBE_TIMEOUT_MS = 1_000;
const CARD_RESPONSE_TIMEOUT_MS = 10_000;
const SESSION_RELEASE_TIMEOUT_MS = 2_000;
const SESSION_RELEASE_POLL_MS = 100;
const MAX_SERIALIZED_TABLE_BYTES = 512 * 1024;
const TRANSACTION_DOCUMENT_BUFFER_BYTES = MAX_SERIALIZED_TABLE_BYTES * 2;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type FirstbankBrowserConfig = FirstbankConfig & {
  sessionCookies?: string;
  sessionCreatedAt?: string;
  browserSessionId?: string;
  browserSessionExpiresAt?: string;
  captchaDigitCount?: number;
  captcha?: string;
};

type CaptchaImage = {
  bytes: Uint8Array | string;
  digitCount: number;
};

type CardPayloadKey = "cardBill" | "recentPayments" | "cardUnbilled";

type CapturedCardResponses = Partial<Record<CardPayloadKey, unknown>>;

type DepositResponseCapture = {
  html?: string;
  observed: boolean;
  status?: number;
  pending: Set<Promise<void>>;
  responseBody: Promise<string>;
  settleResponseBody: (html: string) => void;
};

type TransactionDocumentMeta = {
  path: string;
  status?: number;
};

type TransactionResponseCapture = {
  armed: boolean;
  armedAt?: number;
  existingResultFrames: Set<Frame>;
  html?: string;
  verificationRequested: boolean;
  verificationResponded: boolean;
  verificationFailed: boolean;
  verificationSettledAt?: number;
  verificationRequestIds: Set<string>;
  requestIds: Set<string>;
  documentMeta: Map<string, TransactionDocumentMeta>;
  inFlight: Map<string, { path: string; startedAt: number }>;
  pending: Set<Promise<void>>;
  documentBody: Promise<string>;
  settleDocumentBody: (html: string) => void;
};

type TransactionDocumentResponseEvent = {
  requestId: string;
  type?: string;
  response: { url: string; status?: number };
};

type TransactionLoadingEvent = {
  requestId: string;
};

type NetworkRequestWillBeSentEvent = {
  requestId: string;
  type?: string;
  request: { url: string };
};

type FetchRequestPausedEvent = {
  requestId: string;
  resourceType?: string;
  request: { url: string };
  responseStatusCode?: number;
};

type BrowserResponse = {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export class FirstbankVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirstbankVerificationRequiredError";
  }
}

export class FirstbankCredentialRejectedError extends FirstbankVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FirstbankCredentialRejectedError";
  }
}

export class FirstbankCaptchaRejectedError extends FirstbankVerificationRequiredError {
  constructor(message = "第一銀行圖形驗證碼錯誤，請重新取得驗證碼。") {
    super(message);
    this.name = "FirstbankCaptchaRejectedError";
  }
}

export class FirstbankConnectionError extends Error {
  constructor(
    message: string,
    readonly sessionCookies?: string,
    readonly sessionCreatedAt?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "FirstbankConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class FirstbankBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "FirstbankBrowserCapacityError";
  }
}

class FirstbankCaptchaUnavailableError extends FirstbankConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "FirstbankCaptchaUnavailableError";
  }
}

class FirstbankActionTimeoutError extends Error {
  constructor() {
    super("第一銀行瀏覽器操作沒有在期限內回應。");
    this.name = "FirstbankActionTimeoutError";
  }
}

type PreparedFirstbankCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

/**
 * 建立第一銀行公開網銀 connector。
 *
 * 所有登入、導覽與資料請求都在 Browser Rendering 的 authenticated frame
 * 中執行；Worker 不會重播銀行 HTTP request，也不會把 page/HAR 內容寫入 log。
 */
export function createFirstbankConnector(
  browserFetcher?: Fetcher,
  recognizeCaptcha?: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  return {
    id: "firstbank" as const,
    name: "第一銀行",

    async sync(
      config: FirstbankBrowserConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new FirstbankConnectionError(
          "第一銀行同步需要 BROWSER binding。",
        );
      }

      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      let authenticated = false;
      try {
        const pendingSessionId = config.browserSessionId;
        if (pendingSessionId && config.captcha) {
          assertSessionExpiry(config.browserSessionExpiresAt);
          assertCaptcha(config.captcha, config.captchaDigitCount);
        }

        browserInstance = await acquireBrowser(
          browserFetcher,
          pendingSessionId,
          {
            requirePreferredSession: Boolean(
              pendingSessionId && config.captcha,
            ),
          },
        );
        const pages = await browserInstance.pages();
        page = pages[0] ?? (await browserInstance.newPage());
        await configurePage(page);

        let loggedIn = false;
        if (pendingSessionId && config.captcha) {
          const outcome = await submitLoginAndWait(page, config.captcha);
          if (outcome === "credential") {
            throw new FirstbankCredentialRejectedError(
              "第一銀行身分證字號、使用者代號或密碼錯誤。",
            );
          }
          if (outcome === "captcha") {
            throw new FirstbankCaptchaRejectedError();
          }
          if (outcome !== "success") {
            throw new FirstbankVerificationRequiredError(
              "第一銀行登入結果無法確認，請重新取得圖形驗證碼。",
            );
          }
          loggedIn = true;
        } else if (config.sessionCookies) {
          await importCookies(page, config.sessionCookies);
          await gotoAllowingTimeout(page, LOGIN_URL);
          loggedIn = await hasAuthenticatedSession(page);
        }

        if (!loggedIn) {
          if (!recognizeCaptcha) {
            throw new FirstbankVerificationRequiredError(
              "第一銀行 session 已失效，需要重新登入。",
            );
          }
          await loginWithOcr(page, config, recognizeCaptcha);
        }
        authenticated = true;

        const payloads = await collectFirstbankPayloads(page);
        const data = parseFirstbankData(payloads);
        const dataWithOptionalRecords = data as typeof data & {
          bankTransactions?: unknown[];
          creditCardBills?: unknown[];
        };
        if (
          data.bankAccounts.length === 0 &&
          data.bankBalanceSnapshots.length === 0 &&
          (dataWithOptionalRecords.bankTransactions?.length ?? 0) === 0 &&
          (dataWithOptionalRecords.creditCardBills?.length ?? 0) === 0
        ) {
          throw new FirstbankConnectionError(
            "第一銀行網銀頁面解析結果為空，請確認登入狀態或網頁結構。",
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
        const normalized = mapFirstbankError(error);
        if (
          authenticated &&
          normalized instanceof FirstbankConnectionError &&
          page
        ) {
          const sessionCookies = await page
            .cookies()
            .then((cookies) => JSON.stringify(cookies))
            .catch(() => undefined);
          if (sessionCookies) {
            throw new FirstbankConnectionError(
              normalized.message,
              sessionCookies,
              new Date().toISOString(),
              normalized.cause,
            );
          }
        }
        throw normalized;
      } finally {
        if (browserInstance) await closeFirstbankBrowser(browserInstance);
      }
    },
  };
}

export async function prepareFirstbankCaptcha(
  browserFetcher?: Fetcher,
  config?: FirstbankBrowserConfig,
): Promise<PreparedFirstbankCaptcha> {
  if (!config) {
    throw new FirstbankVerificationRequiredError(
      "請填寫第一銀行身分證字號／統編、使用者代號與網銀密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new FirstbankConnectionError("第一銀行驗證需要 BROWSER binding。");
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
    await waitForSessionRelease(browserFetcher, sessionId);
    const expiresAt = new Date(Date.now() + CAPTCHA_VALIDITY_MS).toISOString();
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: expiresAt,
      captchaDigitCount: captcha.digitCount,
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(captcha.bytes)}`,
    };
  } finally {
    if (!preserved) await closeFirstbankBrowser(browserInstance);
  }
}

async function loginWithOcr(
  page: Page,
  config: FirstbankBrowserConfig,
  recognizeCaptcha: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= FIRSTBANK_AUTO_LOGIN_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const captcha = await openLoginAndCaptureCaptcha(page, config);
      const answer = await recognizeCaptcha(
        toArrayBuffer(captcha.bytes),
        captcha.digitCount,
      );
      // The public page can issue any four-to-eight digit code. A configured
      // digit count narrows validation; otherwise keep the range-only rule.
      assertCaptcha(answer, config.captchaDigitCount);
      const outcome = await submitLoginAndWait(page, answer);
      if (outcome === "success") return;
      if (outcome === "credential") {
        throw new FirstbankCredentialRejectedError(
          "第一銀行身分證字號、使用者代號或密碼錯誤。",
        );
      }
      if (outcome === "captcha") {
        lastError = new FirstbankCaptchaRejectedError();
      } else {
        lastError = new FirstbankVerificationRequiredError(
          "第一銀行登入結果無法確認，請重新取得圖形驗證碼。",
        );
      }
    } catch (error) {
      if (error instanceof FirstbankCredentialRejectedError) throw error;
      lastError = error;
    }
  }

  if (lastError instanceof FirstbankConnectionError) throw lastError;
  throw new FirstbankVerificationRequiredError(
    `第一銀行自動驗證連續失敗 ${FIRSTBANK_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

async function openLoginAndCaptureCaptcha(
  page: Page,
  config: FirstbankBrowserConfig,
): Promise<CaptchaImage> {
  await gotoAllowingTimeout(page, LOGIN_URL);
  await openLoginAndFill(page, config);

  try {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          'img[src*="code_verify1.jpg"]',
        );
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      { timeout: CAPTCHA_IMAGE_TIMEOUT_MS },
    );
  } catch {
    throw new FirstbankCaptchaUnavailableError(
      "第一銀行登入頁沒有在期限內取得圖形驗證碼。",
    );
  }

  const image = await page.$(CAPTCHA_SELECTOR);
  if (!image) {
    throw new FirstbankCaptchaUnavailableError(
      "第一銀行登入頁沒有取得圖形驗證碼。",
    );
  }
  const bytes = await image.screenshot({ type: "jpeg", quality: 90 });
  return {
    bytes: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
    digitCount: captchaDigitCount(config.captchaDigitCount),
  };
}

async function openLoginAndFill(page: Page, config: FirstbankBrowserConfig) {
  await fillInput(page, "#loginCustIdFake", config.userId ?? "");
  await fillInput(page, "#usrIdInput", config.account ?? "");
  await fillInput(page, "#pwd", config.password ?? "");
}

async function submitLoginAndWait(page: Page, captcha: string) {
  const dialog = captureDialogs(page);
  try {
    await submitLogin(page, captcha);
    return await waitForLoginResult(page, dialog);
  } finally {
    dialog.dispose();
  }
}

async function submitLogin(page: Page, captcha: string) {
  await fillInput(page, "#vrfyCode", captcha);
  try {
    await page.waitForFunction(
      () => {
        const image =
          document.querySelector<HTMLImageElement>("#captchaLoginArea");
        const area = document.querySelector<HTMLAreaElement>(
          'map[name="loginMap"] area',
        );
        const [left, top, right, bottom] = (area?.coords ?? "")
          .split(",")
          .map((value) => Number(value.trim()));
        return Boolean(
          image?.complete &&
          image.naturalWidth > 0 &&
          [left, top, right, bottom].every(Number.isFinite) &&
          right > left &&
          bottom > top &&
          image.getBoundingClientRect().width > 0 &&
          image.getBoundingClientRect().height > 0,
        );
      },
      { timeout: ACTION_TIMEOUT_MS },
    );
  } catch (error) {
    throw new FirstbankConnectionError(
      "第一銀行登入按鈕尚未載入完成，請重新取得圖形驗證碼。",
      undefined,
      undefined,
      error,
    );
  }

  const loginPoint = await withActionTimeout(
    page.evaluate(() => {
      const image =
        document.querySelector<HTMLImageElement>("#captchaLoginArea");
      const area = document.querySelector<HTMLAreaElement>(
        'map[name="loginMap"] area',
      );
      const [left, top, right, bottom] = (area?.coords ?? "")
        .split(",")
        .map((value) => Number(value.trim()));
      if (
        !image ||
        ![left, top, right, bottom].every(Number.isFinite) ||
        right <= left ||
        bottom <= top ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0
      ) {
        return null;
      }
      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + ((left + right) / 2 / image.naturalWidth) * rect.width,
        y: rect.top + ((top + bottom) / 2 / image.naturalHeight) * rect.height,
      };
    }),
  );
  if (!loginPoint) {
    throw new FirstbankConnectionError(
      "第一銀行登入按鈕格式已變更，請重新取得圖形驗證碼。",
    );
  }

  const navigation = page
    .waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  try {
    await withActionTimeout(page.mouse.click(loginPoint.x, loginPoint.y));
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
  // Public-IP / night-window confirms can block navigation. Leave the
  // wait running; waitForLoginResult clicks those prompts and classifies.
  await Promise.race([navigation, delay(LOGIN_RESULT_POLL_MS)]);
}

async function clickLoginMap(page: Page) {
  const loginPoint = await withActionTimeout(
    page.evaluate(() => {
      const image =
        document.querySelector<HTMLImageElement>("#captchaLoginArea");
      const area = document.querySelector<HTMLAreaElement>(
        'map[name="loginMap"] area',
      );
      const [left, top, right, bottom] = (area?.coords ?? "")
        .split(",")
        .map((value) => Number(value.trim()));
      if (
        !image ||
        ![left, top, right, bottom].every(Number.isFinite) ||
        right <= left ||
        bottom <= top ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0
      ) {
        return null;
      }
      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: rect.left + ((left + right) / 2 / image.naturalWidth) * rect.width,
        y: rect.top + ((top + bottom) / 2 / image.naturalHeight) * rect.height,
      };
    }),
  );
  if (!loginPoint) return false;
  try {
    await withActionTimeout(page.mouse.click(loginPoint.x, loginPoint.y));
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
  return true;
}

async function waitForLoginResult(
  page: Page,
  dialog: { readonly message: string },
): Promise<"success" | "credential" | "captcha" | "unknown"> {
  const immediate = classifyLoginMessage(dialog.message);
  if (immediate === "credential" || immediate === "captcha") return immediate;

  let deadline = Date.now() + LOGIN_RESULT_ATTEMPTS * LOGIN_RESULT_POLL_MS;
  let extendedForInterstitial = false;
  let retriedDuplicateLogin = false;

  while (Date.now() < deadline) {
    await confirmVisibleLoginPrompts(page);
    const dismissed = await dismissPostLoginNotice(page);
    if (await hasAuthenticatedSession(page)) return "success";
    const pageText = await readLoginPageText(page);
    const combined = `${dialog.message}\n${pageText}`;
    if (isMultiSessionLogin(combined)) {
      await confirmVisibleLoginPrompts(page);
      if (!extendedForInterstitial) {
        extendedForInterstitial = true;
        deadline = Math.max(deadline, Date.now() + FRAME_TIMEOUT_MS);
      }
      await delay(LOGIN_RESULT_POLL_MS);
      continue;
    }
    if (isDuplicateLoginText(combined) && !retriedDuplicateLogin) {
      retriedDuplicateLogin = true;
      await confirmVisibleLoginPrompts(page);
      await clickLoginMap(page);
      deadline = Math.max(deadline, Date.now() + FRAME_TIMEOUT_MS);
      continue;
    }
    const classified = classifyLoginMessage(combined);
    if (classified === "credential" || classified === "captcha") {
      return classified;
    }
    // login.html + 「下次再說」 is a successful-login interstitial, not a
    // captcha failure. Keep waiting for #btnOpen / frame.html.
    if (
      (dismissed ||
        isPostLoginInterstitial(page, pageText) ||
        isDuplicateLoginText(combined)) &&
      !extendedForInterstitial
    ) {
      extendedForInterstitial = true;
      deadline = Math.max(deadline, Date.now() + FRAME_TIMEOUT_MS);
    }
    await delay(LOGIN_RESULT_POLL_MS);
  }
  if (await hasAuthenticatedSession(page)) return "success";
  return "unknown";
}

function isDuplicateLoginText(text: string) {
  return (
    isMultiSessionLogin(text) ||
    /Duplicate login|重複登入|重覆登入|前次連線|previous log out/i.test(text)
  );
}

function isMultiSessionLogin(text: string) {
  return /MULTI_SESSION_LOGIN|您已成功登入個人網路銀行/.test(text);
}

function isPostLoginInterstitial(page: Page, pageText: string) {
  if (/下次再說/.test(pageText) || isMultiSessionLogin(pageText)) return true;
  try {
    return /\/NetBank\/login\.html(?:[?#]|$)/i.test(page.url());
  } catch {
    return false;
  }
}

/**
 * First Bank shows custom (non-alert) confirms after a valid login click:
 * public-IP「我是本人」and overnight-maintenance「仍要登入」. Home-network
 * recordings skip these because beforeLoginValidate.html returns false;
 * Browser Rendering is a public IP, so process() never runs unless we
 * click the same buttons the customer would.
 */
async function confirmVisibleLoginPrompts(page: Page) {
  const clickConfirms = async (target: Page | Frame) => {
    try {
      await withActionTimeout(
        target.evaluate(() => {
          const isVisible = (
            element: Element | null,
          ): element is HTMLElement => {
            if (!(element instanceof HTMLElement)) return false;
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden") {
              return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const confirmLogin = document.querySelector<HTMLElement>("#isLogIn");
          const confirmIdentity = document.querySelector<HTMLElement>("#isMe");
          const confirmButton = document.querySelector<HTMLElement>(
            "#confirmButton, #OMG",
          );
          // Overnight + public-IP requires 仍要登入 before 我是本人.
          if (isVisible(confirmLogin)) confirmLogin.click();
          if (isVisible(confirmIdentity)) confirmIdentity.click();
          if (isVisible(confirmButton)) confirmButton.click();
          const labeled = Array.from(
            document.querySelectorAll<HTMLElement>(
              "a,button,input,[role=button]",
            ),
          ).find((element) => {
            const text = (
              element.textContent ||
              (element as HTMLInputElement).value ||
              ""
            ).replace(/\s+/g, "");
            return (
              isVisible(element) &&
              /^(確定|確認|繼續登入|強制登入|關閉前次|Confirm|Got it)$/i.test(
                text,
              )
            );
          });
          labeled?.click();
        }),
      );
    } catch {
      // The login page can navigate away while the prompt is checked.
    }
  };
  await clickConfirms(page);
  for (const frame of page
    .frames()
    .filter((frame) => !isDetachedFrame(frame))) {
    await clickConfirms(frame);
  }
}

async function readLoginPageText(page: Page) {
  const chunks: string[] = [];
  const collect = async (target: Page | Frame) => {
    try {
      const text = await withActionTimeout(
        target.evaluate(() => {
          const body = document.body?.innerText ?? "";
          const loginMsg =
            document.querySelector("#login-msg")?.textContent ?? "";
          return `${body}\n${loginMsg}`;
        }),
      );
      if (typeof text === "string" && text.trim()) chunks.push(text);
    } catch {
      // A frame can be replaced while login is navigating.
    }
  };
  await collect(page);
  for (const frame of page
    .frames()
    .filter((frame) => !isDetachedFrame(frame))) {
    await collect(frame);
  }
  return chunks.join("\n");
}

async function dismissPostLoginNotice(page: Page) {
  const tryDismiss = async (target: Page | Frame) => {
    try {
      return (
        (await withActionTimeout(
          target.evaluate(() => {
            const isVisible = (element: Element | null) => {
              if (!(element instanceof HTMLElement)) return false;
              const style = window.getComputedStyle(element);
              if (style.display === "none" || style.visibility === "hidden") {
                return false;
              }
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            const labeled = Array.from(
              document.querySelectorAll<HTMLElement>(
                "a,button,input,[role=button]",
              ),
            ).find((element) => {
              const text = (
                element.textContent ||
                (element as HTMLInputElement).value ||
                ""
              )
                .replace(/\s+/g, "")
                .trim();
              return text === "下次再說" && isVisible(element);
            });
            const fallback = document.querySelector<HTMLElement>(
              "#z7UpdateNoticePersonMsg a.btn-cancel, div.mm-show a.btn-cancel",
            );
            const targetButton =
              labeled ?? (isVisible(fallback) ? fallback : null);
            if (!targetButton) return false;
            targetButton.click();
            return true;
          }),
        )) === true
      );
    } catch {
      return false;
    }
  };

  let dismissed = await tryDismiss(page);
  for (const frame of page
    .frames()
    .filter((frame) => !isDetachedFrame(frame))) {
    if (await tryDismiss(frame)) dismissed = true;
  }
  return dismissed;
}

function classifyLoginMessage(text: string) {
  if (
    /密碼錯誤|代號錯誤|使用者代號或密碼|帳號密碼不符|(身分證|統編).*(錯|不符)|登入失敗|verification failed/i.test(
      text,
    )
  ) {
    return "credential" as const;
  }
  if (
    /驗證碼.*(錯|不符|失敗)|圖形驗證碼.*(錯|不符)|只能輸入數字|驗證碼格式|請正確的點擊登入按鈕/.test(
      text,
    )
  ) {
    return "captcha" as const;
  }
  return "unknown" as const;
}

async function collectFirstbankPayloads(
  page: Page,
): Promise<FirstbankPayloads> {
  const frame = await waitForAuthenticatedFrame(page);
  const captured: CapturedCardResponses = {};
  const responseTasks: Promise<void>[] = [];
  const depositResponse = createDepositResponseCapture();
  const transactionResponse = createTransactionResponseCapture();
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("Network.enable", {
      maxTotalBufferSize: TRANSACTION_DOCUMENT_BUFFER_BYTES,
      maxResourceBufferSize: TRANSACTION_DOCUMENT_BUFFER_BYTES,
    });
  } catch (error) {
    await cdp.detach().catch(() => undefined);
    throw error;
  }
  let fetchEnabled = false;
  try {
    await cdp.send("Fetch.enable", {
      patterns: [
        {
          urlPattern: `*://${new URL(ORIGIN).host}/NetBank/2/010103*`,
          requestStage: "Response",
        },
      ],
    });
    fetchEnabled = true;
  } catch {
    logFirstbankStage("010103-fetch-unavailable", {
      path: "/NetBank/2/010103.html",
    });
  }
  const onTransactionRequest = (event: NetworkRequestWillBeSentEvent) => {
    const url = event.request?.url ?? "";
    if (!isFirstbankUrl(url)) return;
    const path = urlPathname(url);
    if (isCapturableResourceType(event.type)) {
      transactionResponse.inFlight.set(event.requestId, {
        path,
        startedAt: Date.now(),
      });
    }
    if (!isNetBankTwoPath(path)) return;
    logFirstbankStage("0101-cdp-request", {
      path,
      resourceType: event.type,
    });
    if (transactionResponse.armed && isTransactionVerificationResponse(url)) {
      transactionResponse.verificationRequested = true;
      transactionResponse.verificationRequestIds.add(event.requestId);
    }
  };
  const onTransactionDocumentResponse = (
    event: TransactionDocumentResponseEvent,
  ) => {
    const url = event.response.url;
    if (!isFirstbankUrl(url)) return;
    transactionResponse.inFlight.delete(event.requestId);
    const path = urlPathname(url);
    const status = event.response.status;
    const resourceType = event.type;
    if (isNetBankTwoPath(path) && isCapturableResourceType(resourceType)) {
      logFirstbankStage("0101-cdp-response", {
        path,
        status,
        resourceType,
      });
    }
    if (
      transactionResponse.armed &&
      isTransactionVerificationResponse(url) &&
      transactionResponse.verificationRequestIds.delete(event.requestId)
    ) {
      transactionResponse.verificationResponded = true;
      transactionResponse.verificationSettledAt = Date.now();
      if (typeof status === "number" && (status < 200 || status >= 400)) {
        transactionResponse.verificationFailed = true;
      }
      logFirstbankStage("0101-verification-response", {
        path,
        status,
        resourceType,
        elapsedMs: elapsedSinceArmed(transactionResponse),
      });
    }
    if (
      transactionResponse.armed &&
      isTransactionResultResponse(url) &&
      isCapturableResourceType(resourceType)
    ) {
      logFirstbankStage("010103-cdp-response", {
        path,
        status,
        resourceType,
        elapsedMs: elapsedSinceArmed(transactionResponse),
      });
      transactionResponse.requestIds.add(event.requestId);
      transactionResponse.documentMeta.set(event.requestId, { path, status });
    }
  };
  const onTransactionDocumentLoaded = (event: TransactionLoadingEvent) => {
    transactionResponse.inFlight.delete(event.requestId);
    if (!transactionResponse.requestIds.has(event.requestId)) return;
    const meta = transactionResponse.documentMeta.get(event.requestId);
    let task: Promise<void>;
    task = captureTransactionDocument(
      cdp,
      event.requestId,
      transactionResponse,
      meta,
    ).finally(() => {
      transactionResponse.requestIds.delete(event.requestId);
      transactionResponse.documentMeta.delete(event.requestId);
      transactionResponse.pending.delete(task);
    });
    transactionResponse.pending.add(task);
    void task.catch(() => undefined);
  };
  const onTransactionDocumentFailed = (event: TransactionLoadingEvent) => {
    transactionResponse.inFlight.delete(event.requestId);
    if (transactionResponse.verificationRequestIds.delete(event.requestId)) {
      transactionResponse.verificationFailed = true;
      transactionResponse.verificationSettledAt = Date.now();
      logFirstbankStage("0101-verification-failed", {
        path: "/NetBank/2/verifyDV.html",
        elapsedMs: elapsedSinceArmed(transactionResponse),
      });
    }
    transactionResponse.requestIds.delete(event.requestId);
    transactionResponse.documentMeta.delete(event.requestId);
  };
  const onFetchPaused = (event: FetchRequestPausedEvent) => {
    let task: Promise<void>;
    task = captureFetchPausedDocument(cdp, event, transactionResponse).finally(
      () => transactionResponse.pending.delete(task),
    );
    transactionResponse.pending.add(task);
    void task.catch(() => undefined);
  };
  cdp.on("Network.requestWillBeSent", onTransactionRequest);
  cdp.on("Network.responseReceived", onTransactionDocumentResponse);
  cdp.on("Network.loadingFinished", onTransactionDocumentLoaded);
  cdp.on("Network.loadingFailed", onTransactionDocumentFailed);
  if (fetchEnabled) cdp.on("Fetch.requestPaused", onFetchPaused);
  const onResponse = (response: BrowserResponse) => {
    if (isDepositOverviewResponse(response.url())) {
      depositResponse.observed = true;
      let task: Promise<void>;
      task = captureDepositResponse(response, depositResponse).finally(() =>
        depositResponse.pending.delete(task),
      );
      depositResponse.pending.add(task);
      void task.catch(() => undefined);
      return;
    }
    if (
      transactionResponse.armed &&
      isTransactionResultResponse(response.url())
    ) {
      logFirstbankStage("010103-http-response", {
        path: urlPathname(response.url()),
        status: httpStatus(response),
        elapsedMs: elapsedSinceArmed(transactionResponse),
      });
      let task: Promise<void>;
      task = captureTransactionResponse(response, transactionResponse).finally(
        () => transactionResponse.pending.delete(task),
      );
      transactionResponse.pending.add(task);
      void task.catch(() => undefined);
      return;
    }
    const key = cardResponseKey(response.url());
    if (!key) return;
    const task = captureCardResponse(response, key, captured);
    responseTasks.push(task);
    void task.catch(() => undefined);
  };
  page.on("response", onResponse);
  // A native confirm/alert raised by the bank's own handlers freezes the
  // renderer until it is answered, which stalls every in-flight request and
  // every CDP event for that frame. Keep one accepting listener attached for
  // the whole collection so the query can never wedge behind a dialog.
  const onDialog = (dialog: Dialog) => {
    logFirstbankStage("0101-dialog", {
      detail: describeDialog(dialog),
      elapsedMs: elapsedSinceArmed(transactionResponse),
    });
    void dialog
      .accept()
      .catch(() => dialog.dismiss().catch(() => undefined))
      .catch(() => undefined);
  };
  page.on("dialog", onDialog);
  const onPageError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (isFramesetParentNoise(message)) {
      logFirstbankStage("frameset-noise", {
        detail: "resizeFrame",
        elapsedMs: elapsedSinceArmed(transactionResponse),
      });
      return;
    }
    logFirstbankStage("page-error", {
      detail: safeDiagnosticText(message),
      elapsedMs: elapsedSinceArmed(transactionResponse),
    });
  };
  page.on("pageerror", onPageError);

  try {
    logFirstbankStage("collect-start", { path: framePathname(frame) });
    const overviewPath = urlPathname(ACCOUNT_OVERVIEW_URL);
    const overviewFrame = await navigateToReadyFrame(
      page,
      frame,
      ACCOUNT_OVERVIEW_URL,
      overviewPath,
    );
    logFirstbankStage("overview-frame", {
      path: framePathname(overviewFrame),
    });
    const depositOverviewHtml = await collectDepositOverview(
      page,
      overviewFrame,
      depositResponse,
    );
    const depositFrame = await waitForReadyFrameByPath(
      page,
      overviewPath,
      overviewFrame,
    );

    await navigateFrame(depositFrame, TRANSACTION_URL);
    const queryFrame = await waitForLiveTransactionQueryFrame(
      page,
      depositFrame,
    );
    const transactionHistoryHtml = await submitTransactionQuery(
      page,
      queryFrame,
      transactionResponse,
    );
    const cardFrame = pickLiveFrame(page, depositFrame) ?? queryFrame;

    await collectCardPayload(cardFrame, "F1632", 1, "cardBill", captured);
    await collectCardPayload(cardFrame, "F1633", 2, "recentPayments", captured);
    await collectCardPayload(cardFrame, "F1634", 3, "cardUnbilled", captured);
    await Promise.allSettled(responseTasks);

    return {
      depositOverviewHtml,
      transactionHistoryHtml,
      cardBill: captured.cardBill,
      cardUnbilled: captured.cardUnbilled,
      recentPayments: captured.recentPayments,
    } as unknown as FirstbankPayloads;
  } finally {
    if (transactionResponse.pending.size > 0) {
      await withActionTimeout(
        Promise.allSettled(Array.from(transactionResponse.pending)),
        RESULT_CAPTURE_WAIT_MS,
      ).catch(() => undefined);
    }
    page.off("response", onResponse);
    page.off("dialog", onDialog);
    page.off("pageerror", onPageError);
    cdp.off("Network.requestWillBeSent", onTransactionRequest);
    cdp.off("Network.responseReceived", onTransactionDocumentResponse);
    cdp.off("Network.loadingFinished", onTransactionDocumentLoaded);
    cdp.off("Network.loadingFailed", onTransactionDocumentFailed);
    if (fetchEnabled) {
      cdp.off("Fetch.requestPaused", onFetchPaused);
      await cdp.send("Fetch.disable").catch(() => undefined);
    }
    await cdp.detach().catch(() => undefined);
  }
}

async function collectCardPayload(
  frame: Frame,
  dataFunc: string,
  func: number,
  key: CardPayloadKey,
  captured: CapturedCardResponses,
) {
  if (Object.prototype.hasOwnProperty.call(captured, key)) return;
  await navigateFrame(frame, HOME_URL);
  const opened = await openCardFunction(frame, dataFunc);
  if (!opened) return;
  await delay(FRAME_READ_RETRY_MS * 4);
  if (await isServiceOverview(frame)) {
    await navigateFrame(
      frame,
      `${ORIGIN}/NetBank/ajax/frameFirstCard.html?func=${func}`,
    );
  }
  if (await isServiceOverview(frame)) return;
  try {
    await waitForCardResponse(captured, key);
  } catch (error) {
    if (!(error instanceof FirstbankActionTimeoutError)) throw error;
  }
}

async function openCardFunction(frame: Frame, dataFunc: string) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate((func) => {
          const link = document.querySelector<HTMLAnchorElement>(
            `a[data-func="${func}"]`,
          );
          if (!link) return false;
          const collapse = link.closest("li.collapse");
          const heading = collapse?.querySelector<HTMLElement>(":scope > h3");
          const panel = collapse?.querySelector<HTMLElement>(":scope > .panel");
          heading?.click();
          if (panel) panel.style.display = "block";
          link.click();
          return true;
        }, dataFunc),
      ),
    );
  } catch {
    return false;
  }
}

async function isServiceOverview(frame: Frame) {
  try {
    return /\/NetBank\/1\/01\.jsp(?:[?#]|$)/i.test(frame.url());
  } catch {
    return false;
  }
}

async function clickText(frame: Frame, label: string) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate((targetLabel) => {
          const normalized = targetLabel.replace(/\s+/g, "").trim();
          const elements = Array.from(
            document.querySelectorAll<HTMLElement>(
              "a,button,input,[role=button],li,span,div",
            ),
          );
          const target = elements.find((element) => {
            const text = (
              element.textContent ||
              (element as HTMLInputElement).value ||
              ""
            )
              .replace(/\s+/g, "")
              .trim();
            return text === normalized;
          });
          const clickable = target?.closest<HTMLElement>(
            "a,button,input,[role=button],li",
          );
          (clickable || target)?.click();
          return Boolean(target);
        }, label),
      ),
    );
  } catch {
    return false;
  }
}

async function waitForCardResponse(
  captured: CapturedCardResponses,
  key: CardPayloadKey,
) {
  const deadline = Date.now() + CARD_RESPONSE_TIMEOUT_MS;
  while (!Object.prototype.hasOwnProperty.call(captured, key)) {
    if (Date.now() >= deadline) {
      throw new FirstbankActionTimeoutError();
    }
    await delay(FRAME_READ_RETRY_MS);
  }
}

async function captureCardResponse(
  response: BrowserResponse,
  key: CardPayloadKey,
  captured: CapturedCardResponses,
) {
  try {
    captured[key] = await response.json();
    return;
  } catch {
    try {
      const text = await response.text();
      captured[key] = JSON.parse(text) as unknown;
    } catch {
      // A matching non-JSON response is ignored; parser must not receive an
      // invented payload that could look like a successful empty sync.
    }
  }
}

function cardResponseKey(url: string): CardPayloadKey | undefined {
  if (/sendCMSQRY0014/i.test(url)) return "cardBill";
  if (/sendCMSQRY0006/i.test(url)) return "recentPayments";
  if (/sendCMSQRY0008/i.test(url)) return "cardUnbilled";
  return undefined;
}

function createTransactionResponseCapture(): TransactionResponseCapture {
  let resolveDocumentBody = (_html: string) => {};
  const documentBody = new Promise<string>((resolve) => {
    resolveDocumentBody = resolve;
  });
  const capture: TransactionResponseCapture = {
    armed: false,
    existingResultFrames: new Set(),
    verificationRequested: false,
    verificationResponded: false,
    verificationFailed: false,
    verificationRequestIds: new Set(),
    requestIds: new Set(),
    documentMeta: new Map(),
    inFlight: new Map(),
    pending: new Set(),
    documentBody,
    settleDocumentBody(html: string) {
      capture.html ??= html;
      resolveDocumentBody(html);
    },
  };
  return capture;
}

function createDepositResponseCapture(): DepositResponseCapture {
  let resolveResponseBody = (_html: string) => {};
  const responseBody = new Promise<string>((resolve) => {
    resolveResponseBody = resolve;
  });
  const capture: DepositResponseCapture = {
    observed: false,
    pending: new Set(),
    responseBody,
    settleResponseBody(html: string) {
      capture.html = html;
      resolveResponseBody(html);
    },
  };
  return capture;
}

async function captureDepositResponse(
  response: BrowserResponse,
  capture: DepositResponseCapture,
) {
  const path = urlPathname(response.url());
  const status = httpStatus(response);
  let body = "";
  try {
    body = await response.text();
  } catch {
    // The waiter is still settled so a failed body read cannot trigger the
    // bank's request a second time.
  }
  logFirstbankStage("deposit-ajax", {
    path,
    status,
    bodyLength: body.length,
  });
  capture.status = status;
  if (
    typeof status === "number" &&
    status >= 200 &&
    status < 400 &&
    body.trim()
  ) {
    capture.settleResponseBody(body);
    return;
  }
  capture.settleResponseBody("");
}

async function captureTransactionDocument(
  cdp: CDPSession,
  requestId: string,
  capture: TransactionResponseCapture,
  meta?: TransactionDocumentMeta,
) {
  try {
    const response = await cdp.send("Network.getResponseBody", { requestId });
    const body = response.base64Encoded
      ? decodeBase64Text(response.body)
      : response.body;
    if (typeof body !== "string") {
      throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
    }
    logFirstbankStage("010103-cdp-body", {
      path: meta?.path,
      status: meta?.status,
      bodyLength: body.length,
      hasTxnDateHeader: hasTransactionDateHeader(body),
    });
    const html = transactionHistoryFromHtml(body);
    capture.settleDocumentBody(html);
  } catch {
    // Invalid or unavailable 010103 bodies do not mask a later live frame.
  }
}

async function captureTransactionResponse(
  response: BrowserResponse,
  capture: TransactionResponseCapture,
) {
  const path = urlPathname(response.url());
  const status = httpStatus(response);
  try {
    const body = await response.text();
    logFirstbankStage("010103-http-body", {
      path,
      status,
      bodyLength: body.length,
      hasTxnDateHeader: hasTransactionDateHeader(body),
    });
    const html = transactionHistoryFromHtml(body);
    capture.settleDocumentBody(html);
  } catch {
    // Invalid 010103 bodies do not mask a later CDP capture or live frame.
  }
}

async function captureFetchPausedDocument(
  cdp: CDPSession,
  event: FetchRequestPausedEvent,
  capture: TransactionResponseCapture,
) {
  const url = event.request?.url ?? "";
  const path = urlPathname(url);
  const status = event.responseStatusCode;
  let capturedHtml: string | undefined;
  try {
    if (capture.armed && isTransactionResultResponse(url)) {
      logFirstbankStage("010103-fetch-response", {
        path,
        status,
        resourceType: event.resourceType,
      });
      const response = await cdp.send("Fetch.getResponseBody", {
        requestId: event.requestId,
      });
      const body = response.base64Encoded
        ? decodeBase64Text(response.body)
        : response.body;
      if (typeof body !== "string") {
        throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
      }
      logFirstbankStage("010103-fetch-body", {
        path,
        status,
        bodyLength: body.length,
        hasTxnDateHeader: hasTransactionDateHeader(body),
      });
      capturedHtml = transactionHistoryFromHtml(body);
    }
  } catch {
    // Invalid or unavailable Fetch bodies do not mask a later live frame.
  } finally {
    await cdp
      .send("Fetch.continueRequest", { requestId: event.requestId })
      .catch(() => undefined);
  }
  if (capturedHtml !== undefined) capture.settleDocumentBody(capturedHtml);
}

async function submitTransactionQuery(
  page: Page,
  frame: Frame,
  transactionResponse: TransactionResponseCapture,
) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  let queryFrame = frame;
  for (;;) {
    queryFrame = await waitForLiveTransactionQueryFrame(
      page,
      queryFrame,
      deadline,
    );
    await dismissBankNotice(queryFrame);
    await fillTransactionDateRange(queryFrame);
    const accountFrame = await waitForQueryAccountOptions(
      page,
      queryFrame,
      deadline,
    );
    if (accountFrame !== queryFrame) {
      queryFrame = accountFrame;
      continue;
    }
    if (!(await selectQueryAccount(queryFrame))) {
      const replacement = await findLiveTransactionQueryFrame(page, queryFrame);
      if (replacement && replacement !== queryFrame) {
        queryFrame = replacement;
        continue;
      }
      throw new FirstbankConnectionError("第一銀行交易明細查詢帳號無法選取。");
    }
    const clickFrame = await waitForLiveTransactionQueryFrame(
      page,
      queryFrame,
      deadline,
    );
    if (clickFrame !== queryFrame) {
      queryFrame = clickFrame;
      continue;
    }
    break;
  }
  transactionResponse.existingResultFrames = new Set(
    liveFrames(page).filter((candidate) => isTransactionResultFrame(candidate)),
  );
  transactionResponse.armed = true;
  transactionResponse.armedAt = Date.now();
  logFirstbankStage("0101-query-submit", {
    path: urlPathname(TRANSACTION_URL),
  });
  await clickTransactionSearch(queryFrame);
  return waitForTransactionHistory(page, transactionResponse);
}

async function waitForTransactionHistory(
  page: Page,
  capture: TransactionResponseCapture,
) {
  const startedAt = Date.now();
  for (;;) {
    const captured = readyTransactionHistory(capture);
    if (captured) return captured;
    if (capture.verificationFailed) {
      throw new FirstbankConnectionError("第一銀行交易明細前置驗證沒有完成。");
    }
    const remaining =
      transactionCaptureDeadline(capture, startedAt) - Date.now();
    if (remaining <= 0) break;
    // Give the queued search click a tick to emit CDP events before probing.
    await Promise.race([
      capture.documentBody.then(() => true),
      delay(Math.min(FRAME_READ_RETRY_MS, remaining)).then(() => false),
    ]);
    const arrivedHistory = readyTransactionHistory(capture);
    if (arrivedHistory) return arrivedHistory;
    // verifyDV, when observed and still in flight, blocks the query frame's
    // renderer; Runtime.evaluate only queues behind it. Skip probes until it
    // settles. If verifyDV was never observed, still serialize a newly
    // appeared live result frame — local Chromium often never surfaces that
    // CDP event.
    if (isVerificationInFlight(capture)) continue;
    const resultFrame = await findLiveTransactionResultFrame(
      page,
      capture.existingResultFrames,
    );
    if (!resultFrame) continue;
    try {
      const html = await serializeFirstbankTables(
        resultFrame,
        FRAME_PROBE_TIMEOUT_MS,
      );
      logFirstbankStage("010103-live-frame", {
        path: urlPathname(resultFrame.url()),
        bodyLength: html.length,
        hasTxnDateHeader: hasTransactionDateHeader(html),
        elapsedMs: elapsedSinceArmed(capture),
      });
      return html;
    } catch (error) {
      if (!isTransactionHistoryReadError(error)) throw error;
    }
  }

  if (capture.pending.size > 0) {
    await withActionTimeout(
      Promise.allSettled(Array.from(capture.pending)),
      RESULT_CAPTURE_WAIT_MS,
    ).catch(() => undefined);
  }
  const captured = readyTransactionHistory(capture);
  if (captured) return captured;

  logFirstbankStage("010103-timeout", {
    path: "/NetBank/2/010103.html",
    elapsedMs: elapsedSinceArmed(capture),
  });
  for (const frame of liveFrames(page)) {
    logFirstbankStage("010103-timeout-frame", {
      path: framePathname(frame),
    });
  }
  for (const entry of capture.inFlight.values()) {
    logFirstbankStage("010103-timeout-inflight", {
      path: entry.path,
      elapsedMs: Date.now() - entry.startedAt,
    });
  }
  if (
    capture.verificationRequested &&
    (!capture.verificationResponded ||
      capture.verificationFailed ||
      capture.verificationRequestIds.size > 0)
  ) {
    throw new FirstbankConnectionError("第一銀行交易明細前置驗證沒有完成。");
  }
  throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
}

function readyTransactionHistory(capture: TransactionResponseCapture) {
  // Already-captured 010103 HTML is the fallback path. Do not wait for a
  // verifyDV CDP event that local Chromium may never emit.
  return capture.html;
}

function isVerificationInFlight(capture: TransactionResponseCapture) {
  return (
    capture.verificationRequested &&
    (!capture.verificationResponded || capture.verificationRequestIds.size > 0)
  );
}

function transactionCaptureDeadline(
  capture: TransactionResponseCapture,
  startedAt: number,
) {
  const hardDeadline = startedAt + RESULT_CAPTURE_MAX_WAIT_MS;
  if (capture.verificationRequestIds.size > 0) return hardDeadline;
  const settledAt = capture.verificationSettledAt ?? startedAt;
  return Math.min(
    Math.max(settledAt, startedAt) + RESULT_CAPTURE_WAIT_MS,
    hardDeadline,
  );
}

async function waitForLiveTransactionQueryFrame(
  page: Page,
  preferred?: Frame,
  deadline = Date.now() + ACTION_TIMEOUT_MS,
) {
  while (Date.now() < deadline) {
    const found = await findLiveTransactionQueryFrame(page, preferred);
    if (found) return found;
    await delay(FRAME_READ_RETRY_MS);
  }
  const found = await findLiveTransactionQueryFrame(page, preferred);
  if (found) return found;
  throw new FirstbankConnectionError("第一銀行交易明細查詢頁面尚未載入完成。");
}

async function findLiveTransactionQueryFrame(page: Page, preferred?: Frame) {
  const queryPath = urlPathname(TRANSACTION_URL);
  const frames = liveFrames(page);
  const preferredIsLive = preferred !== undefined && frames.includes(preferred);
  const candidates = preferredIsLive
    ? framePathname(preferred) === queryPath
      ? [preferred]
      : []
    : frames.filter(
        (frame) => frame !== preferred && framePathname(frame) === queryPath,
      );
  for (const frame of candidates) {
    if (!(await isFrameDocumentReady(frame))) continue;
    if (await hasTransactionSearchControl(frame)) return frame;
  }
  return undefined;
}

async function hasTransactionSearchControl(frame: Frame) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate(() =>
          Boolean(document.querySelector("#searchBtn, input[name=showList]")),
        ),
        FRAME_PROBE_TIMEOUT_MS,
      ),
    );
  } catch {
    return false;
  }
}

async function findLiveTransactionResultFrame(
  page: Page,
  excludedFrames: ReadonlySet<Frame>,
) {
  for (const frame of liveFrames(page)) {
    if (excludedFrames.has(frame)) continue;
    let isResultUrl = false;
    try {
      isResultUrl = isTransactionResultResponse(frame.url());
    } catch {
      isResultUrl = false;
    }
    if (isResultUrl) {
      await dismissBankNotice(frame, FRAME_PROBE_TIMEOUT_MS);
    }
    if (await hasTransactionResultHeader(frame, FRAME_PROBE_TIMEOUT_MS)) {
      return frame;
    }
  }
  return undefined;
}

function isTransactionResultFrame(frame: Frame) {
  try {
    return isTransactionResultResponse(frame.url());
  } catch {
    return false;
  }
}

async function fillTransactionDateRange(frame: Frame) {
  const end = formatTaipeiDate(Date.now());
  const start = formatTaipeiDate(Date.now() - 31 * 24 * 60 * 60 * 1000);
  try {
    await withActionTimeout(
      frame.evaluate(
        (range: { start: string; end: string }) => {
          const startInput = document.querySelector<HTMLInputElement>(
            "#txnStart, [name=txnStart]",
          );
          const endInput = document.querySelector<HTMLInputElement>(
            "#txnEnd, [name=txnEnd]",
          );
          if (startInput) {
            startInput.value = range.start;
            startInput.dispatchEvent(new Event("input", { bubbles: true }));
            startInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (endInput) {
            endInput.value = range.end;
            endInput.dispatchEvent(new Event("input", { bubbles: true }));
            endInput.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { start, end },
      ),
    );
  } catch {
    // Query page may not include a date range.
  }
}

function formatTaipeiDate(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}/${value("month")}/${value("day")}`;
}

async function waitForQueryAccountOptions(
  page: Page,
  preferred: Frame,
  deadline = Date.now() + ACTION_TIMEOUT_MS,
) {
  while (Date.now() < deadline) {
    const frame = await findLiveTransactionQueryFrame(page, preferred);
    if (!frame) {
      await delay(FRAME_READ_RETRY_MS);
      continue;
    }
    if (await selectQueryAccount(frame, true)) return frame;
    await delay(FRAME_READ_RETRY_MS);
  }
  throw new FirstbankConnectionError("第一銀行交易明細查詢帳號無法選取。");
}

async function selectQueryAccount(frame: Frame, dryRun = false) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate((shouldSelect) => {
          type QueryAccountSelect = {
            options: ArrayLike<{
              selected: boolean;
              text: string;
              value: string;
            }>;
            selectedIndex: number;
            value: string;
            dispatchEvent: (event: Event) => boolean;
          };
          const isPlaceholder = (text: string, value: string) => {
            const normalized = text.replace(/\s+/g, "");
            return (
              !value.trim() ||
              value.trim() === "0" ||
              /請選擇|選擇帳號|pleaseselect|selectaccount|^-+$/i.test(
                normalized,
              )
            );
          };
          const select = document.querySelector(
            'select[name="acnt"]',
          ) as QueryAccountSelect | null;
          if (!select) return false;
          const option = Array.from(select.options).find(
            (candidate) => !isPlaceholder(candidate.text, candidate.value),
          );
          if (!option) return false;
          if (!shouldSelect) return true;
          select.value = option.value;
          option.selected = true;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
          const selected = select.options[select.selectedIndex];
          return (
            select.value === option.value &&
            selected !== undefined &&
            !isPlaceholder(selected.text, selected.value)
          );
        }, !dryRun),
      ),
    );
  } catch {
    return false;
  }
}

async function clickTransactionSearch(frame: Frame) {
  let submitted = false;
  try {
    submitted = Boolean(
      await withActionTimeout(
        frame.evaluate(() => {
          const searchBtn = document.querySelector<HTMLElement>(
            "#searchBtn, input[name=showList]",
          );
          if (!searchBtn) return false;
          // First Bank's click handler performs a synchronous verifyDV XHR.
          // Let Runtime.evaluate return before that handler starts so Browser
          // Run can continue delivering the response and navigation events.
          setTimeout(() => searchBtn.click(), 0);
          return true;
        }),
      ),
    );
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
    // The queued click can navigate or replace the iframe immediately after
    // Runtime.evaluate returns. Network listeners remain armed above.
    submitted = true;
  }
  if (!submitted) {
    throw new FirstbankConnectionError("第一銀行交易明細查詢按鈕格式已變更。");
  }
}

async function dismissBankNotice(frame: Frame, timeoutMs = ACTION_TIMEOUT_MS) {
  try {
    await withActionTimeout(
      frame.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            "#alertMsg a, div.mm-show a, a.btn-cancel, a.btn-ok",
          ),
        );
        const match = nodes.find((element) => {
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const text = (element.textContent || "").replace(/\s+/g, "");
          return /我知道了|下次再說|確定|關閉/.test(text);
        });
        match?.click();
        return Boolean(match);
      }),
      timeoutMs,
    );
  } catch {
    // Notice may already be gone after navigation.
  }
}

async function hasTransactionResultHeader(
  frame: Frame,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("tr"));
          return rows.some((row) => {
            const text = (row.innerText || "").replace(/\s+/g, " ");
            return (
              /交易日期|交易日/.test(text) && /支出|存入|交易金額/.test(text)
            );
          });
        }),
        timeoutMs,
      ),
    );
  } catch {
    return false;
  }
}

async function navigateFrame(frame: Frame, url: string) {
  try {
    await withActionTimeout(
      frame.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
}

async function navigateToReadyFrame(
  page: Page,
  frame: Frame,
  url: string,
  path: string,
) {
  const target = nestedContentFrame(page, frame);
  if (framePathname(target) !== path) await navigateFrame(target, url);
  return waitForReadyFrameByPath(page, path, target);
}

function nestedContentFrame(page: Page, preferred: Frame) {
  const main = (page as Page & { mainFrame?: () => Frame }).mainFrame?.();
  if (!main || preferred !== main) return preferred;
  const nested = liveFrames(page).find((candidate) => candidate !== main);
  return nested ?? preferred;
}

async function waitForReadyFrameByPath(
  page: Page,
  path: string,
  _preferred?: Frame,
) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidates = liveFrames(page).filter(
      (candidate) => framePathname(candidate) === path,
    );
    for (const candidate of candidates) {
      if (await isFrameDocumentReady(candidate)) return candidate;
    }
    await delay(FRAME_READ_RETRY_MS);
  }
  throw new FirstbankConnectionError("第一銀行存款總覽頁面尚未載入完成。");
}

async function isFrameDocumentReady(frame: Frame) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate(() =>
          Boolean(
            document.body &&
            (document.readyState === "interactive" ||
              document.readyState === "complete"),
          ),
        ),
        FRAME_PROBE_TIMEOUT_MS,
      ),
    );
  } catch {
    return false;
  }
}

async function collectDepositOverview(
  page: Page,
  frame: Frame,
  capture: DepositResponseCapture,
) {
  if (!capture.observed) {
    const triggered = await triggerDepositOverview(page, frame);
    if (!triggered) {
      throw new FirstbankConnectionError("第一銀行存款總覽按鈕格式已變更。");
    }
  }
  const html = await withActionTimeout(
    capture.responseBody,
    DEPOSIT_CAPTURE_WAIT_MS,
  ).catch(() => "");
  if (html) return html;
  if (capture.pending.size > 0) {
    await withActionTimeout(
      Promise.allSettled(Array.from(capture.pending)),
      FRAME_PROBE_TIMEOUT_MS,
    ).catch(() => undefined);
  }
  if (capture.html) return capture.html;
  if (capture.observed) {
    logFirstbankStage("deposit-ajax-failed", {
      path: DEPOSIT_AJAX_PATH,
      status: capture.status,
      detail: "empty-or-error-response",
    });
    // The native handler already issued the bank POST. Never click or POST
    // again after a captured non-2xx / empty body.
    throw new FirstbankConnectionError("第一銀行存款總覽讀取失敗。");
  }
  logFirstbankStage("deposit-ajax-fallback", {
    path: DEPOSIT_AJAX_PATH,
    detail: "missing-listener",
  });
  // Click did not surface a capturable page response. Do not click again;
  // read the same-origin ajax endpoint from inside the live overview frame.
  const liveFrame = liveDepositOverviewFrame(page, frame);
  return fetchDepositOverview(liveFrame);
}

function liveDepositOverviewFrame(page: Page, preferred: Frame) {
  const path = urlPathname(ACCOUNT_OVERVIEW_URL);
  const nested = nestedContentFrame(page, preferred);
  const frames = liveFrames(page);
  const ready =
    frames.find((candidate) => framePathname(candidate) === path) ??
    (frames.includes(nested) ? nested : undefined) ??
    (frames.includes(preferred) ? preferred : undefined) ??
    frames[0];
  if (!ready) {
    throw new FirstbankConnectionError("第一銀行存款總覽讀取失敗。");
  }
  return ready;
}

async function fetchDepositOverview(frame: Frame): Promise<string> {
  try {
    const value = await withActionTimeout(
      frame.evaluate(async (resourcePath) => {
        try {
          const response = await fetch(resourcePath, {
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "text/html, application/json" },
          });
          return {
            ok: response.ok,
            status: response.status,
            text: await response.text(),
          };
        } catch {
          return { ok: false, status: 0, text: "" };
        }
      }, DEPOSIT_AJAX_PATH),
    );
    if (isRecord(value) && typeof value.status === "number") {
      const body = typeof value.text === "string" ? value.text : "";
      logFirstbankStage("deposit-ajax", {
        path: DEPOSIT_AJAX_PATH,
        status: value.status,
        bodyLength: body.length,
      });
      if (value.ok === true && body.trim()) return body;
    }
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
  logFirstbankStage("deposit-ajax-failed", {
    path: DEPOSIT_AJAX_PATH,
    detail: "fallback-fetch",
  });
  throw new FirstbankConnectionError("第一銀行存款總覽讀取失敗。");
}

async function triggerDepositOverview(page: Page, preferred: Frame) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frames = liveFrames(page);
    const preferredIsLive = frames.includes(preferred);
    const candidates = preferredIsLive
      ? framePathname(preferred) === urlPathname(ACCOUNT_OVERVIEW_URL)
        ? [preferred]
        : []
      : frames.filter(
          (candidate) =>
            candidate !== preferred &&
            framePathname(candidate) === urlPathname(ACCOUNT_OVERVIEW_URL),
        );
    for (const frame of candidates) {
      if (!(await isFrameDocumentReady(frame))) continue;
      const selector = await findDepositTrigger(frame);
      if (selector === undefined) continue;
      try {
        await withActionTimeout(frame.click(selector));
        return true;
      } catch (error) {
        if (isRecoverableFrameError(error)) {
          // The original click may already be executing in the page. Listeners
          // are armed before it, so wait for that one response instead of
          // re-clicking on either this frame or a replacement.
          return true;
        }
        throw error;
      }
    }
    await delay(FRAME_READ_RETRY_MS);
  }
  return false;
}

async function findDepositTrigger(frame: Frame) {
  try {
    const selector = await withActionTimeout(
      frame.evaluate(() => {
        const isVisible = (element: Element | null) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const depositTriggerSelector = "#btnOpen a";
        if (isVisible(document.querySelector(depositTriggerSelector))) {
          return depositTriggerSelector;
        }
        const typeSelector =
          '#overview-account a[onclick*="chgAcntReviewType(\'1\')"], a[href="#tab1"]';
        return isVisible(document.querySelector(typeSelector))
          ? typeSelector
          : undefined;
      }),
      FRAME_PROBE_TIMEOUT_MS,
    );
    return typeof selector === "string" ? selector : undefined;
  } catch {
    // A read-only selector probe can be retried on a replacement frame because
    // no bank request has been dispatched yet.
    return undefined;
  }
}

async function serializeFirstbankTables(
  frame: Frame,
  timeoutMs = ACTION_TIMEOUT_MS,
): Promise<string> {
  const serialized = await withActionTimeout(
    frame.evaluate(() => {
      const escape = (value: string) =>
        value
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      return Array.from(document.querySelectorAll("table"))
        .map((table) => {
          const rows = Array.from(table.rows);
          if (rows.length === 0) return "";
          const rowHtml = rows
            .map((row) => {
              const className = row.getAttribute("class");
              const rowAttributes = className
                ? ` class="${escape(className)}"`
                : "";
              const cells = Array.from(row.cells)
                .map((cell) => {
                  const text = (cell.innerText || cell.textContent || "")
                    .replace(/\s+/g, " ")
                    .trim();
                  return `<td>${escape(text)}</td>`;
                })
                .join("");
              return `<tr${rowAttributes}>${cells}</tr>`;
            })
            .join("");
          return `<table>${rowHtml}</table>`;
        })
        .filter(Boolean)
        .join("\n");
    }),
    timeoutMs,
  ).catch(() => "");

  if (typeof serialized === "string" && serialized.trim()) {
    return assertSerializedTransactionTables(serialized);
  }
  throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
}

async function waitForAuthenticatedFrame(
  page: Page,
  timeoutMs = FRAME_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const markedFrame = await findMarkedFrame(page);
    if (markedFrame) return markedFrame;
    const frame = findAuthenticatedFrame(page);
    if (frame) return frame;
    const mainFrame = await mainAuthenticatedFrame(page);
    if (mainFrame) return mainFrame;
    await delay(FRAME_READ_RETRY_MS);
  }
  throw new FirstbankConnectionError(
    "未能從第一銀行網銀載入 authenticated frame，請確認登入狀態或重試。",
  );
}

function findAuthenticatedFrame(page: Page): Frame | undefined {
  const frames = page.frames().filter((frame) => !isDetachedFrame(frame));
  return frames.find((frame) =>
    /\/NetBank\/frame\.html(?:[?#]|$)/i.test(frame.url()),
  );
}

async function findMarkedFrame(page: Page) {
  for (const frame of page
    .frames()
    .filter((candidate) => !isDetachedFrame(candidate))) {
    try {
      const marked = await withActionTimeout(
        frame.evaluate(() =>
          Boolean(document.querySelector("#btnOpen, #tFunc")),
        ),
      );
      if (marked === true) return frame;
    } catch {
      // A frame can be replaced while login is navigating.
    }
  }
  return undefined;
}

async function mainAuthenticatedFrame(page: Page) {
  const mainFrame = (page as Page & { mainFrame?: () => Frame }).mainFrame?.();
  if (!mainFrame) return undefined;
  if (/\/NetBank\/frame\.html(?:[?#]|$)/i.test(page.url())) return mainFrame;
  try {
    const marked = await withActionTimeout(
      mainFrame.evaluate(() =>
        Boolean(document.querySelector("#btnOpen, #tFunc")),
      ),
    );
    return marked === true ? mainFrame : undefined;
  } catch {
    return undefined;
  }
}

async function hasAuthenticatedSession(page: Page) {
  if (/\/NetBank\/frame\.html(?:[?#]|$)/i.test(page.url())) return true;
  if (findAuthenticatedFrame(page)) return true;
  if (await findMarkedFrame(page)) return true;
  for (const selector of ["#btnOpen", "#tFunc"]) {
    if (await page.$(selector)) return true;
  }
  try {
    const marker = await withActionTimeout(
      page.evaluate(() => Boolean(document.querySelector("#btnOpen, #tFunc"))),
    );
    if (marker === true) return true;
  } catch {
    // A login page can be navigating while the marker is checked.
  }
  return false;
}

async function acquireBrowser(
  browserFetcher: Fetcher,
  preferredSessionId?: string,
  options: { requirePreferredSession?: boolean } = {},
) {
  if (preferredSessionId) {
    let sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
    let preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      await waitForSessionRelease(browserFetcher, preferredSessionId);
      sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
      preferred = sessions.find(
        (session) => session.sessionId === preferredSessionId,
      );
    }
    if (preferred) {
      try {
        return await puppeteer.connect(browserFetcher, preferred.sessionId);
      } catch {
        throw new FirstbankBrowserCapacityError(
          "前一個第一銀行驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
    if (options.requirePreferredSession) {
      throw new FirstbankVerificationRequiredError(
        "第一銀行圖形驗證碼工作階段已失效，請重新取得驗證碼。",
      );
    }
  }

  const limits = await puppeteer.limits(browserFetcher).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new FirstbankBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再取得驗證碼。",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  return launchBrowser(browserFetcher);
}

async function waitForSessionRelease(
  browserFetcher: Fetcher,
  sessionId: string,
) {
  const deadline = Date.now() + SESSION_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
    const session = sessions.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!session?.connectionId) return;
    await delay(SESSION_RELEASE_POLL_MS);
  }
}

async function launchBrowser(browserFetcher: Fetcher): Promise<Browser> {
  try {
    return await puppeteer.launch(browserFetcher, {
      keep_alive: CAPTCHA_KEEP_ALIVE_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new FirstbankBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完，請於額度重置後再試。",
        60,
      );
    }
    if (/429|rate limit|capacity|too many/i.test(message)) {
      throw new FirstbankBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限，請稍後重試。",
      );
    }
    throw error;
  }
}

async function closeFirstbankBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch {
    // Cleanup must not replace the primary connector result and no provider
    // response or cookie value is written to logs.
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

async function fillInput(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector, { timeout: NAVIGATION_TIMEOUT_MS });
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
    await dialog.accept().catch(() => undefined);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new FirstbankVerificationRequiredError(
      "第一銀行 session 格式無效，需要重新登入。",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FirstbankVerificationRequiredError(
      "第一銀行 session 格式無效，需要重新登入。",
    );
  }
  const safeCookies = parsed.filter(isRecord).filter((cookie) => {
    const domain = String(cookie.domain ?? "")
      .replace(/^\./, "")
      .toLowerCase();
    return (
      !domain ||
      domain === "firstbank.com.tw" ||
      domain.endsWith(".firstbank.com.tw")
    );
  }) as unknown as CookieParam[];
  if (safeCookies.length > 0) await page.setCookie(...safeCookies);
}

function requireCredentials(config: FirstbankBrowserConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new FirstbankVerificationRequiredError(
      "請填寫第一銀行身分證字號／統編、使用者代號與網銀密碼。",
    );
  }
}

function assertSessionExpiry(expiresAt: string | undefined) {
  if (
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  ) {
    throw new FirstbankVerificationRequiredError(
      "第一銀行圖形驗證碼已逾時，請重新取得驗證碼。",
    );
  }
}

function captchaDigitCount(value: number | undefined) {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CAPTCHA_DIGIT_MIN &&
    value <= CAPTCHA_DIGIT_MAX
  ) {
    return value;
  }
  return FIRSTBANK_CAPTCHA_DIGIT_COUNT;
}

function assertCaptcha(value: string, expectedDigitCount?: number) {
  const expected =
    typeof expectedDigitCount === "number"
      ? captchaDigitCount(expectedDigitCount)
      : undefined;
  if (
    !/^[A-Za-z0-9]{4,8}$/.test(value) ||
    (expected !== undefined && value.length !== expected)
  ) {
    throw new FirstbankCaptchaRejectedError(
      expected
        ? `第一銀行驗證碼必須是 ${expected} 位英數字。`
        : "第一銀行驗證碼必須是 4 至 8 位英數字。",
    );
  }
}

function mapFirstbankError(error: unknown): Error {
  if (
    error instanceof FirstbankVerificationRequiredError ||
    error instanceof FirstbankBrowserCapacityError ||
    error instanceof FirstbankConnectionError
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FirstbankConnectionError(
    `第一銀行連線失敗：${safeErrorMessage(message)}`,
    undefined,
    undefined,
    error,
  );
}

function safeErrorMessage(value: string) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\b[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isRecoverableFrameError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    error instanceof FirstbankActionTimeoutError ||
    /Execution context was destroyed|Cannot find context|Navigating frame was detached|Waiting failed: Frame detached|frame got detached|detached frame|Target closed|Navigation timeout of \d+ ms exceeded|timed out.*protocolTimeout|Runtime\.callFunctionOn timed out/i.test(
      message,
    )
  );
}

async function gotoAllowingTimeout(page: Page, url: string) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (!/Navigation timeout of \d+ ms exceeded/i.test(errorMessage(error))) {
      throw error;
    }
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDetachedFrame(frame: Frame) {
  return Boolean((frame as Frame & { detached?: boolean }).detached);
}

function liveFrames(page: Page) {
  return page.frames().filter((frame) => !isDetachedFrame(frame));
}

function pickLiveFrame(page: Page, preferred?: Frame) {
  if (
    preferred &&
    !isDetachedFrame(preferred) &&
    liveFrames(page).includes(preferred)
  ) {
    return preferred;
  }
  return liveFrames(page)[0];
}

function isTransactionResultResponse(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN) return false;
    const path = parsed.pathname.toLowerCase().split(";")[0];
    return /\/netbank\/2\/010103(?:\.html?)?$/.test(path);
  } catch {
    return false;
  }
}

function isDepositOverviewResponse(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === ORIGIN &&
      parsed.pathname.toLowerCase().split(";")[0] ===
        DEPOSIT_AJAX_PATH.toLowerCase()
    );
  } catch {
    return false;
  }
}

function isTransactionVerificationResponse(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === ORIGIN &&
      parsed.pathname.toLowerCase().split(";")[0] === "/netbank/2/verifydv.html"
    );
  } catch {
    return false;
  }
}

function isFirstbankUrl(url: string) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function isNetBankTwoPath(path: string) {
  return /\/netbank\/2\//i.test(path);
}

function isCapturableResourceType(type: string | undefined) {
  if (!type) return true;
  return /^(document|xhr|fetch|other)$/i.test(type);
}

function framePathname(frame: Frame) {
  try {
    return urlPathname(frame.url());
  } catch {
    return "(unavailable)";
  }
}

function urlPathname(url: string) {
  try {
    return new URL(url).pathname.split(";")[0];
  } catch {
    return "(invalid)";
  }
}

function httpStatus(response: BrowserResponse) {
  try {
    return response.status();
  } catch {
    return undefined;
  }
}

function isFramesetParentNoise(message: string) {
  return /resizeFrame is not a function/i.test(message);
}

function hasTransactionDateHeader(html: string) {
  return /交易日期|交易日/.test(html);
}

function logFirstbankStage(
  stage: string,
  fields: {
    path?: string;
    status?: number;
    bodyLength?: number;
    hasTxnDateHeader?: boolean;
    resourceType?: string;
    elapsedMs?: number;
    detail?: string;
  } = {},
) {
  const parts = [`[firstbank] ${stage}`];
  if (fields.path !== undefined) parts.push(`path=${fields.path}`);
  if (fields.status !== undefined) parts.push(`status=${fields.status}`);
  if (fields.bodyLength !== undefined) {
    parts.push(`bodyLength=${fields.bodyLength}`);
  }
  if (fields.hasTxnDateHeader !== undefined) {
    parts.push(`hasTxnDateHeader=${fields.hasTxnDateHeader}`);
  }
  if (fields.resourceType !== undefined) {
    parts.push(`resourceType=${fields.resourceType}`);
  }
  if (fields.elapsedMs !== undefined) {
    parts.push(`elapsedMs=${fields.elapsedMs}`);
  }
  if (fields.detail !== undefined) parts.push(`detail=${fields.detail}`);
  console.log(parts.join(" "));
}

function elapsedSinceArmed(capture: TransactionResponseCapture) {
  if (capture.armedAt === undefined) return undefined;
  return Date.now() - capture.armedAt;
}

function describeDialog(dialog: Dialog) {
  let type = "unknown";
  let message = "";
  try {
    type = dialog.type();
  } catch {
    type = "unknown";
  }
  try {
    message = dialog.message();
  } catch {
    message = "";
  }
  return `${type}:${safeDiagnosticText(message)}`;
}

// Dialog and page error text can quote balances or account numbers, so every
// digit is masked and token/URL-shaped content is redacted before the message
// reaches the logs.
function safeDiagnosticText(value: string) {
  return safeErrorMessage(maskDigits(value)).slice(0, 120);
}

function maskDigits(value: string) {
  return value.replace(/\d/g, "#").replace(/\s+/g, " ").trim().slice(0, 120);
}

function isTransactionHistoryReadError(error: unknown) {
  return (
    error instanceof FirstbankConnectionError &&
    error.message === "第一銀行交易明細讀取失敗。"
  );
}

function transactionHistoryFromHtml(html: string) {
  const trimmed = html.trim();
  if (!trimmed) {
    throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
  }
  const tables = Array.from(trimmed.matchAll(/<table\b[\s\S]*?<\/table>/gi))
    .map((match) => match[0])
    .join("\n");
  if (!tables.trim()) {
    throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
  }
  return assertSerializedTransactionTables(tables);
}

function assertSerializedTransactionTables(html: string) {
  if (html.length > MAX_SERIALIZED_TABLE_BYTES) {
    throw new FirstbankConnectionError(
      "第一銀行交易明細資料量超過單次同步上限。",
    );
  }
  if (!/交易日期|交易日/.test(html) || !/支出|存入|交易金額/.test(html)) {
    throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
  }
  return html;
}

async function withActionTimeout<T>(
  action: Promise<T>,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  action.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new FirstbankActionTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function bytesToBase64(bytes: Uint8Array | string) {
  if (typeof bytes === "string") return bytes;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Text(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
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
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
