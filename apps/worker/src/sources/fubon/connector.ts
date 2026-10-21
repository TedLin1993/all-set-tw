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
  type Frame,
  type HTTPResponse,
  type Page,
} from "@cloudflare/puppeteer";
import {
  FUBON_CAPTCHA_DIGIT_COUNT,
  FubonProtocolError,
  FubonSyncReport,
  describeFubonError,
  normalizeFubonAccountNo,
  type FubonSyncCategory,
  type FubonTransactionAccountOption,
  classifyFubonLoginResponse,
  fubonBillPeriodIndex,
  fubonTransactionRange,
  describeFubonTransactionAccountsHtml,
  fubonComboValueShape,
  isFubonTransactionPageTruncated,
  matchFubonTransactionAccounts,
  parseFubonComboAccountValue,
  parseFubonCardStatus,
  parseFubonData,
  summarizeFubonResult,
  parseFubonDepositOverview,
  parseFubonDepositTransactionsPage,
  parseFubonTransactionAccounts,
  splitFubonRange,
  exceedsFubonRangeLimit,
  type FubonConfig,
  type FubonDepositAccount,
  type FubonLoginOutcome,
  type FubonPayloads,
} from "./protocol";
import {
  FUBON_LOGIN_SERVLET_PATH,
  FUBON_LOGOUT_AJAX_ACTION,
  FubonExchangeLog,
  createFubonEgressStats,
  enableFubonEgress,
  type FubonEgressFetch,
  type FubonEgressStats,
} from "./egress";

// 台北富邦網銀（JSF）。登入頁的帳密欄位 id/name 每次載入都會隨機化，
// 只能依「一般登入」區塊內的位置定位；不使用動態鍵盤。
const ORIGIN = "https://ebank.taipeifubon.com.tw";
const LOGIN_URL = `${ORIGIN}/B2C/cmfqu/cmfqu021/CMFQU021_Home.faces?menuId=CMF06&showLogin=true`;
const CONTEXT_FRAME_PATH = "/B2C/common/ContextFrame.faces";
const CONTEXT_FRAME_URL = `${ORIGIN}${CONTEXT_FRAME_PATH}`;
const HOME_PATH = "/B2C/cgequ/cgequ001/CGEQU001_Home.faces";
// 選單連結（/B2C/dispatcher?ParamValue=…）的 class：首頁（txnFrame 內 CGEQU001）為
// `task_<taskId> menu_<menuId>`，ContextFrame 頂層為 `taskId_<taskId> menuId_<menuId>`。
const PAGES = {
  depositOverview: {
    menuId: "CDS0102",
    taskId: "CBOQU003",
    path: "/B2C/cboqu/cboqu003/CBOQU003_Home.faces",
  },
  depositTransactions: {
    menuId: "CDS0401",
    taskId: "CDSQU001",
    path: "/B2C/cdsqu/cdsqu001/CDSQU001_Home.faces",
  },
  cardStatus: {
    menuId: "CCC0201",
    taskId: "CCCQU002",
    path: "/B2C/cccqu/cccqu002/CCCQU002_Home.faces",
  },
  cardBills: {
    menuId: "CCC0202",
    taskId: "CCCQU003",
    path: "/B2C/cccqu/cccqu003/CCCQU003_Home.faces",
  },
  cardUnbilled: {
    menuId: "CCC0203",
    taskId: "CCCQU004",
    path: "/B2C/cccqu/cccqu004/CCCQU004_Home.faces",
  },
} as const;
type FubonPageTarget = (typeof PAGES)[keyof typeof PAGES];
// ContextFrame 的內容頁框為 txnFrame（2026-10 HAR）。注意 frame1 是 Index.faces
// frameset 中承載 ContextFrame 本身的框架，不可當作內容頁框。
const CONTENT_FRAME_NAME = "txnFrame";
const BILL_PERIODS = ["1", "2", "3"] as const;

export const FUBON_AUTO_LOGIN_ATTEMPTS = 3;
export const FUBON_CAPTCHA_OCR_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
/** 雙重驗證 OTP 官方有效 300 秒；Browser session 在等待使用者輸入期間保留。 */
const OTP_KEEP_ALIVE_MS = 300_000;
const OTP_VALIDITY_MS = 270_000;
const LOGIN_FORM_TIMEOUT_MS = 30_000;
const LOGIN_RESULT_TIMEOUT_MS = 30_000;
/** 登入後到首頁就緒（ContextFrame?t= → /B2C → Index.faces → frame1 → txnFrame）。 */
const LOGGED_IN_TIMEOUT_MS = 45_000;
const PAGE_TIMEOUT_MS = 30_000;
// 功能頁已載入但尚未出現預期內容（例如交易明細的帳號選單）時，最多再等這麼久，
// 之後仍回傳框架，交由呼叫端記錄診斷並決定是否失敗。
const PAGE_MARKER_GRACE_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
/** 登出為盡力而為：整體上限，逾時不影響原本的結果或錯誤。 */
const LOGOUT_TIMEOUT_MS = 25_000;
/** 登入回應不明時，等待頁面自行導向 ContextFrame 並顯示已登入的時間。 */
const LOGIN_NAVIGATION_GRACE_MS = 15_000;
const POLL_MS = 300;
const MAX_TRANSACTION_QUERIES_PER_ACCOUNT = 12;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class FubonVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonVerificationRequiredError";
  }
}

export class FubonCredentialRejectedError extends FubonVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FubonCredentialRejectedError";
  }
}

export class FubonCaptchaRejectedError extends FubonVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FubonCaptchaRejectedError";
  }
}

/**
 * 非信任裝置的雙重驗證：已向銀行要求寄送簡訊／Email OTP，Browser session
 * 保留在登入頁的 OTP 輸入畫面，待使用者輸入後接續同一次登入。
 */
export class FubonOtpRequiredError extends FubonVerificationRequiredError {
  constructor(
    message: string,
    readonly otpBrowserSessionId: string,
    readonly otpExpiresAt: string,
  ) {
    super(message);
    this.name = "FubonOtpRequiredError";
  }
}

/** OTP 錯誤但未達銀行錯誤上限，保留同一個 Browser session 讓使用者重輸。 */
export class FubonOtpInvalidError extends FubonVerificationRequiredError {
  constructor(
    message: string,
    readonly otpBrowserSessionId: string,
    readonly otpExpiresAt: string,
  ) {
    super(message);
    this.name = "FubonOtpInvalidError";
  }
}

export class FubonConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FubonConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** 網銀工作階段已結束（被登出、逾時）；不可略過，整次同步失敗。 */
export class FubonSessionEndedError extends FubonConnectionError {
  constructor(message = "台北富邦網銀工作階段已結束，請重新同步。") {
    super(message);
    this.name = "FubonSessionEndedError";
  }
}

export class FubonBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "FubonBrowserCapacityError";
  }
}

class FubonActionTimeoutError extends Error {
  constructor() {
    super("台北富邦瀏覽器操作沒有在期限內回應。");
    this.name = "FubonActionTimeoutError";
  }
}

/**
 * 一次同步中的登入狀態。登入 POST 送出後的任何路徑（成功、結果不明、例外、
 * 逾時）都必須在關閉瀏覽器前嘗試官方登出，只有仍在等待使用者輸入 OTP
 * （保留 Browser session）時例外。
 */
export type FubonSessionState = {
  loginRequested: boolean;
  loggedIn: boolean;
  /** 最近一次登入回應的分類；用於判斷銀行端是否可能已建立工作階段。 */
  lastOutcome?: FubonLoginOutcome["kind"];
  /** 保留 Browser session 等待使用者輸入 OTP；此時不得登出。 */
  otpPending: boolean;
  /** 登入請求送出後曾有框架載入網銀首頁（CGEQU001），即銀行端已建立工作階段。 */
  homeSeen?: boolean;
};

export function createFubonSessionState(): FubonSessionState {
  return { loginRequested: false, loggedIn: false, otpPending: false };
}

type FubonPageContext = {
  exchanges: FubonExchangeLog;
  session: FubonSessionState;
  menuHrefs: Map<string, string>;
};
const pageContexts = new WeakMap<Page, FubonPageContext>();

type PreparedFubonCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaDigitCount: number;
};

type RecognizeCaptcha = (
  imageBytes: ArrayBuffer,
  contentType: string,
  digitCount: number,
) => Promise<string>;

export type FubonConnectorOptions = {
  /** 只有使用者在場的手動同步可以請銀行寄送雙重驗證 OTP；排程一律不寄送。 */
  allowOtpRequest: boolean;
  /** 網銀請求的代發出口（FubonEgress Durable Object）；Browser Run 無法直連網銀。 */
  egress: FubonEgressFetch | undefined;
};

