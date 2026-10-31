import type { SourceSyncError, SourceSyncErrorSource } from "../sync-error";
import type { SyncResult } from "../types";
import { reportSyncProgress } from "../sync-progress";
import {
  BrowserRunCapacityError,
  launchBrowserWithRetry,
  connectBrowserWithCancellation,
  prepareBrowserLoginWithRetry,
  closeBrowserSession,
  type ReportBrowserLoginStage,
} from "../browser.js";
import puppeteer, {
  type Browser,
  type Dialog,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
} from "@cloudflare/puppeteer";
import {
  CHB_CAPTCHA_DIGIT_COUNT,
  ChbApiError,
  ChbProtocolError,
  ChbSyncReport,
  chbDataCheckSum,
  chbFcItemAccount,
  chbQueryRange,
  chbRequestBody,
  chbSingleAccountItems,
  chbTwItemAccountNo,
  classifyChbLoginMessage,
  describeChbError,
  findChbField,
  parseChbAccountItems,
  parseChbData,
  parseChbRestResponse,
  pickChbAllAccountItem,
  summarizeChbResult,
  type ChbConfig,
  type ChbLoginOutcome,
  type ChbPayloads,
  type ChbRestRequest,
  type ChbSyncCategory,
} from "./protocol";

// 彰化銀行個人網路銀行。登入表單的密碼由頁面自己加密後送出，連接器只在真實頁面輸入欄位並
// 觸發官方送出流程；登入後的查詢在已登入的頁面內以 XMLHttpRequest 呼叫 `/chbnib/rest`
// （與銀行前端相同的請求方式，讓頁面上的反爬蟲腳本照常附加它要的參數），一次一個。
const ORIGIN = "https://www.chb.com.tw";
const LOGIN_URL = `${ORIGIN}/chbnib`;
const LOGIN_DISPATCH_PATH = "/chbnib/faces/login/CHBiBDispatcher";
const MAIN_PATH = "/chbnib/faces/common/CHBiBMain";
const REST_PATH = "/chbnib/rest";
const LOGOUT_URL = `${ORIGIN}/chbnib/faces/common/Logout`;

/** 登入頁欄位選擇器（`name` 屬性）；密碼欄位不使用動態鍵盤。 */
const LOGIN_FIELDS = {
  nationalId: "input[name=uid_show]",
  userId: "input[name=uuid]",
  password: "input[name=pwd]",
  captcha: "input[name=captcha]",
} as const;
const SUBMIT_BUTTON = "#pb-login";
const CAPTCHA_IMAGE = "img.cimg";
const CAPTCHA_REFRESH = "a.btn-refresh";

export const CHB_AUTO_LOGIN_ATTEMPTS = 3;
export const CHB_CAPTCHA_OCR_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const AUTO_SYNC_KEEP_ALIVE_MS = 60_000;
const LOGIN_FORM_TIMEOUT_MS = 30_000;
const LOGIN_SUBMIT_TIMEOUT_MS = 15_000;
const LOGIN_RESULT_TIMEOUT_MS = 45_000;
/** 登入送出後已收到回應、停在非主頁且持續這麼久仍未出現主頁，即判定失敗。 */
const LOGIN_RESULT_SETTLE_MS = 3_000;
const MAIN_READY_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const REST_TIMEOUT_MS = 45_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const POLL_MS = 300;
const MAX_FC_ACCOUNTS = 40;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class ChbVerificationRequiredError
  extends Error
  implements SourceSyncErrorSource
{
  constructor(message: string) {
    super(message);
    this.name = "ChbVerificationRequiredError";
  }

  toSyncError(): SourceSyncError {
    return { status: 400, code: "USER_ACTION_REQUIRED", needsUserAction: true };
  }
}

/** 身分證字號、使用者代號或密碼遭拒／帳號鎖定；不得重試，避免累積錯誤次數。 */
export class ChbCredentialRejectedError extends ChbVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "ChbCredentialRejectedError";
  }
}

export class ChbCaptchaRejectedError extends ChbVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "ChbCaptchaRejectedError";
  }
}

/** 自動辨識驗證碼連續失敗；sync.ts 轉為人工驗證碼流程。 */
export class ChbAutoCaptchaFailedError extends ChbVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "ChbAutoCaptchaFailedError";
  }
}

export class ChbConnectionError extends Error implements SourceSyncErrorSource {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ChbConnectionError";
    if (cause !== undefined) this.cause = cause;
  }

  toSyncError(): SourceSyncError {
    return { status: 502, code: "CHB_CONNECTION_FAILED" };
  }
}

/** 網銀工作階段已結束（被登出、逾時）；不可略過，整次同步失敗。 */
export class ChbSessionEndedError extends ChbConnectionError {
  constructor(message = "彰化銀行網銀工作階段已結束，請重新同步。") {
    super(message);
    this.name = "ChbSessionEndedError";
  }
}

