import puppeteer, {
  type Browser,
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
// 010103 may replace and detach its iframe in Browser Rendering. Probe only
// briefly before using the response body already captured from the same click.
const RESULT_FRAME_WAIT_MS = 2_000;
const FRAME_PROBE_TIMEOUT_MS = 1_000;
const CARD_RESPONSE_TIMEOUT_MS = 10_000;
const SESSION_RELEASE_TIMEOUT_MS = 2_000;
const SESSION_RELEASE_POLL_MS = 100;
const MAX_SERIALIZED_TABLE_BYTES = 512 * 1024;
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

type TransactionResponseCapture = {
  armed: boolean;
  html?: string;
  pending: Set<Promise<void>>;
};

type BrowserResponse = {
  url(): string;
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
  const transactionResponse: TransactionResponseCapture = {
    armed: false,
    pending: new Set(),
  };
  const onResponse = (response: BrowserResponse) => {
    if (
      transactionResponse.armed &&
      isTransactionResultResponse(response.url())
    ) {
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

  try {
    await navigateFrame(frame, ACCOUNT_OVERVIEW_URL);
    const depositAjax = await fetchFrameResource(frame, DEPOSIT_AJAX_PATH);
    await waitForDepositOverview(frame);

    await navigateFrame(frame, TRANSACTION_URL);
    const queryFrame = await waitForLiveTransactionQueryFrame(page, frame);
    const transactionHistoryHtml = await submitTransactionQuery(
      page,
      queryFrame,
      transactionResponse,
    );
    const cardFrame = pickLiveFrame(page, frame) ?? queryFrame;

    await collectCardPayload(cardFrame, "F1632", 1, "cardBill", captured);
    await collectCardPayload(cardFrame, "F1633", 2, "recentPayments", captured);
    await collectCardPayload(cardFrame, "F1634", 3, "cardUnbilled", captured);
    await Promise.allSettled(responseTasks);

    return {
      depositOverviewHtml: depositAjax,
      transactionHistoryHtml,
      cardBill: captured.cardBill,
      cardUnbilled: captured.cardUnbilled,
      recentPayments: captured.recentPayments,
    } as unknown as FirstbankPayloads;
  } finally {
    page.off("response", onResponse);
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

async function captureTransactionResponse(
  response: BrowserResponse,
  capture: TransactionResponseCapture,
) {
  try {
    const html = transactionHistoryFromHtml(await response.text());
    capture.html ??= html;
  } catch {
    // Invalid 010103 bodies do not mask a later live frame or valid response.
  }
}

async function submitTransactionQuery(
  page: Page,
  frame: Frame,
  transactionResponse: TransactionResponseCapture,
) {
  await dismissBankNotice(frame);
  await fillTransactionDateRange(frame);
  await waitForQueryAccountOptions(frame);
  await selectQueryAccount(frame);
  transactionResponse.armed = true;
  await clickTransactionSearch(frame);

  const resultFrame = await waitForLiveTransactionResultFrame(
    page,
    transactionResponse,
  );
  if (resultFrame) {
    try {
      return await serializeFirstbankTables(resultFrame);
    } catch (error) {
      if (!isTransactionHistoryReadError(error)) throw error;
    }
  }

  if (transactionResponse.html) return transactionResponse.html;
  if (transactionResponse.pending.size > 0) {
    await withActionTimeout(
      Promise.allSettled(transactionResponse.pending),
      FRAME_PROBE_TIMEOUT_MS,
    ).catch(() => undefined);
    if (transactionResponse.html) return transactionResponse.html;
  }
  throw new FirstbankConnectionError("第一銀行交易明細讀取失敗。");
}

async function waitForDepositOverview(frame: Frame) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await hasDepositOverview(frame)) return;
    await delay(FRAME_READ_RETRY_MS);
  }
}

async function hasDepositOverview(frame: Frame) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate(() => {
          const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
          return /帳號/.test(text) && /帳面餘額|可用餘額|存款餘額/.test(text);
        }),
      ),
    );
  } catch {
    return false;
  }
}

async function waitForLiveTransactionQueryFrame(page: Page, preferred?: Frame) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await findLiveTransactionQueryFrame(page);
    if (found) return found;
    await delay(FRAME_READ_RETRY_MS);
  }
  const found = await findLiveTransactionQueryFrame(page);
  if (found) return found;
  if (
    preferred &&
    !isDetachedFrame(preferred) &&
    liveFrames(page).includes(preferred)
  ) {
    return preferred;
  }
  return waitForAuthenticatedFrame(page);
}

async function findLiveTransactionQueryFrame(page: Page) {
  for (const frame of liveFrames(page)) {
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
      ),
    );
  } catch {
    return false;
  }
}

async function waitForLiveTransactionResultFrame(
  page: Page,
  transactionResponse: TransactionResponseCapture,
) {
  const deadline = Date.now() + RESULT_FRAME_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await findLiveTransactionResultFrame(page);
    if (result) return result;
    if (transactionResponse.html) return undefined;
    await delay(FRAME_READ_RETRY_MS);
  }
  return findLiveTransactionResultFrame(page);
}

async function findLiveTransactionResultFrame(page: Page) {
  for (const frame of liveFrames(page)) {
    if (!isTransactionResultResponse(frame.url())) continue;
    await dismissBankNotice(frame, FRAME_PROBE_TIMEOUT_MS);
    if (await hasTransactionResultHeader(frame, FRAME_PROBE_TIMEOUT_MS)) {
      return frame;
    }
  }
  return undefined;
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

async function waitForQueryAccountOptions(frame: Frame) {
  const deadline = Date.now() + ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await selectQueryAccount(frame, true)) return;
    await delay(FRAME_READ_RETRY_MS);
  }
}

async function selectQueryAccount(frame: Frame, dryRun = false) {
  try {
    return Boolean(
      await withActionTimeout(
        frame.evaluate((shouldSelect) => {
          const isPlaceholder = (text: string, value: string) => {
            const normalized = text.replace(/\s+/g, "");
            return !value.trim() || /請選擇|選擇帳號|^-+$/.test(normalized);
          };
          const select = Array.from(document.querySelectorAll("select")).find(
            (candidate) =>
              Array.from(candidate.options).some(
                (option) => !isPlaceholder(option.text, option.value),
              ),
          );
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
          return select.value === option.value;
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
          searchBtn.click();
          return true;
        }),
      ),
    );
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
    // The native click can destroy the iframe execution context immediately.
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

async function fetchFrameResource(frame: Frame, path: string): Promise<string> {
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
      }, path),
    );
    if (
      isRecord(value) &&
      value.ok === true &&
      typeof value.text === "string"
    ) {
      return value.text;
    }
  } catch (error) {
    if (!isRecoverableFrameError(error)) throw error;
  }
  throw new FirstbankConnectionError("第一銀行存款總覽讀取失敗。");
}

async function serializeFirstbankTables(frame: Frame): Promise<string> {
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
    /Execution context was destroyed|Cannot find context|detached Frame|Target closed|Navigation timeout of \d+ ms exceeded|timed out.*protocolTimeout|Runtime\.callFunctionOn timed out/i.test(
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
    return (
      parsed.origin === ORIGIN &&
      parsed.pathname.toLowerCase() === "/netbank/2/010103.html"
    );
  } catch {
    return false;
  }
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