export function createFubonConnector(
  browserFetcher: Fetcher | undefined,
  recognizeCaptcha: RecognizeCaptcha | undefined,
  options: FubonConnectorOptions,
) {
  return {
    id: "fubon" as const,
    async sync(
      config: FubonConfig,
      _cursor?: string,
    ): Promise<
      SyncResult<unknown> & { hasCreditCard?: boolean; syncWarning?: string }
    > {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new FubonConnectionError("Browser binding is unavailable.");
      }
      const egress = options.egress;
      if (!egress) {
        throw new FubonConnectionError("Fubon egress binding is unavailable.");
      }
      const egressStats = createFubonEgressStats();
      const otpMode = Boolean(config.otp && config.otpBrowserSessionId);
      const manualCaptcha =
        !otpMode && Boolean(config.browserSessionId && config.captcha);
      if (config.otp && !config.otpBrowserSessionId) {
        throw new FubonVerificationRequiredError(
          "台北富邦雙重驗證工作階段已結束，請重新同步。",
        );
      }
      if (otpMode) {
        if (!options.allowOtpRequest) {
          throw new FubonVerificationRequiredError(
            "台北富邦雙重驗證只能在手動同步中完成。",
          );
        }
        assertNotExpired(
          config.otpExpiresAt,
          "台北富邦雙重驗證碼已逾時，請重新同步。",
        );
      } else if (manualCaptcha) {
        assertNotExpired(
          config.browserSessionExpiresAt,
          "台北富邦圖形驗證碼已逾時，請重新取得驗證碼。",
        );
        assertCaptcha(config.captcha ?? "");
      } else if (!recognizeCaptcha) {
        throw new FubonVerificationRequiredError(
          "台北富邦圖形驗證碼無法自動辨識，請改用人工輸入。",
        );
      }

      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      let preserveBrowser = false;
      let report: FubonSyncReport | undefined;
      let summaryLogged = false;
      const session = createFubonSessionState();
      try {
        return await runWithFubonLogout(
          session,
          async () => {
            if (otpMode) {
              browserInstance = await acquireBrowser(
                browserFetcher,
                config.otpBrowserSessionId,
                "台北富邦雙重驗證工作階段已結束，請重新同步。",
              );
              page = await firstPage(browserInstance);
              await configurePage(page, egress, egressStats, session);
              const verified = await submitTwoFactorOtp(page, config.otp ?? "");
              if (verified.kind === "retry") {
                const sessionId = browserInstance.sessionId();
                session.otpPending = true;
                await browserInstance.disconnect();
                preserveBrowser = true;
                throw new FubonOtpInvalidError(
                  verified.message,
                  sessionId,
                  config.otpExpiresAt ?? new Date().toISOString(),
                );
              }
              await finishLogin(page, verified.outcome, {
                browser: browserInstance,
                allowOtpRequest: false,
              });
            } else if (manualCaptcha) {
              browserInstance = await acquireBrowser(
                browserFetcher,
                config.browserSessionId,
                "台北富邦驗證工作階段已結束，請重新取得驗證碼。",
              );
              page = await firstPage(browserInstance);
              await configurePage(page, egress, egressStats, session);
              await fillLoginForm(page, config);
              const outcome = await submitLogin(page, config.captcha ?? "");
              logFubonEvent("fubon_login_result", {
                mode: "manual",
                outcome: outcome.kind,
                code: outcome.kind === "success" ? undefined : outcome.code,
              });
              await finishLogin(page, outcome, {
                browser: browserInstance,
                allowOtpRequest: options.allowOtpRequest,
              });
            } else {
              const prepared = await prepareBrowserLoginWithRetry({
                binding: browserFetcher,
                connectorId: "fubon",
                launchOptions: {
                  keep_alive: options.allowOtpRequest
                    ? OTP_KEEP_ALIVE_MS
                    : CAPTCHA_KEEP_ALIVE_MS,
                },
                isRetryable: (error) =>
                  error instanceof FubonActionTimeoutError ||
                  (error instanceof FubonConnectionError &&
                    /^台北富邦登入頁沒有在期限內/.test(error.message)),
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
                  await configurePage(page, egress, egressStats, session);
                  const captcha = await openLoginAndCaptureCaptcha(
                    page,
                    config,
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
              await finishLogin(page, outcome, {
                browser: browserInstance,
                allowOtpRequest: options.allowOtpRequest,
              });
            }

            report = new FubonSyncReport();
            reportSyncProgress("fetching");
            const payloads = await fetchFubonPayloads(page, report);
            const data = parseFubonData(payloads, new Date(), report);
            logFubonSyncSummary(report, "finished");
            summaryLogged = true;
            if (report.failedCount > 0 && data.bankAccounts.length === 0) {
              throw new FubonConnectionError(
                `台北富邦同步未取得任何資料。${report.userMessage() ?? ""}`,
              );
            }
            logFubonEvent(
              "fubon_sync_result",
              summarizeFubonResult(data, report),
            );
            return {
              records: [],
              ...data,
              syncWarning: report.userMessage(),
              cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
            };
          },
          () => (page ? logoutFubon(page, session) : undefined),
        );
      } catch (error) {
        if (error instanceof FubonOtpRequiredError) preserveBrowser = true;
        throw mapFubonError(error);
      } finally {
        if (report && !summaryLogged) logFubonSyncSummary(report, "aborted");
        if (browserInstance && !preserveBrowser)
          await closeFubonBrowser(browserInstance, browserFetcher);
        logFubonEgressStats(egressStats);
      }
    },
  };
}

export async function prepareFubonCaptcha(
  browserFetcher: Fetcher | undefined,
  config: FubonConfig | undefined,
  egress: FubonEgressFetch | undefined,
): Promise<PreparedFubonCaptcha> {
  if (!config) {
    throw new FubonVerificationRequiredError(
      "請填寫身分證字號、使用者代碼與使用者密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new FubonConnectionError("Browser binding is unavailable.");
  }
  if (!egress) {
    throw new FubonConnectionError("Fubon egress binding is unavailable.");
  }
  const egressStats = createFubonEgressStats();
  const browserInstance = await acquireBrowser(browserFetcher);
  let preserved = false;
  try {
    const page = await firstPage(browserInstance);
    await configurePage(page, egress, egressStats, createFubonSessionState());
    const captcha = await openLoginAndCaptureCaptcha(page, config);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: FUBON_CAPTCHA_DIGIT_COUNT,
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(captcha)}`,
    };
  } catch (error) {
    throw mapFubonError(error);
  } finally {
    if (!preserved) await closeFubonBrowser(browserInstance, browserFetcher);
    logFubonEgressStats(egressStats);
  }
}

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

async function loginWithOcr(
  page: Page,
  config: FubonConfig,
  recognizeCaptcha: RecognizeCaptcha,
  initialCaptcha: Uint8Array,
): Promise<FubonLoginOutcome> {
  for (let attempt = 1; attempt <= FUBON_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    const captcha =
      attempt === 1
        ? initialCaptcha
        : await openLoginAndCaptureCaptcha(page, config);
    const answer = await recognizeValidCaptcha(
      page,
      recognizeCaptcha,
      captcha,
      attempt,
    );
    if (!answer) continue;
    const outcome = await submitLogin(page, answer);
    logFubonEvent("fubon_login_result", {
      attempt,
      mode: "automatic",
      outcome: outcome.kind,
      code: outcome.kind === "success" ? undefined : outcome.code,
    });
    // 只有明確的圖形驗證碼錯誤可以重試；帳密錯誤會累計鎖定次數，不得重送。
    if (outcome.kind !== "captcha") return outcome;
  }
  throw new FubonVerificationRequiredError(
    `台北富邦自動驗證連續失敗 ${FUBON_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

/**
 * 辨識結果不是 6 位數字時，在同一頁換一張驗證碼重新辨識（尚未送出帳密），
 * 最多 FUBON_CAPTCHA_OCR_ATTEMPTS 次；全部失敗回傳 undefined。
 */
async function recognizeValidCaptcha(
  page: Page,
  recognizeCaptcha: RecognizeCaptcha,
  initialCaptcha: Uint8Array,
  loginAttempt: number,
): Promise<string | undefined> {
  let captcha = initialCaptcha;
  for (let ocrAttempt = 1; ; ocrAttempt += 1) {
    let answer = "";
    let errorName: string | undefined;
    try {
      answer = await recognizeCaptcha(
        toArrayBuffer(captcha),
        "image/jpeg",
        FUBON_CAPTCHA_DIGIT_COUNT,
      );
    } catch (error) {
      errorName = error instanceof Error ? error.name : typeof error;
    }
    const valid = isValidCaptcha(answer);
    logFubonEvent("fubon_captcha_ocr", {
      loginAttempt,
      ocrAttempt,
      ocrLength: answer.length,
      valid,
      errorName,
    });
    if (valid) return answer;
    if (ocrAttempt >= FUBON_CAPTCHA_OCR_ATTEMPTS) return undefined;
    captcha = await refreshCaptcha(page);
  }
}

async function finishLogin(
  page: Page,
  outcome: FubonLoginOutcome,
  context: { browser: Browser; allowOtpRequest: boolean },
) {
  switch (outcome.kind) {
    case "success":
      await waitForFubonLoggedIn(page);
      await collectMenuHrefs(page);
      return;
    case "captcha":
      throw new FubonCaptchaRejectedError(
        "台北富邦圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    case "credential":
      throw new FubonCredentialRejectedError(
        `台北富邦拒絕登入（${outcome.code}）：身分證字號、使用者代碼或密碼錯誤。為避免帳號鎖定，已停止同步，請確認帳密後再試。`,
      );
    case "locked":
      throw new FubonCredentialRejectedError(
        `台北富邦網路銀行暫時無法登入（${outcome.code}），請至官方網銀或洽客服確認帳號狀態。`,
      );
    case "duplicate":
      // 官方頁面會以 confirm 詢問是否接管其他登入；連接器不接管其他工作階段。
      throw new FubonVerificationRequiredError(
        "台北富邦回覆已有其他登入中的網銀工作階段（0212），為避免中斷其他裝置，已停止同步。請先登出其他裝置或稍後再試。",
      );
    case "session_timeout":
      throw new FubonConnectionError(
        "台北富邦登入頁閒置過久（0240），請重新同步。",
      );
    case "two_factor":
      return startTwoFactor(page, outcome.channel, context);
    default:
      throw new FubonConnectionError(
        `台北富邦登入結果不明（${outcome.code}），為避免重複送出帳密，已停止同步。`,
      );
  }
}

/**
 * 雙重驗證登入（非信任裝置）。
 * 此流程依官方登入頁 JS（doLogin 0241 分支、insertTwoFactorAuth、
 * showOtp/sendOtp、verifyOtp）實作；實測帳號未觸發雙重驗證，尚未以真實回應確認：
 * - Fubon+ App 推播路徑在 insertTwoFactorAuth 後改用 showOtp 是否可直接寄出 OTP；
 * - sendTwoFactorOtp 回應的 content/txCode 文字是否已遮罩；
 * - Browser session 斷線等待期間（最長約 4.5 分鐘）頁面計時器是否仍正常。
 */
async function startTwoFactor(
  page: Page,
  channel: "otp" | "device",
  context: { browser: Browser; allowOtpRequest: boolean },
): Promise<never> {
  logFubonEvent("fubon_two_factor_required", {
    channel,
    otpAllowed: context.allowOtpRequest,
  });
  if (!context.allowOtpRequest) {
    // 排程同步不得觸發 App 推播或 OTP；登入頁的對應函式已在送出前替換為 no-op。
    throw new FubonVerificationRequiredError(
      "台北富邦要求雙重驗證（目前裝置非信任裝置），排程同步不會寄送驗證碼。請改用手動同步完成簡訊／Email 驗證。",
    );
  }
  const sent = await requestTwoFactorOtp(page, channel);
  if (!sent.ok) {
    throw new FubonVerificationRequiredError(
      `台北富邦雙重驗證碼寄送失敗：${sent.message || "請稍後再試。"}`,
    );
  }
  const sessionId = context.browser.sessionId();
  const state = pageContexts.get(page)?.session;
  if (state) state.otpPending = true;
  await context.browser.disconnect();
  throw new FubonOtpRequiredError(
    sent.message
      ? `台北富邦已寄出雙重驗證碼：${sent.message}`
      : "台北富邦已寄出雙重驗證碼（簡訊或 Email），請於有效時間內輸入 6 位數驗證碼。",
    sessionId,
    new Date(Date.now() + OTP_VALIDITY_MS).toISOString(),
  );
}

async function requestTwoFactorOtp(
  page: Page,
  channel: "otp" | "device",
): Promise<{ ok: boolean; message: string }> {
  const sendResponse = waitForServletResponse(page, "sendTwoFactorOtp");
  const insertResponse =
    channel === "device"
      ? waitForServletResponse(page, "insertTwoFactorAuth")
      : undefined;
  await withActionTimeout(
    page.evaluate((useDevice: boolean) => {
      const win = window as unknown as {
        __fubonOriginal?: Record<string, (...args: unknown[]) => unknown>;
        __fubonDeviceKey?: string;
      };
      const original = win.__fubonOriginal ?? {};
      if (useDevice && original.insertTwoFactorAuth) {
        // 與官方畫面相同：先建立雙重驗證紀錄，再改用「簡訊/Email OTP驗證」。
        original.insertTwoFactorAuth(win.__fubonDeviceKey ?? "deviceId");
      } else {
        original.showOtp?.();
      }
    }, channel === "device"),
  );
  if (insertResponse) {
    const inserted = await insertResponse;
    if (!inserted || inserted.result !== true) {
      return { ok: false, message: safeBankMessage(inserted?.message) };
    }
    await withActionTimeout(
      page.evaluate(() => {
        const win = window as unknown as {
          __fubonOriginal?: Record<string, (...args: unknown[]) => unknown>;
        };
        win.__fubonOriginal?.showOtp?.();
      }),
    );
  }
  const sent = await sendResponse;
  if (!sent || sent.result !== true) {
    return { ok: false, message: safeBankMessage(sent?.message) };
  }
  return { ok: true, message: safeBankMessage(sent.content) };
}

async function submitTwoFactorOtp(
  page: Page,
  otp: string,
): Promise<
  | { kind: "verified"; outcome: FubonLoginOutcome }
  | { kind: "retry"; message: string }
> {
  if (!/^\d{6}$/.test(otp)) {
    throw new FubonVerificationRequiredError("台北富邦驗證碼必須是 6 位數字。");
  }
  const ready = await withActionTimeout(
    page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#m1_inputOTP");
      return Boolean(
        input && typeof (window as { doOtp?: unknown }).doOtp === "function",
      );
    }),
  ).catch(() => false);
  if (!ready) {
    throw new FubonVerificationRequiredError(
      "台北富邦雙重驗證畫面已結束，請重新同步。",
    );
  }
  const verifyResponse = waitForServletResponse(page, "verifyOtp");
  const loginResponse = waitForServletResponse(page, "login");
  await withActionTimeout(
    page.evaluate((value: string) => {
      const input = document.querySelector<HTMLInputElement>("#m1_inputOTP");
      if (!input) return;
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const doOtp = (window as { doOtp?: () => void }).doOtp;
      setTimeout(() => doOtp?.(), 0);
    }, otp),
  );
  const verified = await verifyResponse;
  logFubonEvent("fubon_two_factor_otp_result", {
    result: verified?.result === true,
    maxFlag: verified?.maxFlag === true,
  });
  if (!verified) {
    throw new FubonConnectionError(
      "台北富邦雙重驗證結果不明，為避免重複送出，已停止同步。",
    );
  }
  if (verified.result !== true) {
    const message =
      safeBankMessage(verified.message) || "台北富邦驗證碼錯誤，請重新輸入。";
    if (verified.maxFlag === true) {
      throw new FubonVerificationRequiredError(
        `${message} 已達錯誤上限，請重新同步取得新的驗證碼。`,
      );
    }
    return { kind: "retry", message };
  }
  // 驗證成功後官方程式會立即重送登入請求。
  const state = pageContexts.get(page)?.session;
  if (state) state.loginRequested = true;
  const login = await loginResponse;
  const outcome = await resolveLoginOutcome(page, login, "two_factor");
  if (state) state.lastOutcome = outcome.kind;
  return { kind: "verified", outcome };
}

/**
 * 以代發層保留的 B2CLoginServlet 回應分類；取不到時，若頁面已導向 ContextFrame
 * 且顯示已登入，視為成功（官方成功處理函式以 parent.location 導向 ContextFrame）。
 * 注意 0212 拒絕接管與 0213 也會導向 ContextFrame，但不會是已登入狀態。
 */
async function resolveLoginOutcome(
  page: Page,
  body: Record<string, unknown> | undefined,
  mode: string,
): Promise<FubonLoginOutcome> {
  if (body) {
    const outcome = classifyFubonLoginResponse(body);
    logFubonEvent("fubon_login_response", {
      mode,
      source: "egress_or_page",
      outcome: outcome.kind,
    });
    return outcome;
  }
  const loggedIn = await isLoggedInContextFrame(
    page,
    LOGIN_NAVIGATION_GRACE_MS,
  );
  logFubonEvent("fubon_login_response", {
    mode,
    source: loggedIn ? "navigation" : "none",
    outcome: loggedIn ? "success" : "unknown",
  });
  return loggedIn
    ? { kind: "success" }
    : { kind: "unknown", code: "no_response" };
}

async function openLoginAndCaptureCaptcha(
  page: Page,
  config: FubonConfig,
  reportStage?: ReportBrowserLoginStage,
) {
  reportStage?.("navigate");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  reportStage?.("form");
  await waitForLoginForm(page);
  await revealLoginForm(page);
  await fillLoginForm(page, config);
  reportStage?.("captcha");
  return captureCaptcha(page);
}

async function waitForLoginForm(page: Page) {
  try {
    await page.waitForFunction(
      () =>
        typeof (window as { doLogin?: unknown }).doLogin === "function" &&
        document.querySelectorAll("#tab1 .m1_login_input table.login_tb input")
          .length >= 4 &&
        Boolean(document.querySelector("#m1_userCaptcha")),
      { timeout: LOGIN_FORM_TIMEOUT_MS },
    );
  } catch {
    throw new FubonConnectionError("台北富邦登入頁沒有在期限內載入登入表單。");
  }
}

/**
 * 登入框 `#login_div` 預設隱藏；官方首頁在外層框架中以 `checkLogin('CMF06')`
 * 詢問 B2CLoginServlet 後呼叫 `showLogin(taskURL, menuId)` 顯示。連接器單獨載入
 * 登入頁（沒有外層框架），因此補上外層框架的空函式後依同樣順序呼叫，
 * 驗證碼圖片才可見、可截圖。
 */
async function revealLoginForm(page: Page) {
  const shown = await withActionTimeout(
    page.evaluate((menuId: string) => {
      const box = document.querySelector<HTMLElement>("#login_div");
      if (!box) return false;
      if (getComputedStyle(box).display !== "none") return true;
      const win = window as unknown as Record<string, unknown> & {
        $?: {
          ajax: (url: string, options: Record<string, unknown>) => unknown;
          cfg?: { cp?: string };
        };
        showLogin?: (taskURL: string, menuId: string) => void;
      };
      // 外層 ContextFrame 才有的函式；單獨載入時 parent === window。
      for (const name of [
        "showRain",
        "showJponits",
        "resetPageTimeout",
        "checkBrowserVersion",
      ]) {
        if (typeof win[name] !== "function") win[name] = () => undefined;
      }
      let taskURL = "";
      win.$?.ajax(`${win.$.cfg?.cp ?? "/B2C"}/B2CLoginServlet`, {
        async: false,
        type: "POST",
        data: { action: "checkLogin", menuId },
        dataType: "json",
        success: (data: { success?: boolean; taskURL?: unknown }) => {
          if (data?.success && typeof data.taskURL === "string")
            taskURL = data.taskURL;
        },
      });
      try {
        win.showLogin?.(taskURL, menuId);
      } catch {
        // showLogin 尾端呼叫外層框架函式；登入框已先顯示。
      }
      if (getComputedStyle(box).display === "none") box.style.display = "block";
      // 官方 $(document).ready 第一行呼叫 window.parent.showRain；單獨載入時該函式
      // 不存在而丟出例外，後續的 login_pop()（設定頁籤 li.active 並綁定點擊）不會執行。
      // 沒有 li.active 時 validate() 取得的 selectedTab 為 undefined 並丟出 TypeError，
      // 登入請求永遠不會送出，因此在此補跑 login_pop。
      if (!document.querySelector("ul.login_m li.active")) {
        const loginPop = win.login_pop;
        if (typeof loginPop === "function") {
          try {
            (loginPop as () => void)();
          } catch {
            // 下方仍會直接補上 active。
          }
        }
        if (!document.querySelector("ul.login_m li.active")) {
          document.querySelector("ul.login_m li")?.classList.add("active");
        }
      }
      return getComputedStyle(box).display !== "none";
    }, "CMF06"),
  );
  if (!shown) {
    throw new FubonConnectionError("台北富邦登入頁沒有顯示登入框。");
  }
}

/** 欄位 id/name 每次載入都不同，只依「一般登入」表格內的位置填入。 */
async function fillLoginForm(page: Page, config: FubonConfig) {
  const filled = await withActionTimeout(
    page.evaluate(
      (userId: string, account: string, password: string) => {
        const tab = document.querySelector<HTMLAnchorElement>(
          "#login_div ul.login_m a.m1, ul.login_m a.m1",
        );
        const activeTab = () =>
          document
            .querySelector("ul.login_m li.active a")
            ?.getAttribute("class") ?? null;
        if (tab && activeTab() !== "m1") tab.click();
        // validate()/doLogin() 以整個 class 屬性組合欄位 id，必須恰為 "m1"。
        if (activeTab() !== "m1") return false;
        const inputs = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            "#tab1 .m1_login_input table.login_tb input",
          ),
        ).filter((input) => input.id !== "m1_userCaptcha");
        const [idInput, userInput, passwordInput] = inputs;
        if (
          !idInput ||
          !userInput ||
          !passwordInput ||
          !passwordInput.classList.contains("m1_password")
        ) {
          return false;
        }
        const assign = (input: HTMLInputElement, value: string) => {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        assign(idInput, userId.toUpperCase());
        assign(userInput, account);
        assign(passwordInput, password);
        return true;
      },
      config.userId ?? "",
      config.account ?? "",
      config.password ?? "",
    ),
  );
  if (!filled) {
    throw new FubonConnectionError("台北富邦登入表單結構已變更。");
  }
}

/** 以官方 doReGenCode 在同一頁換一張驗證碼（不重新載入登入頁、不清除帳密）。 */
async function refreshCaptcha(page: Page): Promise<Uint8Array> {
  const previous = await withActionTimeout(
    page.evaluate(() => {
      const image =
        document.querySelector<HTMLImageElement>("#m1_captchaImage");
      const source = image?.getAttribute("src") ?? "";
      const regen = (window as { doReGenCode?: () => unknown }).doReGenCode;
      if (typeof regen === "function") {
        regen();
      } else if (image) {
        image.src = `/B2C/captchaImage?timestamp=${Date.now()}`;
      }
      return source;
    }),
  );
  try {
    await page.waitForFunction(
      (oldSource: string) => {
        const image =
          document.querySelector<HTMLImageElement>("#m1_captchaImage");
        return Boolean(
          image &&
          image.getAttribute("src") !== oldSource &&
          image.complete &&
          image.naturalWidth > 0,
        );
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      previous,
    );
  } catch {
    throw new FubonConnectionError("台北富邦登入頁沒有在期限內更新驗證碼。");
  }
  return captureCaptcha(page);
}

async function captureCaptcha(page: Page): Promise<Uint8Array> {
  try {
    await page.waitForFunction(
      () => {
        const image =
          document.querySelector<HTMLImageElement>("#m1_captchaImage");
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
    );
  } catch {
    throw new FubonConnectionError("台北富邦登入頁沒有在期限內顯示驗證碼。");
  }
  const image = await page.$("#m1_captchaImage");
  if (!image) {
    throw new FubonConnectionError("台北富邦登入頁沒有在期限內顯示驗證碼。");
  }
  const screenshot = await withActionTimeout(
    image.screenshot({ type: "jpeg", quality: 90 }),
  );
  return typeof screenshot === "string"
    ? Uint8Array.from(atob(screenshot), (char) => char.charCodeAt(0))
    : new Uint8Array(screenshot);
}

type FubonSubmitDiagnostics = {
  ready: boolean;
  selectedTab: string | null;
  validateOk: boolean | null;
  exception: string | null;
  loginRequested: boolean;
  celebrusSkipped: boolean;
};

async function submitLogin(
  page: Page,
  captcha: string,
): Promise<FubonLoginOutcome> {
  // 不合格式的驗證碼一定會被官方 validate() 擋下，絕不送出。
  assertCaptcha(captcha);
  const loginResponse = waitForServletResponse(
    page,
    "login",
    LOGIN_RESULT_TIMEOUT_MS,
  );
  const onDialog = (dialog: Dialog) => {
    // 重複登入（0212）的接管確認一律拒絕；其他 alert 只關閉。
    void (dialog.type() === "alert" ? dialog.accept() : dialog.dismiss()).catch(
      () => undefined,
    );
  };
  page.on("dialog", onDialog);
  try {
    const diagnostics = await withActionTimeout(
      page.evaluate((value: string): FubonSubmitDiagnostics => {
        const result: FubonSubmitDiagnostics = {
          ready: false,
          selectedTab: null,
          validateOk: null,
          exception: null,
          loginRequested: false,
          celebrusSkipped: false,
        };
        type AjaxFn = (...args: unknown[]) => unknown;
        const win = window as unknown as Record<string, unknown> & {
          $?: { ajax: AjaxFn };
          __fubonOriginal?: Record<string, unknown>;
          __fubonTwoFactor?: string;
          __fubonDeviceKey?: string;
          __fubonValidateWrapped?: boolean;
          __fubonValidateOk?: boolean | null;
        };
        const input =
          document.querySelector<HTMLInputElement>("#m1_userCaptcha");
        const jq = win.$;
        if (!input || typeof win.doLogin !== "function" || !jq) return result;
        result.ready = true;
        result.selectedTab =
          document
            .querySelector("ul.login_m li.active a")
            ?.getAttribute("class") ?? null;
        input.value = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        // 雙重驗證時官方程式會立即寄送 OTP 或 App 推播；先替換為只記錄的函式，
        // 是否寄送改由連接器依手動／排程決定。
        win.__fubonOriginal = win.__fubonOriginal ?? {
          showOtp: win.showOtp,
          insertTwoFactorAuth: win.insertTwoFactorAuth,
        };
        win.showOtp = () => {
          win.__fubonTwoFactor = "otp";
        };
        win.insertTwoFactorAuth = (deviceKey: unknown) => {
          win.__fubonTwoFactor = "device";
          win.__fubonDeviceKey =
            typeof deviceKey === "string" ? deviceKey : undefined;
        };
        win.confirm = () => false;
        // validate() 開頭的點擊追蹤（/B2C/click）失敗不可影響登入。
        const trackClick = win.trackClick;
        if (typeof trackClick === "function" && !("__fubon" in trackClick)) {
          const safeTrackClick = function (this: unknown, ...args: unknown[]) {
            try {
              (trackClick as AjaxFn).apply(this, args);
            } catch {
              // 只是追蹤。
            }
            return true;
          };
          Object.assign(safeTrackClick, { __fubon: true });
          win.trackClick = safeTrackClick;
        }
        // 記錄官方 validate() 的結果（doLogin 以全域名稱呼叫）。
        const validate = win.validate;
        if (typeof validate === "function" && !win.__fubonValidateWrapped) {
          win.validate = function (this: unknown, ...args: unknown[]) {
            const ok = (validate as AjaxFn).apply(this, args);
            win.__fubonValidateOk = Boolean(ok);
            return ok;
          };
          win.__fubonValidateWrapped = true;
        }
        win.__fubonValidateOk = null;
        // Celebrus 行為分析會在登入前同步呼叫 celebrusEncryptUserId；與登入無關，略過。
        if (win.fuboncsaCelebrusApi) {
          win.fuboncsaCelebrusApi = undefined;
          result.celebrusSkipped = true;
        }
        const realAjax = jq.ajax;
        jq.ajax = function (this: unknown, ...args: unknown[]) {
          const options = (typeof args[0] === "string" ? args[1] : args[0]) as
            { data?: { action?: unknown } } | undefined;
          if (options?.data?.action === "login") result.loginRequested = true;
          return realAjax.apply(this, args);
        };
        try {
          // 同步呼叫：官方 doLogin 的例外不會再被 setTimeout 吞掉。
          (win.doLogin as () => unknown)();
        } catch (error) {
          result.exception = error instanceof Error ? error.name : typeof error;
        } finally {
          jq.ajax = realAjax;
        }
        result.validateOk =
          typeof win.__fubonValidateOk === "boolean"
            ? win.__fubonValidateOk
            : null;
        return result;
      }, captcha),
    ).catch((error: unknown) => {
      // 無法確認是否已送出：視為已送出，結束前仍會嘗試登出。
      const state = pageContexts.get(page)?.session;
      if (state) state.loginRequested = true;
      throw new FubonConnectionError(
        "台北富邦登入送出狀態不明，為避免重複送出帳密，已停止同步。",
        error,
      );
    });
    if (!diagnostics.ready) {
      throw new FubonConnectionError("台北富邦登入頁沒有找到登入功能。");
    }
    const validation = diagnostics.loginRequested
      ? []
      : await readValidationMessages(page);
    logFubonEvent("fubon_login_submit", {
      selectedTab: diagnostics.selectedTab,
      validateOk: diagnostics.validateOk,
      exception: diagnostics.exception,
      loginRequested: diagnostics.loginRequested,
      celebrusSkipped: diagnostics.celebrusSkipped,
      validationMessages: validation,
      captchaLength: captcha.length,
    });
    if (!diagnostics.loginRequested) {
      // 尚未送出帳密：回報具體原因，不得當成結果不明。
      throw new FubonConnectionError(
        describeUnsentLogin(diagnostics, validation),
      );
    }
    const state = pageContexts.get(page)?.session;
    if (state) state.loginRequested = true;
    const body = await loginResponse;
    const outcome = await resolveLoginOutcome(page, body, "password");
    if (state) state.lastOutcome = outcome.kind;
    return outcome;
  } finally {
    page.off("dialog", onDialog);
  }
}

export function describeUnsentLogin(
  diagnostics: Pick<
    FubonSubmitDiagnostics,
    "selectedTab" | "validateOk" | "exception"
  >,
  validationMessages: string[],
) {
  const prefix = "台北富邦登入頁未送出登入請求（帳密未送出）";
  if (validationMessages.length > 0) {
    return `${prefix}：${validationMessages.join("；")}`;
  }
  if (diagnostics.exception) {
    return `${prefix}：登入頁程式發生 ${diagnostics.exception}（頁籤 ${diagnostics.selectedTab ?? "未選取"}）。`;
  }
  if (diagnostics.validateOk === false) {
    return `${prefix}：登入表單未通過官方格式檢查。`;
  }
  return `${prefix}，原因不明。`;
}

async function readValidationMessages(page: Page) {
  return withActionTimeout(
    page.evaluate(() => {
      const seen = new Set<string>();
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>(
          "#tab1 .warning_s, #tab1 [id$='_msg'], #loginError_m1 .error_msg",
        ),
      )) {
        if (element.offsetParent === null) continue;
        const text = element.innerText.replace(/[！!]\s*/g, " ").trim();
        if (text) seen.add(text.slice(0, 60));
      }
      return Array.from(seen).slice(0, 5);
    }),
  )
    .then((messages) => messages.map((message) => safeBankMessage(message)))
    .catch(() => [] as string[]);
}

/**
 * 等待頁面自己送出的 B2CLoginServlet 請求回應（以 form action 區分）。
 * 以代發層在回填前保留的 JSON 為準（頁面導向後 puppeteer 已讀不到內容）；
 * puppeteer 的 response.json() 只作為備援，且只在取得內容時採用。
 * 必須在觸發請求之前呼叫，以排除先前的回應。
 */
function waitForServletResponse(
  page: Page,
  action: string,
  timeoutMs = LOGIN_RESULT_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
  const exchanges = pageContexts.get(page)?.exchanges;
  const since = exchanges?.mark() ?? 0;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown> | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("response", onResponse);
      resolve(value);
    };
    const onResponse = (response: HTTPResponse) => {
      if (!response.url().includes(FUBON_LOGIN_SERVLET_PATH)) return;
      const postData = response.request().postData() ?? "";
      const requestAction = new URLSearchParams(postData).get("action");
      if (requestAction !== action) return;
      void response
        .json()
        .then((body: unknown) => {
          if (body && typeof body === "object" && !Array.isArray(body))
            finish(body as Record<string, unknown>);
        })
        .catch(() => undefined);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    page.on("response", onResponse);
    if (exchanges) {
      void exchanges
        .waitFor(
          (exchange) =>
            exchange.path === FUBON_LOGIN_SERVLET_PATH &&
            exchange.action === action,
          since,
          timeoutMs,
        )
        .then((exchange) => {
          // 已收到回應但不是 JSON：不再等待，交由後續判斷。
          if (exchange) finish(exchange.json);
        });
    }
  });
}

/**
 * 登入後的框架結構（2026-10 實測）：登入成功先導向 `ContextFrame.faces?t=…`，
 * 其 `setToTopWindow` 隨即把頂層換成 `/B2C` → `/B2C/common/Index.faces`（frameset），
 * 由 `frame1` 載入 `ContextFrame.faces?fromIndex=true`，其內容頁框 `txnFrame` 再經
 * dispatcher 載入首頁 CGEQU001。因此 ContextFrame 通常不是頂層，必須在
 * `page.frames()` 中尋找（只依路徑，忽略查詢字串）。
 */
export type FubonFrameLike = {
  url(): string;
  name(): string;
  parentFrame(): FubonFrameLike | null;
  evaluate: Frame["evaluate"];
};
export type FubonPageLike = {
  url(): string;
  frames(): FubonFrameLike[];
  mainFrame(): FubonFrameLike;
};

const LOGGED_IN_CONTENT_PATHS: ReadonlySet<string> = new Set([
  HOME_PATH,
  ...Object.values(PAGES).map((target) => target.path),
]);

/** ContextFrame 框架（頂層或 Index.faces 的 frame1）；有多個時取最深（最新）的一個。 */
export function findFubonContextFrame(
  page: FubonPageLike,
): FubonFrameLike | undefined {
  const frames = page
    .frames()
    .filter((frame) => safePath(frame.url()) === CONTEXT_FRAME_PATH);
  if (frames.length === 0) return undefined;
  return frames
    .map((frame) => ({ frame, depth: frameDepth(frame) }))
    .sort((left, right) => right.depth - left.depth)[0]?.frame;
}

function frameDepth(frame: FubonFrameLike) {
  let depth = 0;
  for (let parent = frame.parentFrame(); parent; parent = parent.parentFrame())
    depth += 1;
  return depth;
}

/**
 * 已登入的網銀首頁：存在 ContextFrame，且（任一子框架已載入首頁或功能頁，或
 * ContextFrame 文件中 `loggedIn === true`，或已出現 dispatcher 選單連結）。
 * 0212 拒絕接管與 0213 也會導向 ContextFrame，但不會有上述訊號。
 */
export async function readFubonLoggedIn(page: FubonPageLike) {
  const context = findFubonContextFrame(page);
  if (!context) return false;
  const mainFrame = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === mainFrame) continue;
    if (LOGGED_IN_CONTENT_PATHS.has(safePath(frame.url()))) return true;
  }
  return context
    .evaluate(() => {
      const win = window as unknown as { loggedIn?: unknown };
      return (
        win.loggedIn === true ||
        Boolean(
          document.querySelector(
            "a[href*='/B2C/dispatcher?'][class*='taskId_'], a[href*='/B2C/dispatcher?'][class*='task_']",
          ),
        )
      );
    })
    .catch(() => false);
}

