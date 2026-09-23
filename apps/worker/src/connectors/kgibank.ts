import { launchBrowserWithRetry } from "./browser.js";
import puppeteer, {
  type Browser,
  type Frame,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
} from "@cloudflare/puppeteer";
import {
  KGIBANK_CAPTCHA_DIGIT_COUNT,
  KgibankProtocolError,
  parseKgibankAccounts,
  parseKgibankData,
  type KgibankConfig,
} from "@taiwan-fin-hub/connectors";
import type { SyncResult } from "@taiwan-fin-hub/core";

// 凱基網銀預設由 Workers AI 辨識圖形驗證碼；prepareKgibankCaptcha
// 保留人工 fallback，會讓 sync 接回同一個 Browser session 送出登入。
const LOGIN_URL = "https://ib.kgibank.com.tw/ibank/";
const APP_ORIGIN = "https://ib.kgibank.com.tw";
const GATEWAY_PATH = "/gateway/prod-aggregators/api/";
const TOKEN_PATH = "/gateway/prod-oidc/connect/token";
const LOGOUT_PATH = "/gateway/prod-oidc/Account/AccountLogout/Logout";
const ACCOUNTS_PATH = `${GATEWAY_PATH}Deposit/TwdDemandDepositDetail/AcctQuery`;
const TRANSACTIONS_PATH = `${GATEWAY_PATH}Deposit/TwdDemandDepositDetail/TxnQuery`;
const SYNC_MONTHS = 3;

export const KGIBANK_AUTO_LOGIN_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const LOGIN_FORM_TIMEOUT_MS = 30_000;
const LOGIN_RESULT_TIMEOUT_MS = 25_000;
const LOGIN_RESULT_POLL_MS = 500;
const AUTH_HEADERS_TIMEOUT_MS = 20_000;
const GOTO_ALLOW_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const LOGIN_BUTTON_SELECTOR =
  'button.btn.btn-primary.w-100, button[type="submit"]';
const CAPTCHA_SELECTORS = {
  ionic: "ion-img.recaptcha-image",
  legacy: 'img[src^="data:image"]',
};
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 只轉送 API 需要的 header；其餘由瀏覽器自行帶入。 */
const FORWARDED_HEADERS = [
  "authorization",
  "ocp-apim-subscription-key",
  "api-version",
  "x-c-channel",
  "x-c-sid",
  "x-c-pagetype",
] as const;

export class KgibankVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KgibankVerificationRequiredError";
  }
}

export class KgibankCredentialRejectedError extends KgibankVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "KgibankCredentialRejectedError";
  }
}

export class KgibankCaptchaRejectedError extends KgibankVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "KgibankCaptchaRejectedError";
  }
}

export class KgibankConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "KgibankConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class KgibankBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "KgibankBrowserCapacityError";
  }
}

class KgibankActionTimeoutError extends Error {
  constructor() {
    super("凱基瀏覽器操作沒有在期限內回應。");
    this.name = "KgibankActionTimeoutError";
  }
}

export type KgibankLoginOutcome =
  "success" | "credential" | "captcha" | "unknown";

type PreparedKgibankCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