export class ChbBrowserCapacityError
  extends Error
  implements SourceSyncErrorSource
{
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "ChbBrowserCapacityError";
  }

  toSyncError(): SourceSyncError {
    return {
      status: 429,
      code: "CHB_BROWSER_BUSY",
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

class ChbActionTimeoutError extends Error {
  constructor() {
    super("彰化銀行瀏覽器操作沒有在期限內回應。");
    this.name = "ChbActionTimeoutError";
  }
}

/** 一次同步中的登入狀態；登入請求送出後，任何結果都必須在關閉瀏覽器前嘗試官方登出。 */
export type ChbSessionState = {
  loginRequested: boolean;
  /** 本次同步實際送出的登入 POST 次數（含驗證碼錯誤後重送）。 */
  loginRequests: number;
  /** 最近一次登入 POST 收到回應的時間（毫秒）；尚未收到為 undefined。 */
  loginRespondedAt?: number;
  loggedIn: boolean;
};

export function createChbSessionState(): ChbSessionState {
  return { loginRequested: false, loginRequests: 0, loggedIn: false };
}

type ChbPageContext = {
  session: ChbSessionState;
  /** 主框架完成導覽的次數；用來確認登入送出後頁面確實已換頁。 */
  mainFrameNavigations: number;
  /** 原生對話框訊息（只在記憶體內分類，不寫入 log）。 */
  dialogs: string[];
};
const pageContexts = new WeakMap<Page, ChbPageContext>();

type PreparedChbCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

type CaptchaImage = { bytes: Uint8Array; dataUrl: string };

type RecognizeCaptcha = (
  imageBytes: ArrayBuffer,
  contentType: string,
  digitCount: number,
) => Promise<string>;

export function createChbConnector(
  browserFetcher: Fetcher | undefined,
  recognizeCaptcha: RecognizeCaptcha | undefined,
) {
  return {
    id: "chb" as const,
    async sync(
      config: ChbConfig,
      _cursor?: string,
    ): Promise<SyncResult<unknown> & { syncWarning?: string }> {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new ChbConnectionError("Browser binding is unavailable.");
      }
      const manualCaptcha = Boolean(config.browserSessionId && config.captcha);
      if (manualCaptcha) {
        assertNotExpired(
          config.browserSessionExpiresAt,
          "彰化銀行圖形驗證碼已逾時，請重新取得驗證碼。",
        );
        assertCaptcha(config.captcha ?? "");
      } else if (!recognizeCaptcha) {
        throw new ChbVerificationRequiredError(
          "彰化銀行圖形驗證碼無法自動辨識，請改用人工輸入。",
        );
      }

      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      let report: ChbSyncReport | undefined;
      let summaryLogged = false;
      const session = createChbSessionState();
      try {
        return await runWithChbLogout(
          session,
          async () => {
            if (manualCaptcha) {
              browserInstance = await acquireBrowser(
                browserFetcher,
                config.browserSessionId,
              );
              page = await firstPage(browserInstance);
              await configurePage(page, session);
              const outcome = await submitLogin(
                page,
                config,
                config.captcha ?? "",
              );
              logChbEvent("chb_login_result", {
                mode: "manual",
                outcome: outcome.kind,
              });
              await finishLogin(page, outcome);
            } else {
              const prepared = await prepareBrowserLoginWithRetry({
                binding: browserFetcher,
                connectorId: "chb",
                launchOptions: { keep_alive: AUTO_SYNC_KEEP_ALIVE_MS },
                isRetryable: (error) =>
                  error instanceof ChbActionTimeoutError ||
                  (error instanceof ChbConnectionError &&
                    /^彰化銀行登入頁沒有在期限內/.test(error.message)),
                prepare: async (
                  browser,
                  observePage,
                  _signal,
                  _attempt,
                  reportStage,
                ) => {
                  const page = await firstPage(browser);
                  observePage(page);
                  reportStage("configure_page");
                  await configurePage(page, session);
                  const captcha = await openLoginAndCaptureCaptcha(
                    page,
                    reportStage,
                  );
                  return { page, captcha };
                },
              });
              browserInstance = prepared.browser;
              page = prepared.value.page;
              const outcome = await loginWithOcr(
                page,
                config,
                recognizeCaptcha!,
                prepared.value.captcha,
              );
              await finishLogin(page, outcome);
            }

            await waitForMainReady(page);
            report = new ChbSyncReport();
            reportSyncProgress("fetching");
            const payloads = await fetchChbPayloads(page, report);
            const data = parseChbData(payloads, new Date(), report);
            logChbEvent("chb_sync_summary", {
              phase: "finished",
              ...report.summary(),
            });
            summaryLogged = true;
            if (report.failedCount > 0 && data.bankAccounts.length === 0) {
              throw new ChbConnectionError(
                `彰化銀行同步未取得任何資料。${report.userMessage() ?? ""}`,
              );
            }
            logChbResult(summarizeChbResult(data, report));
            return {
              records: [],
              bankAccounts: data.bankAccounts,
              bankBalanceSnapshots: data.bankBalanceSnapshots,
              bankTransactions: data.bankTransactions,
              syncWarning: report.userMessage(),
              cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
            };
          },
          () => (page ? logoutChb(page) : undefined),
        );
      } catch (error) {
        throw mapChbError(error);
      } finally {
        if (report && !summaryLogged)
          logChbEvent("chb_sync_summary", {
            phase: "aborted",
            ...report.summary(),
          });
        if (browserInstance)
          await closeChbBrowser(browserInstance, browserFetcher);
      }
    },
  };
}

export async function prepareChbCaptcha(
  browserFetcher: Fetcher | undefined,
  config: ChbConfig | undefined,
): Promise<PreparedChbCaptcha> {
  if (!config) {
    throw new ChbVerificationRequiredError(
      "請填寫身分證字號、使用者代號與密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new ChbConnectionError("Browser binding is unavailable.");
  }
  const browserInstance = await acquireBrowser(browserFetcher);
  let preserved = false;
  try {
    const page = await firstPage(browserInstance);
    await configurePage(page, createChbSessionState());
    const captcha = await openLoginAndCaptureCaptcha(page);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: CHB_CAPTCHA_DIGIT_COUNT,
      captchaImage: captcha.dataUrl,
    };
  } catch (error) {
    throw mapChbError(error);
  } finally {
    if (!preserved) await closeChbBrowser(browserInstance, browserFetcher);
  }
}

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

async function loginWithOcr(
  page: Page,
  config: ChbConfig,
  recognizeCaptcha: RecognizeCaptcha,
  initialCaptcha: CaptchaImage,
): Promise<ChbLoginOutcome> {
  const session = getSession(page);
  let captcha = initialCaptcha;
  for (let attempt = 1; attempt <= CHB_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    const answer = await recognizeValidCaptcha(
      page,
      recognizeCaptcha,
      captcha,
      attempt,
    );
    if (!answer) {
      if (attempt < CHB_AUTO_LOGIN_ATTEMPTS)
        captcha = await refreshCaptcha(page);
      continue;
    }
    const requestsBefore = session.loginRequests;
    const outcome = await submitLogin(page, config, answer);
    const submitted = session.loginRequests > requestsBefore;
    logChbEvent("chb_login_result", {
      attempt,
      mode: "automatic",
      submitted,
      loginRequests: session.loginRequests,
      outcome: outcome.kind,
    });
    // 只有明確的驗證碼錯誤可以重試；帳密錯誤、鎖定與結果不明不得重送帳密。
    if (outcome.kind !== "captcha") return outcome;
    if (attempt < CHB_AUTO_LOGIN_ATTEMPTS) {
      // 銀行收到登入後才回覆驗證碼錯誤時頁面狀態不明，重新載入登入頁取新驗證碼。
      captcha = submitted
        ? await openLoginAndCaptureCaptcha(page)
        : await refreshCaptcha(page);
    }
  }
  throw new ChbAutoCaptchaFailedError(
    `彰化銀行自動驗證連續失敗 ${CHB_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

/**
 * 辨識結果不是 6 位數字時，在同一頁換一張驗證碼重新辨識（尚未送出帳密），
 * 最多 CHB_CAPTCHA_OCR_ATTEMPTS 次；全部失敗回傳 undefined。
 */
async function recognizeValidCaptcha(
  page: Page,
  recognizeCaptcha: RecognizeCaptcha,
  initialCaptcha: CaptchaImage,
  loginAttempt: number,
): Promise<string | undefined> {
  let captcha = initialCaptcha;
  for (let ocrAttempt = 1; ; ocrAttempt += 1) {
    let answer = "";
    let errorName: string | undefined;
    try {
      answer = await recognizeCaptcha(
        toArrayBuffer(captcha.bytes),
        "image/png",
        CHB_CAPTCHA_DIGIT_COUNT,
      );
    } catch (error) {
      errorName = error instanceof Error ? error.name : typeof error;
    }
    const valid = isValidCaptcha(answer);
    logChbEvent("chb_captcha_ocr", {
      loginAttempt,
      ocrAttempt,
      ocrLength: answer.length,
      valid,
      errorName,
    });
    if (valid) return answer;
    if (ocrAttempt >= CHB_CAPTCHA_OCR_ATTEMPTS) return undefined;
    captcha = await refreshCaptcha(page);
  }
}

async function finishLogin(page: Page, outcome: ChbLoginOutcome) {
  switch (outcome.kind) {
    case "success":
      getSession(page).loggedIn = true;
      return;
    case "captcha":
      throw new ChbCaptchaRejectedError(
        "彰化銀行圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    case "credential":
      throw new ChbCredentialRejectedError(
        "彰化銀行拒絕登入：身分證字號、使用者代號或密碼錯誤。為避免連續錯誤導致停用，已停止同步，請確認帳密後再試。",
      );
    case "locked":
      throw new ChbCredentialRejectedError(
        "彰化銀行網路銀行暫時無法登入（帳號可能已停用或鎖定），請至官方網銀或洽客服確認帳號狀態。",
      );
    case "duplicate":
      throw new ChbVerificationRequiredError(
        "彰化銀行回覆已有其他登入中的網銀工作階段，為避免中斷其他裝置，已停止同步。請先登出其他裝置或稍後再試。",
      );
    case "maintenance":
      throw new ChbConnectionError(
        "彰化銀行網路銀行維護中或忙碌，請稍後再試。",
      );
    default:
      throw new ChbVerificationRequiredError(
        "彰化銀行登入結果不明，為避免重複送出帳密，已停止同步。請至官方網銀確認帳號狀態後再試。",
      );
  }
}

async function openLoginAndCaptureCaptcha(
  page: Page,
  reportStage?: ReportBrowserLoginStage,
): Promise<CaptchaImage> {
  reportStage?.("navigate");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  reportStage?.("form");
  try {
    await page.waitForFunction(
      (selectors: string[]) =>
        selectors.every((selector) =>
          Boolean(document.querySelector(selector)),
        ),
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      [...Object.values(LOGIN_FIELDS), SUBMIT_BUTTON, CAPTCHA_IMAGE],
    );
  } catch {
    throw new ChbConnectionError("彰化銀行登入頁沒有在期限內載入登入表單。");
  }
  await dismissAnnouncementPopup(page);
  reportStage?.("captcha");
  return captureCaptcha(page);
}

/**
 * 登入頁的「銀行公告」彈窗（Magnific Popup）會蓋住驗證碼與表單。優先點擊其關閉鈕
 * `.mfp-close`，再呼叫 `$.magnificPopup.close()`，仍殘留時按 Escape；彈窗可能延遲出現，
 * 因此最多等 2 秒。關不掉不是致命錯誤：欄位以鍵盤輸入、送出以 DOM click，不受覆蓋影響。
 */
async function dismissAnnouncementPopup(page: Page) {
  const result = await withActionTimeout(
    page.evaluate(async () => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const visible = () =>
        Boolean(document.querySelector(".mfp-wrap, .mfp-bg"));
      let found = false;
      for (let i = 0; i < 7; i += 1) {
        if (visible()) {
          found = true;
          break;
        }
        await sleep(300);
      }
      if (!found) return { found: false, closed: true };
      const win = window as unknown as {
        jQuery?: { magnificPopup?: { close?: () => void } };
      };
      for (let i = 0; i < 3 && visible(); i += 1) {
        document.querySelector<HTMLButtonElement>(".mfp-close")?.click();
        try {
          win.jQuery?.magnificPopup?.close?.();
        } catch {
          // 彈窗函式庫不可用時改靠 Escape。
        }
        await sleep(500);
      }
      return { found: true, closed: !visible() };
    }),
  ).catch(() => ({ found: false, closed: false }));
  if (result.found && !result.closed) {
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  logChbEvent("chb_popup", { found: result.found, closed: result.closed });
}

/** 讀取 `img.cimg` 的 `data:image/png;base64` 來源（元素截圖會被公告彈窗蓋住）。 */
async function captureCaptcha(page: Page): Promise<CaptchaImage> {
  try {
    await page.waitForFunction(
      (selector: string) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return Boolean(
          image &&
          /^data:image\/[a-z]+;base64,.{100,}/.test(
            image.getAttribute("src") ?? "",
          ) &&
          image.complete &&
          image.naturalWidth > 0,
        );
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      CAPTCHA_IMAGE,
    );
  } catch {
    throw new ChbConnectionError("彰化銀行登入頁沒有在期限內顯示驗證碼。");
  }
  const source = await currentCaptchaSource(page);
  const base64 = source.match(/^data:image\/[a-z]+;base64,(.+)$/)?.[1];
  if (!base64) {
    throw new ChbConnectionError("彰化銀行登入頁沒有在期限內顯示驗證碼。");
  }
  return {
    bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
    dataUrl: source,
  };
}

async function currentCaptchaSource(page: Page) {
  return withActionTimeout(
    page.evaluate(
      (selector: string) =>
        document.querySelector(selector)?.getAttribute("src") ?? "",
      CAPTCHA_IMAGE,
    ),
  );
}

/** 以官方「換一張」連結在同一頁換驗證碼，不重新載入登入頁。 */
async function refreshCaptcha(page: Page): Promise<CaptchaImage> {
  const previous = await currentCaptchaSource(page);
  await withActionTimeout(
    page.evaluate((selector: string) => {
      document.querySelector<HTMLElement>(selector)?.click();
    }, CAPTCHA_REFRESH),
  );
  try {
    await page.waitForFunction(
      (selector: string, oldSource: string) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        const src = image?.getAttribute("src") ?? "";
        return Boolean(
          image &&
          src !== oldSource &&
          /^data:image\//.test(src) &&
          image.complete &&
          image.naturalWidth > 0,
        );
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      CAPTCHA_IMAGE,
      previous,
    );
  } catch {
    throw new ChbConnectionError("彰化銀行登入頁沒有在期限內更新驗證碼。");
  }
  return captureCaptcha(page);
}

/** 以真實鍵盤事件輸入欄位（讓頁面的 keyup／input 處理照常同步隱藏欄位）。 */
async function typeInto(page: Page, selector: string, value: string) {
  await withActionTimeout(
    page.$eval(selector, (element) => {
      (element as unknown as { value: string }).value = "";
    }),
  );
  await withActionTimeout(page.type(selector, value));
}

/**
 * 輸入帳密與驗證碼並觸發官方送出（對 `#pb-login` 做 DOM click，不受彈窗覆蓋影響）。
 * 銀行以 `POST /chbnib/faces/login/CHBiBDispatcher` 回 302 轉到主頁；
 * 主頁出現即成功。失敗時依原生對話框與頁面文字分類（只在記憶體內比對）。
 */
async function submitLogin(
  page: Page,
  config: ChbConfig,
  captcha: string,
): Promise<ChbLoginOutcome> {
  const context = getContext(page);
  context.dialogs.length = 0;
  const requestsBefore = context.session.loginRequests;
  const submitted = () => context.session.loginRequests > requestsBefore;
  context.session.loginRespondedAt = undefined;
  await typeInto(
    page,
    LOGIN_FIELDS.nationalId,
    (config.nationalId ?? "").toUpperCase(),
  );
  await typeInto(page, LOGIN_FIELDS.userId, config.userId ?? "");
  await typeInto(page, LOGIN_FIELDS.password, config.password ?? "");
  await typeInto(page, LOGIN_FIELDS.captcha, captcha);
  const navigationsBefore = context.mainFrameNavigations;
  await withActionTimeout(
    page.evaluate((selector: string) => {
      // 以 setTimeout 讓 evaluate 先回傳；送出後的導覽不會中斷本次呼叫。
      setTimeout(() => {
        document.querySelector<HTMLElement>(selector)?.click();
      }, 0);
    }, SUBMIT_BUTTON),
  );
  const deadline = Date.now() + LOGIN_SUBMIT_TIMEOUT_MS;
  while (Date.now() < deadline && !submitted()) {
    if (context.dialogs.length > 0) break;
    await delay(POLL_MS);
  }
  if (!submitted()) {
    // 頁面檢核未通過、沒有送出登入：只有明確的驗證碼錯誤可換圖重試。
    const fromDialog = classifyChbLoginMessage(context.dialogs.join("\n"));
    logChbEvent("chb_login_precheck_rejected", {
      dialogCount: context.dialogs.length,
      outcome: fromDialog.kind,
    });
    if (fromDialog.kind === "captcha") return fromDialog;
    throw new ChbVerificationRequiredError(
      "彰化銀行登入頁檢核未通過，未送出登入。請確認身分證字號、使用者代號與密碼設定。",
    );
  }
  return waitForLoginResult(page, navigationsBefore);
}

async function waitForLoginResult(
  page: Page,
  navigationsBefore: number,
): Promise<ChbLoginOutcome> {
  const context = getContext(page);
  const deadline = Date.now() + LOGIN_RESULT_TIMEOUT_MS;
  let settledSince: number | undefined;
  while (Date.now() < deadline) {
    const url = page.url();
    if (
      context.mainFrameNavigations > navigationsBefore &&
      safePath(url).startsWith(MAIN_PATH)
    ) {
      return { kind: "success" };
    }
    // 原生對話框（失敗提示）會在送出後很快出現，先分類。
    if (context.dialogs.length > 0) {
      const fromDialog = classifyChbLoginMessage(context.dialogs.join("\n"));
      if (fromDialog.kind !== "unknown") {
        logChbEvent("chb_login_failed_page", {
          path: safePath(url),
          dialogCount: context.dialogs.length,
          outcome: fromDialog.kind,
        });
        return fromDialog;
      }
    }
    if (
      context.session.loginRespondedAt !== undefined &&
      !safePath(url).startsWith(MAIN_PATH)
    ) {
      const ready = await page
        .evaluate(() => document.readyState === "complete")
        .catch(() => false);
      if (ready) {
        settledSince ??= Date.now();
        if (Date.now() - settledSince >= LOGIN_RESULT_SETTLE_MS) {
          const pageText = await page
            .evaluate(() => (document.body?.innerText ?? "").slice(0, 4_000))
            .catch(() => "");
          const fromDialog = classifyChbLoginMessage(
            context.dialogs.join("\n"),
          );
          const outcome =
            fromDialog.kind !== "unknown"
              ? fromDialog
              : classifyChbLoginMessage(pageText);
          logChbEvent("chb_login_failed_page", {
            path: safePath(url),
            dialogCount: context.dialogs.length,
            outcome: outcome.kind,
          });
          return outcome;
        }
      } else {
        settledSince = undefined;
      }
    }
    await delay(POLL_MS);
  }
  logChbEvent("chb_login_failed_page", {
    path: safePath(page.url()),
    dialogCount: context.dialogs.length,
    outcome: "timeout",
  });
  return { kind: "unknown" };
}

/** 主頁載入完成後才開始查詢，讓頁面上的反爬蟲腳本先完成初始化。 */
async function waitForMainReady(page: Page) {
  const deadline = Date.now() + MAIN_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => document.readyState === "complete")
      .catch(() => false);
    if (ready && safePath(page.url()).startsWith(MAIN_PATH)) {
      await delay(1_000);
      return;
    }
    await delay(POLL_MS);
  }
  if (!safePath(page.url()).startsWith(MAIN_PATH)) {
    getSession(page).loggedIn = false;
    throw new ChbSessionEndedError();
  }
}

// ---------------------------------------------------------------------------
// 登出
// ---------------------------------------------------------------------------

export type ChbLogoutResult = {
  attempted: boolean;
  ok: boolean;
  reason: string;
};

/**
 * 執行同步工作，結束時（成功或任何錯誤）只要曾送出登入請求，就嘗試官方登出。
 * 登出為盡力而為：不會覆蓋原本的回傳值或錯誤。
 */
export async function runWithChbLogout<T>(
  state: ChbSessionState,
  work: () => Promise<T>,
  logoutFn: () => Promise<ChbLogoutResult | undefined> | undefined,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<T> {
  try {
    return await work();
  } finally {
    if (state.loginRequested || state.loggedIn) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve(logoutFn()),
          new Promise<ChbLogoutResult>((resolve) => {
            timer = setTimeout(
              () => resolve({ attempted: true, ok: false, reason: "timeout" }),
              timeoutMs,
            );
          }),
        ]);
        if (result) logChbEvent("chb_logout", { ...result });
      } catch (error) {
        logChbEvent("chb_logout", {
          attempted: true,
          ok: false,
          reason: "error",
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

async function logoutChb(page: Page): Promise<ChbLogoutResult> {
  try {
    const response = await page.goto(LOGOUT_URL, {
      waitUntil: "domcontentloaded",
      timeout: LOGOUT_TIMEOUT_MS,
    });
    return {
      attempted: true,
      ok: Boolean(response && response.status() < 400),
      reason: response ? `http_${response.status()}` : "no_response",
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      reason: error instanceof Error ? error.name : "error",
    };
  }
}

// ---------------------------------------------------------------------------
// 登入後資料擷取（已登入頁面內依序呼叫 /chbnib/rest；全部為唯讀查詢）
// ---------------------------------------------------------------------------

/** 會讓整次同步失敗、不可略過的錯誤：工作階段結束、瀏覽器斷線、需要使用者處理。 */
export function isChbFatalFetchError(error: unknown) {
  if (
    error instanceof ChbSessionEndedError ||
    error instanceof ChbVerificationRequiredError ||
    error instanceof ChbBrowserCapacityError ||
    error instanceof BrowserRunCapacityError
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /Target closed|Session closed|Connection closed|WebSocket is not open|browser has disconnected|Browser closed/i.test(
    message,
  );
}

export const CHB_MAX_CONSECUTIVE_STEP_FAILURES = 3;

/**
 * 逐項擷取：單一查詢失敗只略過該項並記入彙整；工作階段結束或瀏覽器斷線等致命錯誤仍向外拋出
 * （之後一律嘗試登出）。連續失敗達上限時停止其餘項目（多半是網銀或連線異常）。
 */
export class ChbStepRunner {
  private consecutiveFailures = 0;
  private halted = false;

  constructor(private readonly report: ChbSyncReport) {}

  async run<T>(
    category: ChbSyncCategory,
    stage: string,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    if (this.halted) {
      this.report.fail(
        category,
        "skipped",
        new ChbConnectionError("前面連續多項擷取失敗，已略過此項。"),
      );
      return undefined;
    }
    try {
      const value = await action();
      this.consecutiveFailures = 0;
      return value;
    } catch (error) {
      if (isChbFatalFetchError(error)) throw error;
      this.report.fail(category, stage, error);
      logChbEvent("chb_step_failed", {
        category,
        stage,
        ...describeChbError(error),
      });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= CHB_MAX_CONSECUTIVE_STEP_FAILURES) {
        this.halted = true;
        logChbEvent("chb_steps_halted", {
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return undefined;
    }
  }
}

type RestResult = { status: number; text: string };

/** 回覆代碼表示登入已失效（TODO(chb-live): 實際代碼待實機確認，先以名稱推定）。 */
const SESSION_RETURN_CODE = /session|timeout|login|expire/i;

/**
 * 在已登入的頁面內送出一個 `/chbnib/rest` 請求（一次一個，不可並行：伺服器會在回應時更新 session）。
 * `DataCheckSum` 由 Worker 依銀行前端演算法計算；頁面以 XMLHttpRequest 送出並帶 cookie。
 */
async function chbRest(page: Page, request: ChbRestRequest): Promise<unknown> {
  const body = chbRequestBody(request);
  const checksum = chbDataCheckSum(body);
  let result: RestResult;
  try {
    result = await withActionTimeout(
      page.evaluate(
        (path: string, payload: string, sum: string, timeoutMs: number) =>
          new Promise<RestResult>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", path, true);
            xhr.setRequestHeader("Accept", "application/json");
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.setRequestHeader("DataCheckSum", sum);
            xhr.withCredentials = true;
            xhr.timeout = timeoutMs;
            xhr.onload = () =>
              resolve({ status: xhr.status, text: xhr.responseText });
            xhr.onerror = () => reject(new Error("XHR network error"));
            xhr.ontimeout = () => reject(new Error("XHR timeout"));
            xhr.send(payload);
          }),
        REST_PATH,
        body,
        checksum,
        REST_TIMEOUT_MS - 5_000,
      ),
      REST_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ChbActionTimeoutError) throw error;
    throw new ChbConnectionError(
      `彰化銀行查詢連線失敗：${safeLogMessage(error instanceof Error ? error.message : String(error))}`,
      error,
    );
  }
  if (result.status === 401 || result.status === 403) {
    logChbEvent("chb_api_error", {
      api: request.url,
      httpStatus: result.status,
    });
    throw new ChbSessionEndedError();
  }
  try {
    return parseChbRestResponse(result.text);
  } catch (error) {
    if (error instanceof ChbApiError) {
      logChbEvent("chb_api_error", {
        api: request.url,
        httpStatus: result.status,
        returnCode: error.returnCode,
      });
      if (SESSION_RETURN_CODE.test(error.returnCode)) {
        throw new ChbSessionEndedError();
      }
    }
    throw error;
  }
}

async function fetchChbPayloads(
  page: Page,
  report: ChbSyncReport,
): Promise<ChbPayloads> {
  const steps = new ChbStepRunner(report);
  const payloads: ChbPayloads = { twTransactions: [], fcTransactions: [] };

  // 台幣餘額：View 的「全部帳號」選項一次取得所有帳戶。
  await steps.run("twBalance", "fetch", async () => {
    const view = await chbRest(page, {
      url: "TW01001/tw01001_1_View",
      method: "GET",
      taskID: "tw01001",
      data: {},
    });
    const items = parseChbAccountItems(view);
    const all =
      pickChbAllAccountItem(items) ??
      (items.length === 1 ? items[0] : undefined);
    if (!all) throw new ChbProtocolError("台幣餘額頁沒有「全部帳號」選項。");
    payloads.twBalance = await chbRest(page, {
      url: "TW01001/tw01001_1_Action",
      method: "POST",
      taskID: "tw01001",
      data: { accountData: all.value, mgFlag: false },
    });
  });

  // 台幣明細：每個帳號各查一次；區間由 View 的查詢迄日決定日期格式。
  const twView = await steps.run("twTransactions", "view", async () => {
    const view = await chbRest(page, {
      url: "TW01002/tw01002_1_View",
      method: "GET",
      taskID: "tw01002",
      data: {},
    });
    return {
      items: chbSingleAccountItems(parseChbAccountItems(view)),
      range: chbQueryRange(findChbField(view, "queryEndDate")),
    };
  });
  for (const item of twView?.items ?? []) {
    await steps.run("twTransactions", "fetch", async () => {
      const data = await chbRest(page, {
        url: "TW01002/tw01002_1_Action",
        method: "POST",
        taskID: "tw01002",
        data: {
          mgFlag: false,
          accountData: item.value,
          currencyType: "0",
          inqType: "2",
          range: "0",
          queryStartDate: twView!.range.start,
          queryEndDate: twView!.range.end,
          resultViewType: "DISPLAY_BROWSER",
        },
      });
      payloads.twTransactions.push({
        accountNo: chbTwItemAccountNo(item),
        data,
      });
    });
  }

  // 外幣餘額：有「全部」選項時一次查；否則逐一查詢選單項目並合併。
  await steps.run("fcBalance", "fetch", async () => {
    const view = await chbRest(page, {
      url: "FC01001/fc01001_1_View",
      method: "GET",
      taskID: "fc01001",
      data: {},
    });
    const items = parseChbAccountItems(view);
    const all = pickChbAllAccountItem(items);
    const balance = (accountData: string) =>
      chbRest(page, {
        url: "FC01001/fc01001_1_Action",
        method: "POST",
        taskID: "fc01001",
        data: { accountData },
      });
    if (all || items.length === 1) {
      logChbEvent("chb_fc_balance_mode", { mode: "all", items: items.length });
      payloads.fcBalance = await balance((all ?? items[0]!).value);
      return;
    }
    logChbEvent("chb_fc_balance_mode", { mode: "each", items: items.length });
    const recordList: unknown[] = [];
    for (const item of items.slice(0, MAX_FC_ACCOUNTS)) {
      const data = await balance(item.value);
      const rows = (data as { recordList?: unknown } | undefined)?.recordList;
      if (Array.isArray(rows)) recordList.push(...rows);
    }
    payloads.fcBalance = { recordList };
  });

  // 外幣明細：每個帳號×幣別各查一次。
  const fcView = await steps.run("fcTransactions", "view", async () => {
    const view = await chbRest(page, {
      url: "FC01002/fc01002_1_View",
      method: "GET",
      taskID: "fc01002",
      data: {},
    });
    return {
      items: chbSingleAccountItems(parseChbAccountItems(view)).slice(
        0,
        MAX_FC_ACCOUNTS,
      ),
      range: chbQueryRange(findChbField(view, "endDate")),
    };
  });
  for (const item of fcView?.items ?? []) {
    const { accountNo, currency } = chbFcItemAccount(item);
    await steps.run("fcTransactions", "fetch", async () => {
      if (!accountNo || !/^[A-Z]{3}$/.test(currency)) {
        throw new ChbProtocolError("外幣帳號選項無法解析帳號或幣別。");
      }
      const data = await chbRest(page, {
        url: "FC01002/fc01002_1_Action",
        method: "POST",
        taskID: "fc01002",
        data: {
          accountData: item.value,
          range: "0",
          startDate: fcView!.range.start,
          endDate: fcView!.range.end,
          resultViewType: "DISPLAY_BROWSER",
          downloadType: "DISPLAY_MEDIA_HUNDREDFILE",
        },
      });
      payloads.fcTransactions.push({ accountNo, currency, data });
    });
  }
  return payloads;
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

async function firstPage(browser: Browser) {
  const pages = await browser.pages();
  return pages[0] ?? (await browser.newPage());
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
      throw new ChbVerificationRequiredError(
        "彰化銀行驗證工作階段已結束，請重新取得驗證碼。",
      );
    }
    if (preferred.connectionId) {
      throw new ChbBrowserCapacityError(
        "彰化銀行驗證工作階段正在使用中，請稍候再試。",
        3,
      );
    }
    try {
      return await connectBrowserWithCancellation(
        browserFetcher,
        preferred.sessionId,
      );
    } catch {
      throw new ChbBrowserCapacityError(
        "前一個彰化銀行驗證工作階段尚未釋放，請稍候再試。",
        3,
      );
    }
  }
  const limits = await puppeteer.limits(browserFetcher).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new BrowserRunCapacityError(
      "acquisition_rate_limit",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  return launchBrowserWithRetry(browserFetcher, {
    keep_alive: CAPTCHA_KEEP_ALIVE_MS,
  });
}

function getContext(page: Page): ChbPageContext {
  const context = pageContexts.get(page);
  if (!context) throw new ChbConnectionError("彰化銀行頁面尚未初始化。");
  return context;
}

function getSession(page: Page) {
  return getContext(page).session;
}

async function configurePage(page: Page, session: ChbSessionState) {
  await page.setViewport({ width: 1280, height: 900 });
  // 桌面 UA：行動裝置 UA 會載入行動版介面。
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const context: ChbPageContext = {
    session,
    dialogs: [],
    mainFrameNavigations: 0,
  };
  pageContexts.set(page, context);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) context.mainFrameNavigations += 1;
  });
  page.on("request", (request: HTTPRequest) => {
    if (isLoginRequest(request)) {
      session.loginRequested = true;
      session.loginRequests += 1;
    }
  });
  page.on("response", (response: HTTPResponse) => {
    if (isLoginRequest(response.request())) {
      session.loginRespondedAt = Date.now();
    }
  });
  // 原生對話框一律關閉：alert 確認、confirm／prompt 取消（不接受任何確認動作）。
  page.on("dialog", (dialog: Dialog) => {
    const message = dialog.message();
    if (context.dialogs.length < 10) context.dialogs.push(message);
    logChbEvent("chb_dialog", {
      type: dialog.type(),
      length: message.length,
    });
    const handled =
      dialog.type() === "alert" ? dialog.accept() : dialog.dismiss();
    handled.catch(() => undefined);
  });
}

function isLoginRequest(request: HTTPRequest) {
  return (
    request.method() === "POST" &&
    safePath(request.url()) === LOGIN_DISPATCH_PATH
  );
}

async function closeChbBrowser(browser: Browser, binding: Fetcher) {
  if (!(await closeBrowserSession(binding, browser))) {
    logChbEvent("chb_browser_cleanup_failed", {});
  }
}

async function withActionTimeout<T>(
  action: Promise<T>,
  timeoutMs = ACTION_TIMEOUT_MS,
): Promise<T> {
  action.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ChbActionTimeoutError()),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireCredentials(config: ChbConfig) {
  if (!config.nationalId || !config.userId || !config.password) {
    throw new ChbVerificationRequiredError(
      "請填寫身分證字號、使用者代號與密碼。",
    );
  }
}

export function isValidCaptcha(value: string) {
  return new RegExp(`^\\d{${CHB_CAPTCHA_DIGIT_COUNT}}$`).test(value);
}

function assertCaptcha(value: string) {
  if (!isValidCaptcha(value)) {
    throw new ChbCaptchaRejectedError(
      `彰化銀行驗證碼必須是 ${CHB_CAPTCHA_DIGIT_COUNT} 位數字。`,
    );
  }
}

function assertNotExpired(expiresAt: string | undefined, message: string) {
  if (!expiresAt || new Date(expiresAt) <= new Date()) {
    throw new ChbVerificationRequiredError(message);
  }
}

function mapChbError(error: unknown): Error {
  if (
    error instanceof ChbVerificationRequiredError ||
    error instanceof ChbBrowserCapacityError ||
    error instanceof BrowserRunCapacityError ||
    error instanceof ChbConnectionError
  ) {
    return error;
  }
  if (error instanceof ChbProtocolError) {
    return new ChbConnectionError(error.message, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ChbConnectionError(
    `彰化銀行連線失敗：${safeLogMessage(message)}`,
    error,
  );
}

function logChbResult(result: ReturnType<typeof summarizeChbResult>) {
  console.info(
    JSON.stringify({
      level: "info",
      event: "chb_sync_result",
      connectorId: "chb",
      ...result,
    }),
  );
}

function logChbEvent(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ event, connectorId: "chb", ...fields }));
}

function safePath(value: string) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function safeLogMessage(message: string) {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\b[A-Z][12]\d{8}\b/g, "[redacted]")
    .replace(/\d{6,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function toArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