async function isLoggedInContextFrame(page: FubonPageLike, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await readFubonLoggedIn(page)) return true;
    if (Date.now() >= deadline) return false;
    await delay(POLL_MS);
  }
}

/**
 * 去識別化的框架診斷：只含路徑（不含查詢字串）、框架名稱、readyState 與
 * 關鍵全域變數是否存在（不含值）。
 */
export async function describeFubonFrames(page: FubonPageLike) {
  const frames = page.frames();
  const context = findFubonContextFrame(page);
  const described = await Promise.all(
    frames.map(async (frame) => {
      const parent = frame.parentFrame();
      const probe = await frame
        .evaluate(() => {
          const win = window as unknown as Record<string, unknown>;
          return {
            readyState: document.readyState,
            hasLoggedIn: "loggedIn" in win,
            loggedInTrue: win.loggedIn === true,
            hasDoLogout: typeof win.doLogout === "function",
            hasViewState: Boolean(
              document.querySelector("input[name='javax.faces.ViewState']"),
            ),
            menuLinks: document.querySelectorAll("a[href*='/B2C/dispatcher?']")
              .length,
            childFrames: document.querySelectorAll("iframe, frame").length,
          };
        })
        .catch((error: unknown) => ({
          evaluateError: error instanceof Error ? error.name : typeof error,
        }));
      return {
        name: frame.name() || undefined,
        path: safePath(frame.url()) || frame.url().split(":")[0],
        parentIndex: parent ? frames.indexOf(parent) : -1,
        isContextFrame: frame === context,
        ...probe,
      };
    }),
  );
  return { topPath: safePath(page.url()), frames: described };
}