export function createKgibankConnector(
  browserFetcher?: Fetcher,
  recognizeCaptcha?: (
    imageBytes: ArrayBuffer,
    contentType: string,
    digitCount: number,
  ) => Promise<string>,
) {
  return {
    id: "kgibank" as const,
    async sync(
      config: KgibankConfig,
      _cursor?: string,
    ): Promise<SyncResult<unknown>> {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new KgibankConnectionError("Browser binding is unavailable.");
      }
      const hasManualCaptcha = Boolean(
        config.browserSessionId && config.captcha,
      );
      if (hasManualCaptcha) {
        if (
          !config.browserSessionExpiresAt ||
          new Date(config.browserSessionExpiresAt) <= new Date()
        ) {
          throw new KgibankVerificationRequiredError(
            "凱基圖形驗證碼已逾時，請重新取得驗證碼。",
          );
        }
        assertCaptcha(config.captcha ?? "");
      } else if (!recognizeCaptcha) {
        throw new KgibankVerificationRequiredError(
          "凱基圖形驗證碼無法自動辨識，請改用人工輸入。",
        );
      }

      const browserInstance = await acquireBrowser(
        browserFetcher,
        hasManualCaptcha ? config.browserSessionId : undefined,
      );
      let appFrame: Frame | undefined;
      let authHeaders: Record<string, string> | undefined;
      try {
        const pages = await browserInstance.pages();
        const page = pages[0] ?? (await browserInstance.newPage());
        await configurePage(page);
        const headerWatch = watchAuthHeaders(page);
        try {
          if (hasManualCaptcha) {
            const loginFrame = await findLoginFrame(page);
            const outcome = await submitLoginAndWait(
              page,
              loginFrame,
              config.captcha ?? "",
            );
            logKgibankEvent("kgibank_login_result", {
              mode: "manual",
              outcome,
            });
            assertSuccessfulLogin(outcome);
          } else {
            await loginWithOcr(page, config, recognizeCaptcha!);
          }
          authHeaders = await waitForAuthHeaders(headerWatch);
        } finally {
          headerWatch.dispose();
        }

        appFrame = findAppFrame(page);
        if (!appFrame) {
          throw new KgibankConnectionError(
            "凱基網銀登入後沒有載入應用程式頁面。",
          );
        }

        const accountsResponse = await gatewayRequest(
          appFrame,
          authHeaders,
          "GET",
          ACCOUNTS_PATH,
        );
        const accounts = parseKgibankAccounts(accountsResponse);
        const range = syncDateRange(new Date());
        const transactionResponses = [];
        for (const account of accounts) {
          const query = new URLSearchParams({
            acctNo: account.accountNo,
            startDate: range.startDate,
            endDate: range.endDate,
            refresh: "true",
          });
          transactionResponses.push({
            accountNo: account.accountNo,
            response: await gatewayRequest(
              appFrame,
              authHeaders,
              "GET",
              `${TRANSACTIONS_PATH}?${query.toString()}`,
            ),
          });
        }

        const data = parseKgibankData({
          accountsResponse,
          transactionResponses,
        });
        if (data.bankAccounts.length === 0) {
          throw new KgibankConnectionError(
            "凱基網銀沒有回傳任何臺幣活存帳戶。",
          );
        }
        return {
          records: [],
          ...data,
          cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
        };
      } catch (error) {
        throw mapKgibankError(error);
      } finally {
        if (appFrame && authHeaders) {
          await gatewayRequest(appFrame, authHeaders, "POST", LOGOUT_PATH, {
            allowFailure: true,
          }).catch(() => undefined);
        }
        await closeKgibankBrowser(browserInstance);
      }
    },
  };
}

export async function prepareKgibankCaptcha(
  browserFetcher?: Fetcher,
  config?: KgibankConfig,
): Promise<PreparedKgibankCaptcha> {
  if (!config) {
    throw new KgibankVerificationRequiredError(
      "請填寫身分證字號、使用者代號與網銀密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new KgibankConnectionError("Browser binding is unavailable.");
  }

  const browserInstance = await acquireBrowser(browserFetcher);
  let preserved = false;
  try {
    const pages = await browserInstance.pages();
    const page = pages[0] ?? (await browserInstance.newPage());
    await configurePage(page);
    await gotoAllowingTimeout(page, LOGIN_URL);
    const frame = await findLoginFrame(page);
    await fillInput(frame, "#loginInputIdNo", config.userId ?? "");
    await fillInput(frame, "#loginInputUserNo", config.account ?? "");
    await fillInput(frame, "#loginInputPassword", config.password ?? "");
    const captcha = await readCaptchaImage(frame);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: KGIBANK_CAPTCHA_DIGIT_COUNT,
      captchaImage: captcha.dataUrl,
    };
  } catch (error) {
    throw mapKgibankError(error);
  } finally {
    if (!preserved) await closeKgibankBrowser(browserInstance);
  }
}