export async function waitForFubonLoggedIn(
  page: Page | FubonPageLike,
  timeoutMs = LOGGED_IN_TIMEOUT_MS,
) {
  if (await isLoggedInContextFrame(page as FubonPageLike, timeoutMs)) {
    const state = pageContexts.get(page as Page)?.session;
    if (state) state.loggedIn = true;
    return;
  }
  logFubonEvent(
    "fubon_logged_in_timeout",
    await describeFubonFrames(page as FubonPageLike).catch((error) => ({
      describeError: error instanceof Error ? error.name : typeof error,
    })),
  );
  throw new FubonConnectionError("台北富邦登入後沒有在期限內載入網銀首頁。");
}

export type FubonLogoutPlan =
  | { kind: "skip"; reason: "login_not_sent" | "otp_pending" }
  /** 銀行已明確拒絕登入：只在頁面已是登入中的 ContextFrame 時登出，不另外開啟。 */
  | { kind: "in_place" }
  /** 可能已登入：一律嘗試官方登出（必要時重新開啟網銀框架）。 */
  | { kind: "full" };

const REJECTED_OUTCOMES = new Set<FubonLoginOutcome["kind"]>([
  "captcha",
  "credential",
  "locked",
  "duplicate",
  "session_timeout",
  "two_factor",
]);

export function fubonLogoutPlan(state: FubonSessionState): FubonLogoutPlan {
  if (state.otpPending) return { kind: "skip", reason: "otp_pending" };
  if (!state.loginRequested && !state.loggedIn)
    return { kind: "skip", reason: "login_not_sent" };
  if (
    !state.loggedIn &&
    !state.homeSeen &&
    state.lastOutcome &&
    REJECTED_OUTCOMES.has(state.lastOutcome)
  ) {
    return { kind: "in_place" };
  }
  return { kind: "full" };
}

export type FubonLogoutResult = {
  attempted: boolean;
  ok: boolean;
  reason: string;
};

/**
 * 執行同步工作，結束時（成功或任何錯誤）依登入狀態嘗試官方登出。
 * 登出為盡力而為：不會覆蓋原本的回傳值或錯誤。
 */
export async function runWithFubonLogout<T>(
  state: FubonSessionState,
  work: () => Promise<T>,
  logoutFn: () => Promise<FubonLogoutResult | undefined> | undefined,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<T> {
  try {
    return await work();
  } finally {
    const plan = fubonLogoutPlan(state);
    if (plan.kind === "skip") {
      if (plan.reason !== "login_not_sent") {
        logFubonEvent("fubon_logout", {
          attempted: false,
          ok: false,
          reason: plan.reason,
        });
      }
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve(logoutFn()),
          new Promise<FubonLogoutResult>((resolve) => {
            timer = setTimeout(
              () => resolve({ attempted: true, ok: false, reason: "timeout" }),
              timeoutMs,
            );
          }),
        ]);
        if (result) logFubonEvent("fubon_logout", { ...result });
      } catch (error) {
        logFubonEvent("fubon_logout", {
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

export type FubonLogoutPage = FubonPageLike & {
  on(event: "dialog", handler: (dialog: Dialog) => void): unknown;
  off(event: "dialog", handler: (dialog: Dialog) => void): unknown;
  goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded"; timeout?: number },
  ): Promise<{ status(): number } | null>;
};

/** ContextFrame 已可執行官方登出（doLogout 或 ViewState 已就緒）。 */
async function contextFrameReadyForLogout(frame: FubonFrameLike) {
  return frame
    .evaluate(() => {
      const win = window as unknown as { doLogout?: unknown };
      return (
        document.readyState !== "loading" &&
        (typeof win.doLogout === "function" ||
          Boolean(
            document.querySelector("input[name='javax.faces.ViewState']"),
          ))
      );
    })
    .catch(() => false);
}

async function waitForLogoutContextFrame(
  page: FubonPageLike,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const context = findFubonContextFrame(page);
    if (context && (await contextFrameReadyForLogout(context))) return context;
    if (Date.now() >= deadline) return context;
    await delay(POLL_MS);
  }
}

/**
 * 官方登出：ContextFrame 的 `doLogout()` 以同步 ajax 對 ContextFrame.faces 送出
 * `ajaxAction=doLogoutAction`（附 javax.faces.ViewState），再導向
 * `ContextFrame.faces?logout=true`。請求經代發層送出，以代發紀錄確認回應。
 * 登入回應為成功（或任何可能已登入的狀態）時一律嘗試，不依賴首頁就緒判斷：
 * 1. ContextFrame 的 doLogout；2. 以其 ViewState 直接 POST doLogoutAction；
 * 3. 找不到 ContextFrame 時重新開啟 /B2C/ 後重試 1–2；4. 仍不行時 GET 登出網址。
 */
export async function logoutFubon(
  page: FubonLogoutPage,
  state: FubonSessionState,
  exchanges: FubonExchangeLog | undefined = pageContexts.get(
    page as unknown as Page,
  )?.exchanges,
  timeoutMs = LOGOUT_TIMEOUT_MS,
): Promise<FubonLogoutResult> {
  const plan = fubonLogoutPlan(state);
  if (plan.kind === "skip") {
    return { attempted: false, ok: false, reason: plan.reason };
  }
  const deadline = Date.now() + timeoutMs - 1_000;
  const remaining = () => Math.max(500, deadline - Date.now());
  const onDialog = (dialog: Dialog) => {
    void dialog.accept().catch(() => undefined);
  };
  page.on("dialog", onDialog);
  try {
    if (plan.kind === "in_place") {
      // 銀行已拒絕登入：只在確實是登入中的 ContextFrame 時登出。
      if (!(await readFubonLoggedIn(page))) {
        return { attempted: false, ok: false, reason: "no_active_session" };
      }
    }
    let context = await waitForLogoutContextFrame(
      page,
      Math.min(5_000, remaining()),
    );
    let reopened = false;
    if (!context && plan.kind === "full") {
      // 流程中斷或頁面已離開網銀框架：重新開啟網銀（以 session cookie）找回 ContextFrame。
      reopened = true;
      await page
        .goto(`${ORIGIN}/B2C/`, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(NAVIGATION_TIMEOUT_MS, remaining()),
        })
        .catch(() => undefined);
      context = await waitForLogoutContextFrame(
        page,
        Math.min(8_000, remaining()),
      );
    }
    const suffix = reopened ? "_reopened" : "";
    let prior = context ? "" : "no_context_frame";
    if (context) {
      const since = exchanges?.mark() ?? 0;
      const method = await context
        .evaluate(
          (ajaxAction: string, contextPath: string) => {
            const win = window as unknown as {
              doLogout?: (flag?: unknown) => void;
            };
            if (typeof win.doLogout === "function") {
              setTimeout(() => win.doLogout?.(), 0);
              return "official";
            }
            // doLogout 不存在時，依官方 ajaxActionCall 的格式直接送出。
            const viewState =
              document.querySelector<HTMLInputElement>(
                "input[name='javax.faces.ViewState']",
              )?.value ?? "";
            const body = new URLSearchParams({
              ajaxAction,
              "javax.faces.ViewState": viewState,
            });
            void fetch(contextPath, {
              method: "POST",
              body,
              credentials: "same-origin",
            }).catch(() => undefined);
            return viewState ? "direct" : "direct_no_viewstate";
          },
          FUBON_LOGOUT_AJAX_ACTION,
          CONTEXT_FRAME_PATH,
        )
        .catch(() => "unavailable" as const);
      if (method !== "unavailable") {
        if (!exchanges) {
          return {
            attempted: true,
            ok: false,
            reason: `${method}${suffix}_unconfirmed`,
          };
        }
        const exchange = await exchanges.waitFor(
          (entry) => entry.action === FUBON_LOGOUT_AJAX_ACTION,
          since,
          Math.min(8_000, remaining()),
        );
        if (exchange) {
          const ok = exchange.status >= 200 && exchange.status < 300;
          if (ok) state.loggedIn = false;
          return {
            attempted: true,
            ok,
            reason: ok
              ? `${method}${suffix}`
              : `${method}${suffix}_status_${exchange.status}`,
          };
        }
        prior = `${method}${suffix}_no_response`;
        if (plan.kind === "in_place") {
          return { attempted: true, ok: false, reason: prior };
        }
      } else {
        prior = "page_unavailable";
        if (plan.kind === "in_place") {
          return { attempted: false, ok: false, reason: prior };
        }
      }
    } else if (plan.kind === "in_place") {
      return { attempted: false, ok: false, reason: "no_context_frame" };
    }
    // 最後手段：直接開啟官方登出後的網址（doLogout 最後導向的頁面）。
    const response = await page
      .goto(`${CONTEXT_FRAME_URL}?logout=true`, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(NAVIGATION_TIMEOUT_MS, remaining()),
      })
      .catch(() => null);
    const status = response?.status() ?? 0;
    const ok = status >= 200 && status < 400;
    if (ok) state.loggedIn = false;
    return {
      attempted: true,
      ok,
      reason: `${prior ? `${prior}+` : ""}logout_url${suffix}_status_${status}`,
    };
  } finally {
    page.off("dialog", onDialog);
  }
}

// ---------------------------------------------------------------------------
// 登入後資料擷取（在網銀 ContextFrame 的內容頁框中切換，不離開登入的頂層頁面；
// 頂層頁面 unload 時官方程式會自動登出）。
// ---------------------------------------------------------------------------