async function loginWithOcr(
  page: Page,
  config: KgibankConfig,
  recognizeCaptcha: (
    imageBytes: ArrayBuffer,
    contentType: string,
    digitCount: number,
  ) => Promise<string>,
) {
  for (let attempt = 1; attempt <= KGIBANK_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    try {
      const { frame, captcha } = await openLoginAndCaptureCaptcha(page, config);
      logKgibankEvent("kgibank_login_stage", {
        attempt,
        stage: "captcha_captured",
      });
      const answer = await recognizeCaptcha(
        captcha.bytes,
        captcha.contentType,
        KGIBANK_CAPTCHA_DIGIT_COUNT,
      );
      assertCaptcha(answer);
      logKgibankEvent("kgibank_login_stage", {
        attempt,
        stage: "captcha_recognized",
      });
      const outcome = await submitLoginAndWait(page, frame, answer);
      logKgibankEvent("kgibank_login_result", {
        attempt,
        mode: "automatic",
        outcome,
      });
      if (outcome === "success") return;
      if (outcome === "credential") throw credentialRejectedError();
      if (outcome === "unknown") {
        throw new KgibankConnectionError(
          "凱基登入沒有在期限內完成，為避免重複送出帳密，已停止同步。",
        );
      }
      throw new KgibankCaptchaRejectedError(
        "凱基圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    } catch (error) {
      // 帳密錯誤會累計停權次數，絕對不可因 OCR retry 重送。
      if (
        error instanceof KgibankCredentialRejectedError ||
        error instanceof KgibankConnectionError
      ) {
        throw error;
      }
      logKgibankEvent("kgibank_auto_login_attempt_failed", {
        attempt,
        errorName: error instanceof Error ? error.name : typeof error,
        message: safeKgibankMessage(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }
  throw new KgibankVerificationRequiredError(
    `凱基自動驗證連續失敗 ${KGIBANK_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

async function openLoginAndCaptureCaptcha(page: Page, config: KgibankConfig) {
  await gotoAllowingTimeout(page, LOGIN_URL);
  const frame = await findLoginFrame(page);
  await fillInput(frame, "#loginInputIdNo", config.userId ?? "");
  await fillInput(frame, "#loginInputUserNo", config.account ?? "");
  await fillInput(frame, "#loginInputPassword", config.password ?? "");
  return { frame, captcha: await readCaptchaImage(frame) };
}

function assertSuccessfulLogin(outcome: KgibankLoginOutcome) {
  if (outcome === "success") return;
  if (outcome === "credential") throw credentialRejectedError();
  if (outcome === "captcha") {
    throw new KgibankCaptchaRejectedError(
      "凱基圖形驗證碼錯誤，請重新取得驗證碼。",
    );
  }
  throw new KgibankConnectionError("凱基登入沒有在期限內完成，請稍後再試。");
}

function credentialRejectedError() {
  return new KgibankCredentialRejectedError(
    "凱基銀行拒絕登入：身分證字號、使用者代號或密碼錯誤。為避免帳號停權，已停止同步，請確認帳密後再試。",
  );
}

async function submitLoginAndWait(
  page: Page,
  frame: Frame,
  captcha: string,
): Promise<KgibankLoginOutcome> {
  let tokenRequested = false;
  let tokenStatus: number | undefined;
  let tokenBody: Record<string, unknown> | undefined;
  let tokenBodyReady = false;
  let tokenResponseSequence = 0;
  const onRequest = (request: HTTPRequest) => {
    if (!request.url().includes(TOKEN_PATH)) return;
    if (!tokenRequested) {
      logKgibankEvent("kgibank_login_stage", {
        stage: "token_requested",
      });
    }
    tokenRequested = true;
  };
  const onResponse = (response: HTTPResponse) => {
    if (!response.url().includes(TOKEN_PATH)) return;
    const sequence = ++tokenResponseSequence;
    tokenStatus = response.status();
    tokenBody = undefined;
    tokenBodyReady = false;
    logKgibankEvent("kgibank_login_stage", {
      stage: "token_response",
      tokenStatus,
    });
    void response
      .json()
      .then((body) => {
        if (sequence === tokenResponseSequence) {
          tokenBody = isRecord(body) ? body : undefined;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (sequence === tokenResponseSequence) tokenBodyReady = true;
      });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    await fillInput(frame, 'input[formcontrolname="verifyCode"]', captcha);
    const submission = await withActionTimeout(
      frame.evaluate((buttonSelector) => {
        const selectors = {
          userId: "#loginInputIdNo",
          account: "#loginInputUserNo",
          password: "#loginInputPassword",
          captcha: 'input[formcontrolname="verifyCode"]',
        };
        const fields = Object.fromEntries(
          Object.entries(selectors).map(([name, selector]) => {
            const input = document.querySelector<HTMLInputElement>(selector);
            return [
              name,
              {
                present: Boolean(input),
                hasValue: Boolean(input?.value),
                valid: Boolean(input?.classList.contains("ng-valid")),
                invalid: Boolean(input?.classList.contains("ng-invalid")),
              },
            ];
          }),
        ) as Record<
          keyof typeof selectors,
          {
            present: boolean;
            hasValue: boolean;
            valid: boolean;
            invalid: boolean;
          }
        >;
        const button =
          document.querySelector<HTMLButtonElement>(buttonSelector);
        if (!button) return { found: false, disabled: false, fields };
        const disabled =
          button.disabled || button.getAttribute("aria-disabled") === "true";
        if (!disabled) setTimeout(() => button.click(), 0);
        return { found: true, disabled, fields };
      }, LOGIN_BUTTON_SELECTOR),
    ).catch((error: unknown) => {
      throw new KgibankConnectionError(
        "凱基登入送出狀態不明，為避免重複送出帳密，已停止同步。",
        error,
      );
    });
    logKgibankEvent("kgibank_login_stage", {
      stage: "login_submitted",
      buttonFound: submission.found,
      buttonDisabled: submission.disabled,
      fields: submission.fields,
      framePath: describeKgibankUrl(frame.url()),
    });
    if (!submission.found) {
      throw new KgibankConnectionError("凱基登入頁沒有找到登入按鈕。");
    }
    if (submission.disabled) {
      const invalidFields = Object.entries(submission.fields)
        .filter(
          ([, state]) => !state.present || !state.hasValue || state.invalid,
        )
        .map(([field]) => field);
      throw new KgibankConnectionError(
        invalidFields.length > 0
          ? `凱基登入表單未通過格式檢查（${invalidFields.join(", ")}），請重新確認該欄位。`
          : "凱基登入表單尚未完成，為避免重複送出帳密，已停止同步。",
      );
    }

    let takeoverConfirmed = false;
    let lastPageOutcome: ReturnType<typeof classifyKgibankLoginText> =
      "unknown";
    const deadline = Date.now() + LOGIN_RESULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (tokenStatus !== undefined && tokenBodyReady) {
        if (tokenBody?.isSSOExsit === true && !takeoverConfirmed) {
          // 已在其他裝置登入：與使用者手動操作相同，確認「繼續登入」接管。
          takeoverConfirmed = await confirmSessionTakeover(frame);
          if (takeoverConfirmed) {
            logKgibankEvent("kgibank_login_stage", {
              stage: "session_takeover",
            });
            tokenStatus = undefined;
            tokenBody = undefined;
            tokenBodyReady = false;
          }
        } else if (tokenStatus === 200) {
          return "success";
        } else {
          return classifyKgibankTokenResponse(tokenStatus, tokenBody);
        }
      }
      const pageText = await readFrameText(frame);
      const classified = classifyKgibankLoginText(pageText);
      lastPageOutcome = classified;
      if (classified === "credential") return "credential";
      if (classified === "captcha" && !tokenRequested) return "captcha";
      await delay(LOGIN_RESULT_POLL_MS);
    }
    logKgibankEvent("kgibank_login_timeout", {
      tokenRequested,
      tokenStatus: tokenStatus ?? null,
      tokenBodyReady,
      takeoverConfirmed,
      pageOutcome: lastPageOutcome,
      framePath: describeKgibankUrl(frame.url()),
    });
    return "unknown";
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

export function classifyKgibankTokenResponse(
  status: number,
  body: Record<string, unknown> | undefined,
): "success" | "credential" | "unknown" {
  if (status === 200) return "success";
  if (status === 429 || status >= 500 || !body) return "unknown";
  const evidence = JSON.stringify(body).toLowerCase();
  return /invalid[_ -]?grant|invalid[_ -]?credentials?|credential.*(?:invalid|reject)|密碼錯誤|使用者代號錯誤|帳號密碼不符|停權|已鎖定/.test(
    evidence,
  )
    ? "credential"
    : "unknown";
}

function describeKgibankUrl(value: string) {
  try {
    return new URL(value).pathname;
  } catch {
    return "unrecognized";
  }
}

export function classifyKgibankLoginText(
  text: string,
): "credential" | "captcha" | "unknown" {
  if (/密碼錯誤|使用者代號錯誤|停權|已鎖定|暫停使用/.test(text)) {
    return "credential";
  }
  if (/驗證碼有誤|驗證碼格式錯誤|驗證碼已逾期|驗證碼已超過次數/.test(text)) {
    return "captcha";
  }
  return "unknown";
}

async function confirmSessionTakeover(frame: Frame) {
  return withActionTimeout(
    frame.evaluate(() => {
      const button = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((element) => element.innerText.trim() === "繼續登入");
      if (!button) return false;
      button.click();
      return true;
    }),
  ).catch(() => false);
}

function watchAuthHeaders(page: Page) {
  let headers: Record<string, string> | undefined;
  const onRequest = (request: HTTPRequest) => {
    if (!request.url().includes(GATEWAY_PATH)) return;
    const requestHeaders = request.headers();
    if (!requestHeaders.authorization) return;
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = requestHeaders[name];
      if (value) forwarded[name] = value;
    }
    headers = forwarded;
  };
  page.on("request", onRequest);
  return {
    get headers() {
      return headers;
    },
    dispose() {
      page.off("request", onRequest);
    },
  };
}

async function waitForAuthHeaders(watch: {
  readonly headers: Record<string, string> | undefined;
}) {
  const deadline = Date.now() + AUTH_HEADERS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const headers = watch.headers;
    if (headers?.authorization && headers["ocp-apim-subscription-key"]) {
      return headers;
    }
    await delay(LOGIN_RESULT_POLL_MS);
  }
  throw new KgibankConnectionError("凱基登入後沒有取得 API 授權資訊。");
}

async function gatewayRequest(
  frame: Frame,
  headers: Record<string, string>,
  method: "GET" | "POST",
  path: string,
  options: { allowFailure?: boolean } = {},
): Promise<unknown> {
  const result = await withActionTimeout(
    frame.evaluate(
      async (url, requestMethod, requestHeaders) => {
        const response = await fetch(url, {
          method: requestMethod,
          headers: {
            ...requestHeaders,
            accept: "application/json",
            "x-c-localtime": new Date().toISOString(),
          },
          credentials: "include",
        });
        return { status: response.status, body: await response.text() };
      },
      `${APP_ORIGIN}${path}`,
      method,
      headers,
    ),
  );
  if (result.status < 200 || result.status >= 300) {
    if (options.allowFailure) return undefined;
    if (result.status === 401 || result.status === 403) {
      throw new KgibankConnectionError("凱基網銀授權已失效，請重新同步。");
    }
    throw new KgibankConnectionError(
      `凱基網銀 API 回應異常（HTTP ${result.status}）。`,
    );
  }
  if (!result.body) return undefined;
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new KgibankProtocolError("凱基網銀 API 回傳非 JSON 內容。");
  }
}

async function readCaptchaImage(frame: Frame) {
  try {
    await frame.waitForFunction(
      kgibankCaptchaDataUrl,
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      CAPTCHA_SELECTORS,
    );
  } catch {
    throw new KgibankConnectionError("凱基登入頁沒有在期限內顯示驗證碼。");
  }
  const src = await withActionTimeout(
    frame.evaluate(kgibankCaptchaDataUrl, CAPTCHA_SELECTORS),
  );
  if (!/^data:image\/[a-z]+;base64,/.test(src)) {
    throw new KgibankConnectionError("凱基登入頁的驗證碼格式無法辨識。");
  }
  return parseCaptchaDataUrl(src);
}

export function kgibankCaptchaDataUrl(selectors: {
  ionic: string;
  legacy: string;
}) {
  const ionicImage = document.querySelector<HTMLElement & { src?: string }>(
    selectors.ionic,
  );
  const shadowImage =
    ionicImage?.shadowRoot?.querySelector<HTMLImageElement>("img");
  const legacyImage = document.querySelector<HTMLImageElement>(
    selectors.legacy,
  );
  return (
    ionicImage?.src ||
    shadowImage?.getAttribute("src") ||
    legacyImage?.getAttribute("src") ||
    ""
  );
}

export function parseCaptchaDataUrl(dataUrl: string) {
  const match =
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl,
    );
  if (!match?.[1] || !match[2]) {
    throw new KgibankConnectionError("凱基登入頁的驗證碼格式無法辨識。");
  }
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    dataUrl,
    contentType: match[1],
    bytes: bytes.buffer,
  };
}

async function findLoginFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + LOGIN_FORM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.url().includes("/internalbank/")) continue;
      const ready = await frame
        .$("#loginInputIdNo")
        .then(Boolean)
        .catch(() => false);
      if (ready) return frame;
    }
    await delay(LOGIN_RESULT_POLL_MS);
  }
  throw new KgibankConnectionError("凱基登入頁沒有在期限內載入登入表單。");
}

function findAppFrame(page: Page) {
  return page
    .frames()
    .find((frame) => frame.url().startsWith(`${APP_ORIGIN}/internalbank/`));
}

async function readFrameText(frame: Frame) {
  return withActionTimeout(
    frame.evaluate(() => document.body?.innerText ?? ""),
  ).catch(() => "");
}

async function fillInput(frame: Frame, selector: string, value: string) {
  await frame.waitForSelector(selector, { timeout: LOGIN_FORM_TIMEOUT_MS });
  await withActionTimeout(
    frame.evaluate(
      (target, nextValue) => {
        const input = document.querySelector<HTMLInputElement>(target);
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) return;
        setter.call(input, nextValue);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: nextValue,
          }),
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      selector,
      value,
    ),
  );
}

/** 近 3 個月（含今日），以台灣時間表示，格式與網銀前端相同。 */
export function syncDateRange(now: Date) {
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const end = taipei.toISOString().slice(0, 10);
  const startDate = new Date(
    Date.UTC(
      taipei.getUTCFullYear(),
      taipei.getUTCMonth() - SYNC_MONTHS,
      taipei.getUTCDate(),
    ),
  );
  const start = startDate.toISOString().slice(0, 10);
  return {
    startDate: `${start}T00:00:00.000+08:00`,
    endDate: `${end}T23:59:59.999+08:00`,
  };
}

async function gotoAllowingTimeout(page: Page, url: string) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: GOTO_ALLOW_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Navigation timeout/i.test(message)) throw error;
  }
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
    if (!preferred) {
      throw new KgibankVerificationRequiredError(
        "凱基驗證工作階段已結束，請重新取得驗證碼。",
      );
    }
    if (preferred.connectionId) {
      throw new KgibankBrowserCapacityError(
        "凱基驗證碼正在產生中，請稍候再試。",
        3,
      );
    }
    try {
      return await puppeteer.connect(browserFetcher, preferred.sessionId);
    } catch {
      throw new KgibankBrowserCapacityError(
        "前一個凱基驗證工作階段尚未釋放，請稍候再試。",
        3,
      );
    }
  }

  const limits = await puppeteer.limits(browserFetcher).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new KgibankBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再取得驗證碼。",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  try {
    return await launchBrowserWithRetry(browserFetcher, {
      keep_alive: CAPTCHA_KEEP_ALIVE_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new KgibankBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完，請於額度重置後再試。",
        60,
      );
    }
    if (/429|rate limit|capacity/i.test(message)) {
      throw new KgibankBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限，請稍後重試。",
      );
    }
    throw error;
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

async function closeKgibankBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch (error) {
    logKgibankEvent("kgibank_browser_cleanup_failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function withActionTimeout<T>(action: Promise<T>): Promise<T> {
  action.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new KgibankActionTimeoutError()),
          ACTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireCredentials(config: KgibankConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new KgibankVerificationRequiredError(
      "請填寫身分證字號、使用者代號與網銀密碼。",
    );
  }
}

function assertCaptcha(value: string) {
  if (!new RegExp(`^\\d{${KGIBANK_CAPTCHA_DIGIT_COUNT}}$`).test(value)) {
    throw new KgibankCaptchaRejectedError(
      `凱基驗證碼必須是 ${KGIBANK_CAPTCHA_DIGIT_COUNT} 位數字。`,
    );
  }
}

function mapKgibankError(error: unknown): Error {
  if (
    error instanceof KgibankVerificationRequiredError ||
    error instanceof KgibankBrowserCapacityError ||
    error instanceof KgibankConnectionError
  ) {
    return error;
  }
  if (error instanceof KgibankProtocolError) {
    return new KgibankConnectionError(error.message, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new KgibankConnectionError(
    `凱基銀行連線失敗：${safeKgibankMessage(message)}`,
    error,
  );
}

function logKgibankEvent(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ event, connectorId: "kgibank", ...fields }));
}

function safeKgibankMessage(message: string) {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