/** 會讓整次同步失敗、不可略過的錯誤：工作階段結束、瀏覽器斷線、需要使用者處理。 */
export function isFubonFatalFetchError(error: unknown) {
  if (
    error instanceof FubonSessionEndedError ||
    error instanceof FubonVerificationRequiredError ||
    error instanceof FubonBrowserCapacityError ||
    error instanceof BrowserRunCapacityError
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /Target closed|Session closed|Connection closed|WebSocket is not open|browser has disconnected|Browser closed|Navigating frame was detached/i.test(
    message,
  );
}

/** 連續這麼多項擷取失敗時，不再嘗試其餘頁面（多半是網銀或代發出口異常）。 */
export const FUBON_MAX_CONSECUTIVE_STEP_FAILURES = 3;

/**
 * 逐項擷取：單一帳戶／帳單／頁面失敗只略過該項並記入彙整；工作階段結束或瀏覽器斷線
 * 等致命錯誤仍向外拋出（之後一律嘗試登出）。連續失敗達上限時停止其餘項目。
 */
export class FubonStepRunner {
  private consecutiveFailures = 0;
  private halted = false;

  constructor(
    private readonly report: FubonSyncReport,
    private readonly checkSession: () => Promise<void>,
  ) {}

  async run<T>(
    category: FubonSyncCategory,
    stage: string,
    action: () => Promise<T>,
    count = 1,
  ): Promise<T | undefined> {
    if (this.halted) {
      this.report.fail(
        category,
        "skipped",
        new FubonConnectionError("前面連續多項擷取失敗，已略過此項。"),
        count,
      );
      return undefined;
    }
    try {
      const value = await action();
      this.consecutiveFailures = 0;
      return value;
    } catch (error) {
      if (isFubonFatalFetchError(error)) throw error;
      await this.checkSession();
      this.report.fail(category, stage, error, count);
      logFubonEvent("fubon_step_failed", {
        category,
        stage,
        ...describeFubonError(error),
      });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FUBON_MAX_CONSECUTIVE_STEP_FAILURES) {
        this.halted = true;
        logFubonEvent("fubon_steps_halted", {
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return undefined;
    }
  }
}

async function fetchFubonPayloads(
  page: Page,
  report: FubonSyncReport,
): Promise<FubonPayloads> {
  const steps = new FubonStepRunner(report, () => assertStillLoggedIn(page));
  const overview = await steps.run("twdDeposits", "fetch", async () => {
    const frame = await openContentPage(page, PAGES.depositOverview);
    const html = await frameHtml(frame);
    return { html, parsed: parseFubonDepositOverview(html) };
  });
  if (!overview) {
    // 總覽失敗時外幣存款同樣無法取得。
    report.fail(
      "foreignDeposits",
      "fetch",
      new FubonConnectionError("台北富邦存款總覽無法取得。"),
    );
  } else if (overview.parsed.skippedTypes.length > 0) {
    logFubonEvent("fubon_deposit_types_skipped", {
      count: overview.parsed.skippedTypes.length,
      types: [...new Set(overview.parsed.skippedTypes)].slice(0, 8),
    });
  }

  const depositTransactions: FubonPayloads["depositTransactions"] = [];
  const twdAccounts = (overview?.parsed.accounts ?? []).filter(
    (account) => account.currency === "TWD",
  );
  if (twdAccounts.length > 0) {
    const range = fubonTransactionRange(new Date());
    let frame: Frame | undefined;
    const selection = await steps.run(
      "twdTransactions",
      "open",
      async () => {
        frame = await openContentPage(page, PAGES.depositTransactions);
        const snapshot = await readFubonTransactionAccounts(frame);
        return selectFubonTransactionAccounts(twdAccounts, snapshot, {
          allowEmpty: true,
        });
      },
      twdAccounts.length,
    );
    for (const { account, option } of selection?.matched ?? []) {
      const fetched = await steps.run("twdTransactions", "fetch", async () => {
        frame ??= await openContentPage(page, PAGES.depositTransactions);
        try {
          const result = await queryAccountTransactions(
            page,
            frame,
            option,
            range,
          );
          frame = result.frame;
          return result.pages;
        } catch (error) {
          frame = undefined; // 下一個帳戶重新開啟頁面，不沿用狀態不明的頁框。
          throw error;
        }
      });
      if (fetched) {
        depositTransactions.push({
          accountNo: account.accountNo,
          currency: "TWD",
          pages: fetched,
        });
      }
    }
    // 選單（由選單進入的頁面）沒有列出的帳戶，改由存款總覽該帳戶列的「交易明細查詢」
    // 進入（官方頁面會預選該帳戶；2026-10 HAR 即由此路徑取得臺幣帳戶選項）。
    for (const account of selection?.missing ?? []) {
      const fetched = await steps.run(
        "twdTransactions",
        "fetch_via_overview",
        async () => {
          const entry = await openTransactionsFromOverview(page, account);
          const snapshot = await readFubonTransactionAccounts(entry);
          const matched = selectFubonTransactionAccounts([account], snapshot, {
            allowEmpty: true,
            logSkipped: false,
          }).matched[0];
          if (!matched) {
            throw new FubonProtocolError(
              "台北富邦交易明細帳號選單沒有此帳戶（由存款總覽進入）。",
            );
          }
          const result = await queryAccountTransactions(
            page,
            entry,
            matched.option,
            range,
          );
          frame = result.frame;
          return result.pages;
        },
      );
      if (fetched) {
        depositTransactions.push({
          accountNo: account.accountNo,
          currency: "TWD",
          pages: fetched,
        });
      }
    }
  }

  const statusHtml = await steps.run("cardStatus", "fetch", async () => {
    const frame = await openContentPage(page, PAGES.cardStatus);
    return frameHtml(frame);
  });
  if (statusHtml !== undefined) {
    // 只有能解析出明確無卡提示時才略過信用卡；解析失敗交由正規化階段記錄並繼續。
    let noCard = false;
    try {
      noCard = !parseFubonCardStatus(statusHtml).hasCreditCard;
    } catch {
      noCard = false;
    }
    if (noCard) {
      logFubonEvent("fubon_no_credit_card", {});
      return {
        depositOverviewHtml: overview?.html,
        depositTransactions,
        card: { hasCreditCard: false },
      };
    }
  }

  let billFrame: Frame | undefined;
  const billHtmls: string[] = [];
  for (const period of BILL_PERIODS) {
    const html = await steps.run("cardBills", "fetch", async () => {
      try {
        if (!billFrame) {
          // 新開啟的帳單頁顯示本期（period 1）。
          billFrame = await openContentPage(page, PAGES.cardBills);
          if (period !== "1") {
            billFrame = await changeBillPeriod(page, billFrame, period);
          }
        } else {
          billFrame = await changeBillPeriod(page, billFrame, period);
        }
        const current = await frameHtml(billFrame);
        if (fubonBillPeriodIndex(current) !== period) {
          throw new FubonProtocolError("台北富邦信用卡帳單期別切換結果不符。");
        }
        return current;
      } catch (error) {
        billFrame = undefined; // 下一期重新開啟帳單頁再切換。
        throw error;
      }
    });
    if (html !== undefined) billHtmls.push(html);
  }
  const unbilledHtml = await steps.run("cardUnbilled", "fetch", async () => {
    const frame = await openContentPage(page, PAGES.cardUnbilled);
    return frameHtml(frame);
  });
  return {
    depositOverviewHtml: overview?.html,
    depositTransactions,
    card: { hasCreditCard: true, statusHtml, billHtmls, unbilledHtml },
  };
}

/**
 * 單一帳戶的近三個月交易明細。完整期間以官方「近3個月」快速查詢送出（與 HAR 相同：
 * rdoFast + rdoDay90 + ajaxGetQueryDate 回填起迄日）；分段期間以自訂期間送出。
 * 每次查詢後核對回應頁回顯的起迄日；資料列可能被截斷時平分期間重查。
 */
async function queryAccountTransactions(
  page: Page,
  initialFrame: Frame,
  option: FubonTransactionAccountOption,
  range: { start: string; end: string },
) {
  let frame = initialFrame;
  const pages: string[] = [];
  const pending: { start: string; end: string; full: boolean }[] = [
    { ...range, full: true },
  ];
  let queries = 0;
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (exceedsFubonRangeLimit(current)) {
      // 網銀單次查詢不可超過六個月；先分割再查。
      const halves = splitFubonRange(current);
      if (!halves) throw new FubonProtocolError("台北富邦交易明細期間無效。");
      pending.unshift(...halves.map((half) => ({ ...half, full: false })));
      continue;
    }
    queries += 1;
    if (queries > MAX_TRANSACTION_QUERIES_PER_ACCOUNT) {
      throw new FubonConnectionError(
        "台北富邦交易明細筆數過多，分段查詢次數已達上限。",
      );
    }
    const requested = { start: current.start, end: current.end };
    const submitted = await queryDepositTransactions(
      page,
      frame,
      option.value,
      requested,
      current.full,
    );
    frame = submitted.frame;
    const html = await frameHtml(frame);
    const parsed = parseFubonDepositTransactionsPage(html);
    if (parsed.selectedAccount !== option.value) {
      throw new FubonProtocolError("台北富邦交易明細回應的帳號與查詢不符。");
    }
    assertFubonTransactionRange(requested, parsed, submitted.mode);
    if (isFubonTransactionPageTruncated(parsed)) {
      // 尚未取得超過一頁的真實回應；以分割期間重查取代翻頁，不依賴分頁控制項。
      const halves = splitFubonRange(requested);
      if (!halves) {
        throw new FubonConnectionError(
          "台北富邦單日交易明細超過一頁，無法確認資料完整。",
        );
      }
      pending.unshift(...halves.map((half) => ({ ...half, full: false })));
      continue;
    }
    pages.push(html);
  }
  return { frame, pages };
}

/**
 * 回應頁回顯的起迄日必須等於查詢期間；不符時記錄 `fubon_transaction_range_mismatch`
 * （只含日期）並使該帳戶步驟失敗，避免把較短期間（例如預設的當日）當成完整資料。
 */
export function assertFubonTransactionRange(
  requested: { start: string; end: string },
  echoed: { startDate?: string; endDate?: string },
  mode?: string,
) {
  if (echoed.startDate === requested.start && echoed.endDate === requested.end)
    return;
  const date = (value?: string) =>
    value && /^\d{4}\/\d{2}\/\d{2}$/.test(value)
      ? value
      : value
        ? "invalid"
        : "";
  logFubonEvent("fubon_transaction_range_mismatch", {
    requested,
    echoed: { start: date(echoed.startDate), end: date(echoed.endDate) },
    mode,
  });
  throw new FubonProtocolError("台北富邦交易明細回應的查詢期間與要求不符。");
}

/**
 * 在頁框內執行（必須自足，不引用外部變數）：於存款總覽表格找到帳號（去除前置零）與
 * 幣別相符的列，觸發該列的「交易明細查詢」連結。回傳結果代碼，不回傳任何帳號。
 */
export function clickFubonOverviewTransactionLink(
  target: string,
  labels: string[],
  click = true,
): "no_table" | "no_row" | "no_link" | "clicked" {
  const table = document.getElementById(
    "form1:resultGrid_DataGridBody",
  ) as HTMLTableElement | null;
  if (!table || !table.rows) return "no_table";
  const text = (node: Element | null | undefined) =>
    (node?.textContent ?? "").replace(/\s+/g, "");
  const header = Array.from(table.rows[0]?.cells ?? []).map((cell) =>
    text(cell),
  );
  const currencyIndex = header.findIndex((value) => value === "幣別");
  for (const row of Array.from(table.rows).slice(1)) {
    const digits = text(row.cells[0]).replace(/\D/g, "").replace(/^0+/, "");
    if (!digits || digits !== target) continue;
    const currencyText =
      currencyIndex >= 0 ? text(row.cells[currencyIndex]) : text(row);
    if (!labels.some((label) => currencyText.includes(label))) continue;
    const anchor = Array.from(row.querySelectorAll("a")).find(
      (item) =>
        /['"]CDSQU001['"]/.test(item.getAttribute("onclick") ?? "") ||
        /交易明細/.test(item.textContent ?? ""),
    );
    if (!anchor) return "no_link";
    if (click) setTimeout(() => anchor.click(), 0);
    return "clicked";
  }
  return "no_row";
}

const OVERVIEW_CURRENCY_LABELS: Record<string, readonly string[]> = {
  TWD: ["臺幣", "台幣", "新臺幣", "新台幣", "TWD"],
};

/**
 * 在存款總覽中找到該帳戶列，觸發該列「交易明細查詢」（官方 onclick 送出 form1，
 * 伺服器端轉到 CDSQU001 並預選此帳戶；頁框路徑仍為 CBOQU003）。
 */
async function openTransactionsFromOverview(
  page: Page,
  account: FubonDepositAccount,
): Promise<Frame> {
  const overview = await openContentPage(page, PAGES.depositOverview);
  await markFubonFramesStale(page);
  const result = await withActionTimeout(
    overview.evaluate(
      clickFubonOverviewTransactionLink,
      normalizeFubonAccountNo(account.accountNo),
      [...(OVERVIEW_CURRENCY_LABELS[account.currency] ?? [account.currency])],
    ),
  );
  logFubonEvent("fubon_transactions_via_overview", { result });
  if (result !== "clicked") {
    throw new FubonProtocolError(
      `台北富邦存款總覽沒有可用的交易明細查詢連結（${result}）。`,
    );
  }
  const frame = await waitForFubonContentFrame(
    page,
    [PAGES.depositOverview.path, PAGES.depositTransactions.path],
    {
      timeoutMs: PAGE_TIMEOUT_MS,
      markerGraceMs: PAGE_MARKER_GRACE_MS,
      marker: "transactionAccounts",
      requireMarker: true,
      onPoll: () => assertStillLoggedIn(page),
    },
  );
  await assertNotDenied(frame as Frame);
  return frame as Frame;
}

/**
 * 以官方選單的 dispatcher 連結（含當次 session 的 ParamValue）在 txnFrame 開啟功能頁；
 * 找不到連結時才直接載入頁面路徑。
 */
async function openContentPage(
  page: Page,
  target: FubonPageTarget,
): Promise<Frame> {
  const cached = pageContexts.get(page)?.menuHrefs.get(target.menuId);
  const href = cached ?? (await findMenuHref(page, target));
  const url = href ?? `${ORIGIN}${target.path}?menuId=${target.menuId}`;
  await markFubonFramesStale(page);
  await withActionTimeout(navigateContentFrame(page, url));
  return waitForContentFrame(page, target.path);
}

/**
 * 在 txnFrame 的父框架（ContextFrame）中改寫 txnFrame 的 src；找不到元素時
 * 直接讓 txnFrame 導向。
 */
async function navigateContentFrame(page: Page, url: string) {
  const content = page
    .frames()
    .find((frame) => frame.name() === CONTENT_FRAME_NAME);
  const host = content?.parentFrame() ?? findFubonContextFrame(page);
  if (!host) {
    throw new FubonProtocolError("台北富邦網銀首頁沒有找到內容頁框。");
  }
  const replaced = await (host as Frame).evaluate(
    (name: string, nextUrl: string) => {
      const element = document.querySelector<HTMLIFrameElement>(
        `iframe[name="${name}"], frame[name="${name}"], #${name}`,
      );
      if (!element) return false;
      element.src = nextUrl;
      return true;
    },
    CONTENT_FRAME_NAME,
    url,
  );
  if (replaced) return;
  if (!content) {
    throw new FubonProtocolError("台北富邦網銀首頁沒有找到內容頁框。");
  }
  await content
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

/**
 * 登入後 txnFrame 先載入首頁（CGEQU001），其選單含所有功能頁的 dispatcher 連結；
 * 切換到功能頁後首頁選單即消失，因此登入後先一次記下需要的連結。
 */
async function collectMenuHrefs(page: Page) {
  const context = pageContexts.get(page);
  if (!context) return;
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const home = page
      .frames()
      .find((frame) => safePath(frame.url()) === HOME_PATH);
    if (home) {
      const ready = await home
        .evaluate(() => document.readyState !== "loading")
        .catch(() => false);
      if (ready) break;
    }
    await delay(POLL_MS);
  }
  // 一次讀出所有目標的連結（每個框架一次 evaluate），不逐頁重複掃描。
  const found = await findMenuHrefs(page, Object.values(PAGES));
  for (const [menuId, href] of found) context.menuHrefs.set(menuId, href);
  // 只在官方選單缺少功能頁連結（改走直接路徑）時記錄。
  if (context.menuHrefs.size < Object.keys(PAGES).length) {
    logFubonEvent("fubon_menu_links", {
      found: context.menuHrefs.size,
      total: Object.keys(PAGES).length,
    });
  }
}

async function findMenuHref(page: Page, target: FubonPageTarget) {
  return (await findMenuHrefs(page, [target])).get(target.menuId);
}

/**
 * 在所有框架中找出各功能頁的 dispatcher 連結（內容頁框的首頁選單優先，其次
 * ContextFrame 頂層）。每個框架只 evaluate 一次；已找到的目標不再於後續框架查詢。
 */
async function findMenuHrefs(
  page: Page,
  targets: readonly FubonPageTarget[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const frames = [
    ...page.frames().filter((frame) => frame !== page.mainFrame()),
    page.mainFrame(),
  ];
  for (const frame of frames) {
    const remaining = targets.filter((target) => !result.has(target.menuId));
    if (remaining.length === 0) break;
    const hrefs = await frame
      .evaluate(
        (wanted: { menuId: string; taskId: string }[]) => {
          const anchors = Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              "a[href*='/B2C/dispatcher?']",
            ),
          );
          const found: Record<string, string> = {};
          for (const { menuId, taskId } of wanted) {
            const menuPattern = new RegExp(`[?&]menuId=${menuId}(?:&|$)`);
            const hasMenu = (anchor: HTMLAnchorElement) =>
              anchor.classList.contains(`menu_${menuId}`) ||
              anchor.classList.contains(`menuId_${menuId}`) ||
              menuPattern.test(anchor.getAttribute("href") ?? "");
            const hasTask = (anchor: HTMLAnchorElement) =>
              anchor.classList.contains(`task_${taskId}`) ||
              anchor.classList.contains(`taskId_${taskId}`);
            const anchor =
              anchors.find((item) => hasMenu(item) && hasTask(item)) ??
              anchors.find(
                (item) =>
                  hasMenu(item) &&
                  !Array.from(item.classList).some((name) =>
                    /^task(?:Id)?_/.test(name),
                  ),
              );
            if (anchor?.href) found[menuId] = anchor.href;
          }
          return found;
        },
        remaining.map(({ menuId, taskId }) => ({ menuId, taskId })),
      )
      .catch(() => ({}) as Record<string, string>);
    for (const [menuId, href] of Object.entries(hrefs)) {
      if (href.startsWith(`${ORIGIN}/B2C/dispatcher?`))
        result.set(menuId, href);
    }
  }
  return result;
}

async function waitForContentFrame(page: Page, path: string): Promise<Frame> {
  const frame = await waitForFubonContentFrame(page, path, {
    timeoutMs: PAGE_TIMEOUT_MS,
    markerGraceMs: PAGE_MARKER_GRACE_MS,
    onPoll: () => assertStillLoggedIn(page),
  });
  await assertNotDenied(frame as Frame);
  return frame as Frame;
}

/**
 * 功能頁的 `#deny` 提示（例如「我的存款」當日執行次數已超過上限而鎖定）顯示時停止同步。
 * 依官方頁面的 `#deny` 元素判斷；尚未取得提示實際顯示時的真實頁面。
 */
async function assertNotDenied(frame: Frame) {
  const denied = await frame
    .evaluate(() => {
      const element = document.getElementById("deny");
      if (!element) return "";
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return "";
      return element.innerText.replace(/\s+/g, " ").trim();
    })
    .catch(() => "");
  if (denied) {
    throw new FubonConnectionError(
      /執行次數已超過/.test(denied)
        ? "台北富邦回覆此查詢當日執行次數已超過上限，當日已被鎖定，請明日再同步或降低排程頻率。"
        : `台北富邦拒絕此查詢：${safeBankMessage(denied)}`,
    );
  }
}

async function assertStillLoggedIn(page: Page) {
  const context = findFubonContextFrame(page);
  const path = safePath(page.url());
  if (
    /logout|TimeoutError|PreLogin/i.test(path) ||
    (context && /[?&]logout=true(?:&|$)/.test(context.url()))
  ) {
    throw new FubonSessionEndedError();
  }
}

async function queryDepositTransactions(
  page: Page,
  frame: Frame,
  accountValue: string,
  range: { start: string; end: string },
  preferConvenient: boolean,
): Promise<{ frame: Frame; mode: FubonTransactionQueryMode }> {
  await markFubonFramesStale(page);
  const navigation = frame
    .waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  const result = await withActionTimeout(
    frame.evaluate(
      applyFubonTransactionQuery,
      accountValue,
      range.start,
      range.end,
      preferConvenient,
      true,
    ),
  );
  if (!result.ok) {
    logFubonEvent("fubon_transaction_query_rejected", {
      reason: result.reason,
      message: result.message,
      requested: range,
    });
    throw new FubonProtocolError(
      result.reason === "validate_failed"
        ? `台北富邦交易明細查詢條件未通過網頁檢核${result.message ? `：${result.message}` : ""}。`
        : "台北富邦交易明細查詢表單結構已變更。",
    );
  }
  await navigation;
  return {
    frame: await waitForContentFrame(page, PAGES.depositTransactions.path),
    mode: result.mode,
  };
}

export type FubonTransactionQueryMode = "convenient90" | "custom";

export type FubonTransactionQueryResult =
  | { ok: true; mode: FubonTransactionQueryMode }
  | {
      ok: false;
      reason: "no_form" | "no_account_option" | "validate_failed";
      message?: string;
    };

/**
 * 在交易明細頁框內執行（必須自足，不引用外部變數）：設定帳號、「交易明細」類別與查詢期間，
 * 呼叫官方檢核後送出。
 *
 * - `preferConvenient`：勾選「快速查詢」+「近3個月」（rdoFast、rdoDay90），呼叫官方
 *   `ajaxGetQueryDate()` 由伺服器回填起迄日（HAR 的做法）；回填結果與要求相同才採用。
 * - 否則（或回填不同）：與使用者點選日期欄相同，取消 `.queryTime` 勾選、勾選自訂期間
 *   （rdoCustom，rdoGroup21=2），再填入起迄日。快速期間 radio（rdoGroup3）維持頁面狀態。
 */
export function applyFubonTransactionQuery(
  value: string,
  start: string,
  end: string,
  preferConvenient: boolean,
  submitNow = true,
): FubonTransactionQueryResult {
  const byId = <T>(id: string) =>
    document.getElementById(id) as unknown as T | null;
  const win = window as unknown as {
    doValidateAndSubmitOnSubmit?: () => boolean;
    ajaxGetQueryDate?: () => void;
    validate?: () => boolean;
  };
  const select = byId<HTMLSelectElement>("form1:comboAccount");
  const startInput = byId<HTMLInputElement>("form1:startDate");
  const endInput = byId<HTMLInputElement>("form1:endDate");
  if (
    !select ||
    !startInput ||
    !endInput ||
    typeof win.doValidateAndSubmitOnSubmit !== "function"
  ) {
    return { ok: false, reason: "no_form" };
  }
  if (!Array.from(select.options).some((option) => option.value === value)) {
    return { ok: false, reason: "no_account_option" };
  }
  select.value = value;
  const txDetail = byId<HTMLInputElement>("form1:rdoTxDetail");
  if (txDetail) txDetail.checked = true;

  let mode: FubonTransactionQueryMode = "custom";
  const fast = byId<HTMLInputElement>("form1:rdoFast");
  const day90 = byId<HTMLInputElement>("form1:rdoDay90");
  if (
    preferConvenient &&
    fast &&
    day90 &&
    !day90.disabled &&
    typeof win.ajaxGetQueryDate === "function"
  ) {
    fast.checked = true;
    day90.checked = true;
    try {
      win.ajaxGetQueryDate();
    } catch {
      // 回填失敗時改用自訂期間。
    }
    if (startInput.value === start && endInput.value === end) {
      mode = "convenient90";
    }
  }
  if (mode === "custom") {
    document
      .querySelectorAll<HTMLInputElement>("input.queryTime[type='radio']")
      .forEach((radio) => (radio.checked = false));
    const custom = byId<HTMLInputElement>("form1:rdoCustom");
    if (custom) custom.checked = true;
    startInput.value = start;
    endInput.value = end;
  }
  const type = byId<HTMLInputElement>("form1:type");
  if (type) type.value = "btnType1";
  if (typeof win.validate === "function" && !win.validate()) {
    const message = (document.getElementById("dateMsgEnd")?.textContent ?? "")
      .replace(/\s+/g, " ")
      .replace(/\d/g, "#")
      .trim()
      .slice(0, 40);
    return {
      ok: false,
      reason: "validate_failed",
      message: message || undefined,
    };
  }
  if (submitNow) setTimeout(() => win.doValidateAndSubmitOnSubmit!(), 0);
  return { ok: true, mode };
}

async function changeBillPeriod(
  page: Page,
  frame: Frame,
  period: string,
): Promise<Frame> {
  await markFubonFramesStale(page);
  const navigation = frame
    .waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  const triggered = await withActionTimeout(
    frame.evaluate((value: string) => {
      const change = (
        window as unknown as { doChangePeriodAction?: (period: string) => void }
      ).doChangePeriodAction;
      if (typeof change !== "function") return false;
      setTimeout(() => change(value), 0);
      return true;
    }, period),
  );
  if (!triggered) {
    throw new FubonProtocolError("台北富邦信用卡帳單期別切換功能不存在。");
  }
  await navigation;
  return waitForContentFrame(page, PAGES.cardBills.path);
}

// 導向前在既有框架的 window 上標記，新文件不會帶有此標記；用來避免把導向前的
// 舊文件（或即將被取代的框架）誤認為新載入的功能頁。
const STALE_FLAG = "__allSetFubonStale";

async function markFubonFramesStale(page: FubonPageLike) {
  await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame() && !isFrameDetached(frame))
      .map((frame) =>
        frame
          .evaluate((flag: string) => {
            (window as unknown as Record<string, unknown>)[flag] = true;
          }, STALE_FLAG)
          .catch(() => undefined),
      ),
  );
}

function isFrameDetached(frame: FubonFrameLike) {
  const candidate = frame as FubonFrameLike & {
    detached?: boolean;
    isDetached?: () => boolean;
  };
  if (typeof candidate.detached === "boolean") return candidate.detached;
  return typeof candidate.isDetached === "function"
    ? candidate.isDetached()
    : false;
}

/**
 * 功能頁載入完成後應出現的內容。交易明細需有帳號選單：`comboAccountItems`
 * 腳本／window 變數，或已有選項的 `form1:comboAccount` select。
 */
const PAGE_MARKERS: Record<string, "transactionAccounts"> = {
  [PAGES.depositTransactions.path]: "transactionAccounts",
};

type FubonFrameReadiness = {
  ready: boolean;
  stale: boolean;
  marker: boolean;
};

/**
 * 每次輪詢都重新列出框架（不沿用舊的 frame handle），找出路徑為目標功能頁、
 * 未分離、非導向前舊文件、readyState complete 且有 form1 的框架；有多個時取最深者。
 * 若該頁有預期內容標記，等到標記出現；頁面已就緒但標記超過 markerGraceMs 仍未出現時
 * 仍回傳框架（記錄 fubon_page_marker_missing），由呼叫端診斷。
 */
export async function waitForFubonContentFrame(
  page: FubonPageLike,
  pathOrPaths: string | readonly string[],
  options: {
    timeoutMs: number;
    markerGraceMs: number;
    pollMs?: number;
    onPoll?: () => Promise<void>;
    /** 覆寫依路徑決定的內容標記（例如由總覽轉入、路徑仍為 CBOQU003 的明細頁）。 */
    marker?: "transactionAccounts";
    /** 為 true 時標記未出現不會在寬限期後回傳，直到逾時失敗。 */
    requireMarker?: boolean;
  },
): Promise<FubonFrameLike> {
  const paths = typeof pathOrPaths === "string" ? [pathOrPaths] : pathOrPaths;
  const path = paths[0] ?? "";
  const marker =
    options.marker ??
    paths.map((candidate) => PAGE_MARKERS[candidate]).find(Boolean);
  const deadline = Date.now() + options.timeoutMs;
  let readySince: number | undefined;
  for (;;) {
    const mainFrame = page.mainFrame();
    const candidates = page
      .frames()
      .filter(
        (frame) =>
          frame !== mainFrame &&
          !isFrameDetached(frame) &&
          paths.some((candidate) => safePath(frame.url()).endsWith(candidate)),
      )
      .sort((left, right) => frameDepth(right) - frameDepth(left));
    let readyFrame: FubonFrameLike | undefined;
    for (const frame of candidates) {
      const state = await frame
        .evaluate(
          (flag: string, markerKind: string | null) => {
            const win = window as unknown as Record<string, unknown>;
            const ready =
              document.readyState === "complete" &&
              Boolean(document.querySelector("form#form1, form[name='form1']"));
            let markerOk = true;
            if (ready && markerKind === "transactionAccounts") {
              // 先查 window 變數與 select，最後才掃描 script 文字（不序列化整份 HTML）。
              const items = win.comboAccountItems;
              markerOk =
                (Array.isArray(items) && items.length > 0) ||
                Array.from(document.querySelectorAll("select")).some(
                  (select) =>
                    /comboAccount/i.test(`${select.id} ${select.name}`) &&
                    select.options.length > 0,
                ) ||
                Array.from(document.scripts).some((script) =>
                  /comboAccount\w*Items\s*\[/i.test(script.text),
                );
            }
            return { ready, stale: win[flag] === true, marker: markerOk };
          },
          STALE_FLAG,
          marker ?? null,
        )
        .catch((): FubonFrameReadiness => ({
          ready: false,
          stale: false,
          marker: false,
        }));
      if (!state.ready || state.stale || isFrameDetached(frame)) continue;
      if (state.marker) return frame;
      readyFrame ??= frame;
    }
    if (readyFrame && !options.requireMarker) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= options.markerGraceMs) {
        logFubonEvent("fubon_page_marker_missing", {
          framePath: path.split("/").at(-1),
        });
        return readyFrame;
      }
    } else {
      readySince = undefined;
    }
    if (Date.now() >= deadline) {
      if (readyFrame && !options.requireMarker) return readyFrame;
      throw new FubonConnectionError(
        `台北富邦功能頁沒有在期限內載入（${path.split("/").at(-1)}）。`,
      );
    }
    await options.onPoll?.();
    await delay(options.pollMs ?? POLL_MS);
  }
}

export type FubonTransactionAccountsSnapshot = {
  framePath: string;
  html: string;
  /** `window.comboAccountItems[n][1]` */
  windowValues: string[];
  windowHasItems: boolean;
  /** 頁框中帳號選單 select 的即時 option 值 */
  liveOptionValues: string[];
  /** 帳號選單目前選取的值（只用於記錄形狀）。 */
  selectedValue?: string;
};

/** 在同一次 evaluate 中讀取交易明細頁的 HTML、window.comboAccountItems 與 select 選項。 */
async function readFubonTransactionAccounts(
  frame: Frame,
): Promise<FubonTransactionAccountsSnapshot> {
  const read = await withActionTimeout(
    frame.evaluate(() => {
      const win = window as unknown as { comboAccountItems?: unknown };
      const items = Array.isArray(win.comboAccountItems)
        ? (win.comboAccountItems as unknown[])
        : [];
      const windowValues = items.map((item) =>
        Array.isArray(item)
          ? String(item[1] ?? "")
          : typeof item === "string"
            ? item
            : "",
      );
      const liveOptionValues = Array.from(document.querySelectorAll("select"))
        .filter((select) => /comboAccount/i.test(`${select.id} ${select.name}`))
        .flatMap((select) =>
          Array.from(select.options).map((option) => option.value),
        );
      const select = document.getElementById(
        "form1:comboAccount",
      ) as HTMLSelectElement | null;
      return {
        html: document.documentElement.outerHTML,
        windowValues,
        windowHasItems: Array.isArray(win.comboAccountItems),
        liveOptionValues,
        selectedValue: select?.value || undefined,
      };
    }),
  );
  return { ...read, framePath: safePath(frame.url()) };
}

/**
 * 將總覽臺幣帳戶對應到交易明細的帳號選單並記錄去識別化診斷。選單中完全沒有可辨識的
 * 帳號時才失敗；個別帳戶不在選單中時略過該帳戶並記錄警告。
 */
export function selectFubonTransactionAccounts(
  twdAccounts: readonly FubonDepositAccount[],
  snapshot: FubonTransactionAccountsSnapshot,
  settings: { allowEmpty?: boolean; logSkipped?: boolean } = {},
) {
  const parsedOptions = parseFubonTransactionAccounts(snapshot.html, [
    ...snapshot.windowValues,
    ...snapshot.liveOptionValues,
  ]);
  const twdOptions = parsedOptions.filter(
    (option) => option.currency === "TWD",
  );
  const { matched, missing } = matchFubonTransactionAccounts(
    twdAccounts,
    twdOptions,
  );
  const described = describeFubonTransactionAccountsHtml(snapshot.html);
  const rawValues = [
    ...snapshot.windowValues,
    ...snapshot.liveOptionValues,
  ].filter((value) => value && !parseFubonComboAccountValue(value));
  const unique = <T>(values: T[]) => [...new Set(values)];
  // 去識別化診斷只在選單無法對應全部總覽臺幣帳戶時記錄，正常同步不輸出。
  if (matched.length < twdAccounts.length || parsedOptions.length === 0)
    logFubonEvent("fubon_transaction_accounts", {
      framePath: snapshot.framePath.split("/").at(-1) ?? "",
      hasComboScript: described.hasComboScript || snapshot.windowHasItems,
      hasComboSelect:
        described.hasComboSelect || snapshot.liveOptionValues.length > 0,
      optionCount: parsedOptions.length,
      twdOptionCount: twdOptions.length,
      overviewTwdCount: twdAccounts.length,
      matched: matched.length,
      optionDigitLengths: unique(
        parsedOptions.map((option) => option.accountNo.length),
      ),
      overviewDigitLengths: unique(
        twdAccounts.map((account) => account.accountNo.length),
      ),
      optionCurrencies: unique(
        parsedOptions.map((option) => option.currency),
      ).slice(0, 8),
      optionShapes: unique(
        parsedOptions.map((option) => fubonComboValueShape(option.value)),
      ).slice(0, 5),
      unparsedShapes: unique(rawValues.map(fubonComboValueShape)).slice(0, 5),
      windowItemCount: snapshot.windowValues.length,
      liveOptionCount: snapshot.liveOptionValues.length,
      // 缺少的臺幣帳戶是否以其他幣別出現在選單（同帳號多幣別）；只記筆數。
      missingWithOtherCurrencyOption: missing.filter((account) =>
        parsedOptions.some(
          (option) =>
            normalizeFubonAccountNo(option.accountNo) ===
            normalizeFubonAccountNo(account.accountNo),
        ),
      ).length,
      selectedShape: snapshot.selectedValue
        ? fubonComboValueShape(snapshot.selectedValue)
        : null,
    });
  if (parsedOptions.length === 0 && !settings.allowEmpty) {
    throw new FubonProtocolError(
      "台北富邦交易明細頁面沒有找到任何帳號選項，無法查詢交易明細。",
    );
  }
  if (settings.logSkipped !== false) {
    for (const account of missing) {
      logFubonEvent("fubon_transaction_account_skipped", {
        level: "warn",
        reason: "not_in_transaction_dropdown",
        currency: account.currency,
        typeName: account.typeName,
        overviewDigitLength: account.accountNo.length,
        fallback: "overview_quick_link",
      });
    }
  }
  return { matched, missing };
}

async function frameHtml(frame: Frame) {
  return withActionTimeout(
    frame.evaluate(() => document.documentElement.outerHTML),
  );
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
  missingMessage = "台北富邦驗證工作階段已結束，請重新取得驗證碼。",
) {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (!preferred) throw new FubonVerificationRequiredError(missingMessage);
    if (preferred.connectionId) {
      throw new FubonBrowserCapacityError(
        "台北富邦驗證工作階段正在使用中，請稍候再試。",
        3,
      );
    }
    try {
      return await connectBrowserWithCancellation(
        browserFetcher,
        preferred.sessionId,
      );
    } catch {
      throw new FubonBrowserCapacityError(
        "前一個台北富邦驗證工作階段尚未釋放，請稍候再試。",
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
  // 人工驗證碼登入後仍可能進入雙重驗證，保留足夠的閒置時間等待 OTP。
  return launchBrowserWithRetry(browserFetcher, {
    keep_alive: OTP_KEEP_ALIVE_MS,
  });
}

async function configurePage(
  page: Page,
  egress: FubonEgressFetch,
  stats: FubonEgressStats,
  session: FubonSessionState,
) {
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(USER_AGENT);
  // 官方檢核以瀏覽器本地日期判斷「起迄日不可晚於今日」；Browser Run 預設 UTC，
  // 台灣 00:00–08:00 同步時會把今日視為未來日期。固定為台灣時區。
  await page.emulateTimezone?.("Asia/Taipei").catch(() => undefined);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  // Browser Run 直連網銀會被重設連線；每次連線（含重新連線同一 session）都要重新開啟。
  const exchanges = new FubonExchangeLog();
  pageContexts.set(page, { exchanges, session, menuHrefs: new Map() });
  page.on("framenavigated", (frame) => {
    if (session.loginRequested && safePath(frame.url()) === HOME_PATH)
      session.homeSeen = true;
  });
  await enableFubonEgress(page, egress, stats, exchanges);
}

function logFubonSyncSummary(
  report: FubonSyncReport,
  phase: "finished" | "aborted",
) {
  logFubonEvent("fubon_sync_summary", { phase, ...report.summary() });
}

function logFubonEgressStats(stats: FubonEgressStats) {
  logFubonEvent("fubon_egress_stats", {
    proxied: stats.proxied,
    cached: stats.cached,
    egressCached: stats.egressCached,
    aborted: stats.aborted,
    failed: stats.failed,
    byType: stats.byType,
  });
}

async function closeFubonBrowser(browser: Browser, binding: Fetcher) {
  if (!(await closeBrowserSession(binding, browser))) {
    logFubonEvent("fubon_browser_cleanup_failed", {});
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
          () => reject(new FubonActionTimeoutError()),
          ACTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireCredentials(config: FubonConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new FubonVerificationRequiredError(
      "請填寫身分證字號、使用者代碼與使用者密碼。",
    );
  }
}

export function isValidCaptcha(value: string) {
  return new RegExp(`^\\d{${FUBON_CAPTCHA_DIGIT_COUNT}}$`).test(value);
}

function assertCaptcha(value: string) {
  if (!isValidCaptcha(value)) {
    throw new FubonCaptchaRejectedError(
      `台北富邦驗證碼必須是 ${FUBON_CAPTCHA_DIGIT_COUNT} 位數字。`,
    );
  }
}

function assertNotExpired(expiresAt: string | undefined, message: string) {
  if (!expiresAt || new Date(expiresAt) <= new Date()) {
    throw new FubonVerificationRequiredError(message);
  }
}

function mapFubonError(error: unknown): Error {
  if (
    error instanceof FubonVerificationRequiredError ||
    error instanceof FubonBrowserCapacityError ||
    error instanceof BrowserRunCapacityError ||
    error instanceof FubonConnectionError
  ) {
    return error;
  }
  if (error instanceof FubonProtocolError) {
    return new FubonConnectionError(error.message, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FubonConnectionError(
    `台北富邦連線失敗：${safeLogMessage(message)}`,
    error,
  );
}

function logFubonEvent(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ event, connectorId: "fubon", ...fields }));
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

/** 銀行提示文字只保留短句，並遮罩可能的帳號、手機或 Email。 */
function safeBankMessage(value: unknown) {
  if (typeof value !== "string") return "";
  return safeLogMessage(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/[\w.+-]+@[\w.-]+/g, (email) =>
        email.replace(/^(.).*@/, "$1***@"),
      ),
  ).slice(0, 120);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
