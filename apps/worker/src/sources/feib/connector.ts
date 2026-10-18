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
  FEIB_CAPTCHA_DIGIT_COUNT,
  FEIB_STATEMENT_MONTHS,
  FeibProtocolError,
  FeibSyncReport,
  classifyFeibLoginMessage,
  describeFeibError,
  feibStatementLabel,
  feibTransactionRange,
  normalizeFeibAccountNo,
  parseFeibCardStatus,
  parseFeibData,
  parseFeibDepositOverview,
  parseFeibStatementOptions,
  parseFeibTransactionAccountOptions,
  splitFeibRange,
  summarizeFeibResult,
  type FeibConfig,
  type FeibLoginOutcome,
  type FeibPayloads,
  type FeibSyncCategory,
  type FeibTransactionQuery,
} from "./protocol";

// 遠東商銀個人網路銀行（伺服器端 JSP，jQuery）。登入頁的帳密由頁面自己的
// TWCA E2EE（RSA）加密後送出，連接器只在真實頁面填入欄位並觸發官方送出流程，
// 不自行組裝登入請求。
const ORIGIN = "https://ebank.feib.com.tw";
const LOGIN_URL = `${ORIGIN}/netbank/html/pages/jsp/Logon/mainIndex6.jsp?loginpage=new`;
const DISPATCHER = `${ORIGIN}/netbank/servlet/TrxDispatcher`;
export const FEIB_URLS = {
  depositOverview: `${DISPATCHER}?trx=com.lb.wibc.trx.Login&state=loginAFT&lgstatus=saving&menu_id=2-1-1`,
  // TODO(feib-live): HAR 由帳戶總覽 POST（acctno）進入；選單 GET 另帶 default_acc_submit=1
  // 會自動查詢預設帳戶，此處刻意不帶，需確認 GET 只顯示查詢表單。
  depositTransactions: `${DISPATCHER}?trx=com.lb.wibc.trx.SavAcctTxDtlInq&state=prompt&menu_id=2-1-3`,
  cardStatus: `${DISPATCHER}?trx=com.lb.wibc.trx.CCMember&state=qCardAdj&menu_id=5-1-4`,
  cardStatements: `${DISPATCHER}?trx=com.lb.wibc.trx.CCMember&state=eStatementQry&menu_id=5-1-1`,
  /** 年度密碼變更提醒頁的「下次登入再變更」連結（官方頁面上的 href）。 */
  passwordChangeLater: `${DISPATCHER}?trx=com.lb.wibc.trx.Login&state=loginAFT&lgstatus=total&menu_id=1-1-1`,
  /** 官方 toLogout() 的導向網址。 */
  logout: `${DISPATCHER}?trx=com.lb.wibc.trx.Logout&state=verifyCard`,
} as const;
const PASSWORD_CHANGE_PATH = "/netbank/html/pages/jsp/SSLPwdChng/";
const LOGIN_SHELL_PATH = "/netbank/html/pages/indexNew.jsp";

export const FEIB_AUTO_LOGIN_ATTEMPTS = 3;
export const FEIB_CAPTCHA_OCR_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const AUTO_SYNC_KEEP_ALIVE_MS = 60_000;
const LOGIN_FORM_TIMEOUT_MS = 30_000;
const LOGIN_SUBMIT_TIMEOUT_MS = 20_000;
const LOGIN_RESULT_TIMEOUT_MS = 45_000;
/** 登入送出後停在非登入頁且頁面已完整載入，持續這麼久仍未出現登入標記即判定失敗。 */
const LOGIN_RESULT_SETTLE_MS = 3_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const POLL_MS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class FeibVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeibVerificationRequiredError";
  }
}

/** 身分證字號、使用者代號或密碼遭拒／帳號鎖定；不得重試，避免累積錯誤次數。 */
export class FeibCredentialRejectedError extends FeibVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FeibCredentialRejectedError";
  }
}

export class FeibCaptchaRejectedError extends FeibVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FeibCaptchaRejectedError";
  }
}

/** 自動辨識驗證碼連續失敗；sync.ts 轉為人工驗證碼流程。 */
export class FeibAutoCaptchaFailedError extends FeibVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "FeibAutoCaptchaFailedError";
  }
}

export class FeibConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FeibConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** 網銀工作階段已結束（被登出、逾時）；不可略過，整次同步失敗。 */
export class FeibSessionEndedError extends FeibConnectionError {
  constructor(message = "遠東商銀網銀工作階段已結束，請重新同步。") {
    super(message);
    this.name = "FeibSessionEndedError";
  }
}

export class FeibBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "FeibBrowserCapacityError";
  }
}

class FeibActionTimeoutError extends Error {
  constructor() {
    super("遠東商銀瀏覽器操作沒有在期限內回應。");
    this.name = "FeibActionTimeoutError";
  }
}

/** 一次同步中的登入狀態；登入請求送出後，任何結果都必須在關閉瀏覽器前嘗試官方登出。 */
export type FeibSessionState = {
  loginRequested: boolean;
  /** 本次同步實際送出的登入 POST 次數（含驗證碼錯誤後重送）。 */
  loginRequests: number;
  loggedIn: boolean;
};

export function createFeibSessionState(): FeibSessionState {
  return { loginRequested: false, loginRequests: 0, loggedIn: false };
}

type FeibPageContext = {
  session: FeibSessionState;
  /** 主框架完成導覽的次數；用來確認登入送出後頁面確實已換頁。 */
  mainFrameNavigations: number;
  /** 原生對話框訊息（只在記憶體內分類，不寫入 log）。 */
  dialogs: string[];
  dialogWaiters: Array<(message: string) => void>;
};
const pageContexts = new WeakMap<Page, FeibPageContext>();

type PreparedFeibCaptcha = {
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

export function createFeibConnector(
  browserFetcher: Fetcher | undefined,
  recognizeCaptcha: RecognizeCaptcha | undefined,
) {
  return {
    id: "feib" as const,
    async sync(
      config: FeibConfig,
      _cursor?: string,
    ): Promise<
      SyncResult<unknown> & { hasCreditCard?: boolean; syncWarning?: string }
    > {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new FeibConnectionError("Browser binding is unavailable.");
      }
      const manualCaptcha = Boolean(config.browserSessionId && config.captcha);
      if (manualCaptcha) {
        assertNotExpired(
          config.browserSessionExpiresAt,
          "遠東商銀圖形驗證碼已逾時，請重新取得驗證碼。",
        );
        assertCaptcha(config.captcha ?? "");
      } else if (!recognizeCaptcha) {
        throw new FeibVerificationRequiredError(
          "遠東商銀圖形驗證碼無法自動辨識，請改用人工輸入。",
        );
      }

      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      let report: FeibSyncReport | undefined;
      let summaryLogged = false;
      const session = createFeibSessionState();
      try {
        return await runWithFeibLogout(
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
              logFeibEvent("feib_login_result", {
                mode: "manual",
                outcome: outcome.kind,
              });
              await finishLogin(page, outcome);
            } else {
              const prepared = await prepareBrowserLoginWithRetry({
                binding: browserFetcher,
                connectorId: "feib",
                launchOptions: { keep_alive: AUTO_SYNC_KEEP_ALIVE_MS },
                isRetryable: (error) =>
                  error instanceof FeibActionTimeoutError ||
                  (error instanceof FeibConnectionError &&
                    /^遠東商銀登入頁沒有在期限內/.test(error.message)),
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

            report = new FeibSyncReport();
            reportSyncProgress("fetching");
            const payloads = await fetchFeibPayloads(page, report);
            const data = parseFeibData(payloads, new Date(), report);
            logFeibEvent("feib_sync_summary", {
              phase: "finished",
              ...report.summary(),
            });
            summaryLogged = true;
            if (report.failedCount > 0 && data.bankAccounts.length === 0) {
              throw new FeibConnectionError(
                `遠東商銀同步未取得任何資料。${report.userMessage() ?? ""}`,
              );
            }
            logFeibResult(summarizeFeibResult(data, report));
            return {
              records: [],
              ...data,
              syncWarning: report.userMessage(),
              cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
            };
          },
          () => (page ? logoutFeib(page) : undefined),
        );
      } catch (error) {
        throw mapFeibError(error);
      } finally {
        if (report && !summaryLogged)
          logFeibEvent("feib_sync_summary", {
            phase: "aborted",
            ...report.summary(),
          });
        if (browserInstance)
          await closeFeibBrowser(browserInstance, browserFetcher);
      }
    },
  };
}

export async function prepareFeibCaptcha(
  browserFetcher: Fetcher | undefined,
  config: FeibConfig | undefined,
): Promise<PreparedFeibCaptcha> {
  if (!config) {
    throw new FeibVerificationRequiredError(
      "請填寫身分證字號、使用者代號與密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new FeibConnectionError("Browser binding is unavailable.");
  }
  const browserInstance = await acquireBrowser(browserFetcher);
  let preserved = false;
  try {
    const page = await firstPage(browserInstance);
    await configurePage(page, createFeibSessionState());
    const captcha = await openLoginAndCaptureCaptcha(page);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: FEIB_CAPTCHA_DIGIT_COUNT,
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(captcha)}`,
    };
  } catch (error) {
    throw mapFeibError(error);
  } finally {
    if (!preserved) await closeFeibBrowser(browserInstance, browserFetcher);
  }
}

// ---------------------------------------------------------------------------
// 登入
// ---------------------------------------------------------------------------

async function loginWithOcr(
  page: Page,
  config: FeibConfig,
  recognizeCaptcha: RecognizeCaptcha,
  initialCaptcha: Uint8Array,
): Promise<FeibLoginOutcome> {
  const session = getSession(page);
  let captcha = initialCaptcha;
  for (let attempt = 1; attempt <= FEIB_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    const answer = await recognizeValidCaptcha(
      page,
      recognizeCaptcha,
      captcha,
      attempt,
    );
    if (!answer) {
      if (attempt < FEIB_AUTO_LOGIN_ATTEMPTS)
        captcha = await refreshCaptcha(page);
      continue;
    }
    const requestsBefore = session.loginRequests;
    const outcome = await submitLogin(page, config, answer);
    const submitted = session.loginRequests > requestsBefore;
    logFeibEvent("feib_login_result", {
      attempt,
      mode: "automatic",
      submitted,
      loginRequests: session.loginRequests,
      outcome: outcome.kind,
    });
    // 只有驗證碼錯誤可以重試；帳密錯誤、鎖定與結果不明會累計錯誤次數或狀態不明，不得重送。
    if (outcome.kind !== "captcha") return outcome;
    if (attempt < FEIB_AUTO_LOGIN_ATTEMPTS) {
      // 官方前端檢核已換圖（未送出登入）；網銀收到登入後才回覆驗證碼錯誤時重新載入登入頁。
      captcha = submitted
        ? await openLoginAndCaptureCaptcha(page)
        : await captureCaptcha(page);
    }
  }
  throw new FeibAutoCaptchaFailedError(
    `遠東商銀自動驗證連續失敗 ${FEIB_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

/**
 * 辨識結果不是 6 位數字時，在同一頁換一張驗證碼重新辨識（尚未送出帳密），
 * 最多 FEIB_CAPTCHA_OCR_ATTEMPTS 次；全部失敗回傳 undefined。
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
        FEIB_CAPTCHA_DIGIT_COUNT,
      );
    } catch (error) {
      errorName = error instanceof Error ? error.name : typeof error;
    }
    const valid = isValidCaptcha(answer);
    logFeibEvent("feib_captcha_ocr", {
      loginAttempt,
      ocrAttempt,
      ocrLength: answer.length,
      valid,
      errorName,
    });
    if (valid) return answer;
    if (ocrAttempt >= FEIB_CAPTCHA_OCR_ATTEMPTS) return undefined;
    captcha = await refreshCaptcha(page);
  }
}

async function finishLogin(page: Page, outcome: FeibLoginOutcome) {
  switch (outcome.kind) {
    case "success":
      getSession(page).loggedIn = true;
      return;
    case "password_change_prompt":
      getSession(page).loggedIn = true;
      await skipPasswordChangePrompt(page);
      return;
    case "captcha":
      throw new FeibCaptchaRejectedError(
        "遠東商銀圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    case "credential":
      throw new FeibCredentialRejectedError(
        "遠東商銀拒絕登入：身分證字號、使用者代號或密碼錯誤。為避免連續錯誤三次遭停用，已停止同步，請確認帳密後再試。",
      );
    case "locked":
      throw new FeibCredentialRejectedError(
        "遠東商銀網路銀行暫時無法登入（帳號可能已停用或鎖定），請至官方網銀或洽客服確認帳號狀態。",
      );
    case "duplicate":
      throw new FeibVerificationRequiredError(
        "遠東商銀回覆已有其他登入中的網銀工作階段，為避免中斷其他裝置，已停止同步。請先登出其他裝置或稍後再試。",
      );
    case "maintenance":
      throw new FeibConnectionError(
        "遠東商銀網路銀行維護中或忙碌，請稍後再試。",
      );
    default:
      throw new FeibConnectionError(
        "遠東商銀登入結果不明，為避免重複送出帳密，已停止同步。",
      );
  }
}

/**
 * 年度密碼變更提醒（SSLPwdChng）。只走官方頁面上的「下次登入再變更」連結；
 * 絕不變更密碼，也不使用「不變更」（state=fix，會改變使用者的提醒設定）。
 */
async function skipPasswordChangePrompt(page: Page) {
  const href = await withActionTimeout(
    page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a"));
      const later = links.find(
        (link) =>
          (link.textContent ?? "").replace(/\s+/g, "") === "下次登入再變更",
      );
      return later?.getAttribute("href") ?? "";
    }),
  ).catch(() => "");
  const expected = new URL(FEIB_URLS.passwordChangeLater);
  let target: URL | undefined;
  try {
    target = new URL(href, ORIGIN);
  } catch {
    target = undefined;
  }
  const matches =
    target !== undefined &&
    target.origin === expected.origin &&
    target.pathname === expected.pathname &&
    target.searchParams.get("trx") === "com.lb.wibc.trx.Login" &&
    target.searchParams.get("state") === "loginAFT";
  logFeibEvent("feib_password_change_prompt", {
    level: "warn",
    action: "remind_next_login",
    linkFound: Boolean(href),
    linkMatched: matches,
  });
  // 連結不符預期時仍使用相同的官方網址（純導覽、不送出表單），不點擊其他按鈕。
  const html = await navigate(page, FEIB_URLS.passwordChangeLater);
  if (isPasswordChangePage(page.url()) || !hasLogoutLink(html)) {
    throw new FeibVerificationRequiredError(
      "遠東商銀要求變更網銀密碼，無法略過提醒。請至官方網銀處理後再同步。",
    );
  }
}

async function openLoginAndCaptureCaptcha(
  page: Page,
  reportStage?: ReportBrowserLoginStage,
) {
  reportStage?.("navigate");
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  reportStage?.("form");
  try {
    await page.waitForFunction(
      () =>
        Boolean(
          document.querySelector("#cid0") &&
          document.querySelector("#uid0") &&
          document.querySelector("#pad0") &&
          document.querySelector("#VERCODE0") &&
          document.querySelector("#submitbtn") &&
          document.querySelector('#vercode0area img[data-role="vercode"]'),
        ),
      { timeout: LOGIN_FORM_TIMEOUT_MS },
    );
  } catch {
    throw new FeibConnectionError("遠東商銀登入頁沒有在期限內載入登入表單。");
  }
  reportStage?.("captcha");
  return captureCaptcha(page);
}

const CAPTCHA_SELECTOR = '#vercode0area img[data-role="vercode"]';

async function captureCaptcha(page: Page): Promise<Uint8Array> {
  try {
    await page.waitForFunction(
      (selector: string) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return Boolean(
          image &&
          /VerifyCodeServlet/.test(image.getAttribute("src") ?? "") &&
          image.complete &&
          image.naturalWidth > 0,
        );
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      CAPTCHA_SELECTOR,
    );
  } catch {
    throw new FeibConnectionError("遠東商銀登入頁沒有在期限內顯示驗證碼。");
  }
  const image = await page.$(CAPTCHA_SELECTOR);
  if (!image) {
    throw new FeibConnectionError("遠東商銀登入頁沒有在期限內顯示驗證碼。");
  }
  const screenshot = await withActionTimeout(
    image.screenshot({ type: "jpeg", quality: 90 }),
  );
  return typeof screenshot === "string"
    ? Uint8Array.from(atob(screenshot), (char) => char.charCodeAt(0))
    : new Uint8Array(screenshot);
}

async function currentCaptchaSource(page: Page) {
  return withActionTimeout(
    page.evaluate(
      (selector: string) =>
        document.querySelector(selector)?.getAttribute("src") ?? "",
      CAPTCHA_SELECTOR,
    ),
  );
}

/** 以官方「換一張」按鈕（resetPic）在同一頁換驗證碼，不重新載入登入頁。 */
async function refreshCaptcha(page: Page): Promise<Uint8Array> {
  const previous = await currentCaptchaSource(page);
  await withActionTimeout(
    page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>(
          '#vercode0area button[data-action="resetcode"]',
        )
        ?.click();
    }),
  );
  return waitForCaptchaChange(page, previous);
}

async function waitForCaptchaChange(page: Page, previous: string) {
  try {
    await page.waitForFunction(
      (selector: string, oldSource: string) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        return Boolean(
          image &&
          image.getAttribute("src") !== oldSource &&
          image.complete &&
          image.naturalWidth > 0,
        );
      },
      { timeout: LOGIN_FORM_TIMEOUT_MS },
      CAPTCHA_SELECTOR,
      previous,
    );
  } catch {
    throw new FeibConnectionError("遠東商銀登入頁沒有在期限內更新驗證碼。");
  }
  return captureCaptcha(page);
}

/** 個人戶頁籤（index 0）的欄位：#cid0 身分證字號、#uid0 使用者代號、#pad0 密碼、#VERCODE0 驗證碼。 */
async function fillLoginForm(page: Page, config: FeibConfig, captcha: string) {
  const filled = await withActionTimeout(
    page.evaluate(
      (userId: string, account: string, password: string, code: string) => {
        const byId = (id: string) =>
          document.querySelector<HTMLInputElement>(`#${id}`);
        const id = byId("cid0");
        const user = byId("uid0");
        const pass = byId("pad0");
        const vercode = byId("VERCODE0");
        // 官方以 name 屬性決定送出的欄位；個人戶頁籤啟用時三個欄位才有 name。
        if (
          !id ||
          !user ||
          !pass ||
          !vercode ||
          id.getAttribute("name") !== "CUSTID" ||
          user.getAttribute("name") !== "USERID" ||
          pass.getAttribute("name") !== "LGNPWD"
        ) {
          return false;
        }
        const assign = (input: HTMLInputElement, value: string) => {
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        assign(id, userId.toUpperCase());
        assign(user, account);
        assign(pass, password);
        assign(vercode, code);
        return true;
      },
      config.userId ?? "",
      config.account ?? "",
      config.password ?? "",
      captcha,
    ),
  );
  if (!filled) {
    throw new FeibConnectionError("遠東商銀登入表單結構已變更。");
  }
}

/** 頁面內 `<select>`（Worker 型別的 HTMLSelectElement 與 DOM lib 不相容，只宣告用到的欄位）。 */
type SelectLike = Element & {
  value: string;
  options: ArrayLike<{ value: string }>;
};

type SubmitProbe = {
  errorAreas: string[];
  buttonDisabled: boolean;
};

/**
 * 觸發官方 submitForm：先以 ajax 檢核驗證碼（verifyCode，不送帳密），驗證碼錯誤時
 * 標示 `#vercode0area.inp-error` 並換圖，不會送出登入；其他欄位格式錯誤同樣不送出。
 * 只有全部通過才由頁面 E2EE 加密後 POST 登入（以請求監聽確認是否已送出）。
 */
async function submitLogin(
  page: Page,
  config: FeibConfig,
  captcha: string,
): Promise<FeibLoginOutcome> {
  const context = getContext(page);
  context.dialogs.length = 0;
  const requestsBefore = context.session.loginRequests;
  const submitted = () => context.session.loginRequests > requestsBefore;
  await fillLoginForm(page, config, captcha);
  const previousCaptcha = await currentCaptchaSource(page).catch(() => "");
  const navigationsBefore = context.mainFrameNavigations;
  await withActionTimeout(
    page.evaluate(() => {
      const win = window as unknown as { __feibSubmitDone?: boolean };
      win.__feibSubmitDone = false;
      // 清除上一輪的錯誤標示，避免在本次檢核完成前誤判；官方 verifyInput 會重新標示。
      for (const item of Array.from(document.querySelectorAll(".inp-error"))) {
        item.classList.remove("inp-error");
      }
      // 以 setTimeout 讓 evaluate 先回傳；送出後的導覽不會中斷本次呼叫。
      setTimeout(() => {
        document.querySelector<HTMLInputElement>("#submitbtn")?.click();
        // 官方 click handler（含同步 ajax 驗證碼檢核）結束後才標記完成。
        win.__feibSubmitDone = true;
      }, 0);
    }),
  );
  const deadline = Date.now() + LOGIN_SUBMIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (submitted()) break;
    const probe = await page
      .evaluate((): SubmitProbe => {
        const done = Boolean(
          (window as unknown as { __feibSubmitDone?: boolean })
            .__feibSubmitDone,
        );
        const areas = Array.from(document.querySelectorAll(".inp-error"))
          .map((element) => element.id)
          .filter(Boolean);
        const button = document.querySelector<HTMLInputElement>("#submitbtn");
        return {
          errorAreas: done ? areas : [],
          buttonDisabled: !done || Boolean(button?.disabled),
        };
      })
      .catch(() => undefined);
    if (submitted()) break;
    if (probe && probe.errorAreas.length > 0 && !probe.buttonDisabled) {
      const onlyCaptcha = probe.errorAreas.every((id) => id === "vercode0area");
      logFeibEvent("feib_login_precheck_rejected", {
        captcha: probe.errorAreas.includes("vercode0area"),
        otherFields: probe.errorAreas.filter((id) => id !== "vercode0area")
          .length,
      });
      if (!onlyCaptcha) {
        throw new FeibVerificationRequiredError(
          "遠東商銀登入頁檢核未通過（身分證字號、使用者代號或密碼格式不符），未送出登入。請確認設定。",
        );
      }
      // 官方已呼叫 resetPic；等待新圖載入後再交由呼叫端重試。
      await waitForCaptchaChange(page, previousCaptcha).catch(() => undefined);
      return { kind: "captcha" };
    }
    await delay(POLL_MS);
  }
  if (!submitted()) {
    throw new FeibConnectionError(
      "遠東商銀登入頁沒有在期限內送出登入，請稍後再試。",
    );
  }
  return waitForLoginResult(page, navigationsBefore);
}

async function waitForLoginResult(
  page: Page,
  navigationsBefore: number,
): Promise<FeibLoginOutcome> {
  const context = getContext(page);
  const deadline = Date.now() + LOGIN_RESULT_TIMEOUT_MS;
  let settledSince: number | undefined;
  while (Date.now() < deadline) {
    const url = page.url();
    if (context.mainFrameNavigations === navigationsBefore) {
      // 登入 POST 已送出但尚未換頁：仍是舊的登入頁，不可當成結果。
      settledSince = undefined;
    } else if (isPasswordChangePage(url)) {
      const ready = await pageReadyWithLogout(page);
      if (ready) return { kind: "password_change_prompt" };
    } else if (safePath(url) !== LOGIN_SHELL_PATH) {
      const state = await page
        .evaluate(() => ({
          ready: document.readyState === "complete",
          loggedIn: Boolean(
            document.querySelector('a[href*="com.lb.wibc.trx.Logout"]'),
          ),
          text: [
            ...Array.from(document.querySelectorAll(".inp-error-txt")).map(
              (element) => element.textContent ?? "",
            ),
            (document.body?.innerText ?? "").slice(0, 4_000),
          ].join("\n"),
        }))
        .catch(() => undefined);
      if (state?.loggedIn) return { kind: "success" };
      if (state?.ready) {
        settledSince ??= Date.now();
        if (Date.now() - settledSince >= LOGIN_RESULT_SETTLE_MS) {
          // 先看原生對話框訊息，再看頁面文字；文字只在記憶體內分類。
          const fromDialog = classifyFeibLoginMessage(
            context.dialogs.join("\n"),
          );
          const outcome =
            fromDialog.kind !== "unknown"
              ? fromDialog
              : classifyFeibLoginMessage(state.text);
          logFeibEvent("feib_login_failed_page", {
            path: safePath(url),
            dialogCount: context.dialogs.length,
            outcome: outcome.kind,
          });
          return outcome;
        }
      } else {
        settledSince = undefined;
      }
    } else {
      settledSince = undefined;
    }
    await delay(POLL_MS);
  }
  logFeibEvent("feib_login_failed_page", {
    path: safePath(page.url()),
    dialogCount: context.dialogs.length,
    outcome: "timeout",
  });
  return { kind: "unknown" };
}

async function pageReadyWithLogout(page: Page) {
  return page
    .evaluate(
      () =>
        document.readyState !== "loading" &&
        Boolean(document.querySelector('a[href*="com.lb.wibc.trx.Logout"]')),
    )
    .catch(() => false);
}

function isPasswordChangePage(url: string) {
  return safePath(url).startsWith(PASSWORD_CHANGE_PATH);
}

// ---------------------------------------------------------------------------
// 登出
// ---------------------------------------------------------------------------

export type FeibLogoutResult = {
  attempted: boolean;
  ok: boolean;
  reason: string;
};

/**
 * 執行同步工作，結束時（成功或任何錯誤）只要曾送出登入請求，就嘗試官方登出。
 * 登出為盡力而為：不會覆蓋原本的回傳值或錯誤。
 */
export async function runWithFeibLogout<T>(
  state: FeibSessionState,
  work: () => Promise<T>,
  logoutFn: () => Promise<FeibLogoutResult | undefined> | undefined,
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
          new Promise<FeibLogoutResult>((resolve) => {
            timer = setTimeout(
              () => resolve({ attempted: true, ok: false, reason: "timeout" }),
              timeoutMs,
            );
          }),
        ]);
        if (result) logFeibEvent("feib_logout", { ...result });
      } catch (error) {
        logFeibEvent("feib_logout", {
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

async function logoutFeib(page: Page): Promise<FeibLogoutResult> {
  try {
    const response = await page.goto(FEIB_URLS.logout, {
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
// 登入後資料擷取（頂層頁面依序導覽；所有頁面皆為唯讀查詢）
// ---------------------------------------------------------------------------

/** 會讓整次同步失敗、不可略過的錯誤：工作階段結束、瀏覽器斷線、需要使用者處理。 */
export function isFeibFatalFetchError(error: unknown) {
  if (
    error instanceof FeibSessionEndedError ||
    error instanceof FeibVerificationRequiredError ||
    error instanceof FeibBrowserCapacityError ||
    error instanceof BrowserRunCapacityError
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /Target closed|Session closed|Connection closed|WebSocket is not open|browser has disconnected|Browser closed/i.test(
    message,
  );
}

export const FEIB_MAX_CONSECUTIVE_STEP_FAILURES = 3;

/**
 * 逐項擷取：單一帳戶／期間／帳單失敗只略過該項並記入彙整；工作階段結束或瀏覽器斷線
 * 等致命錯誤仍向外拋出（之後一律嘗試登出）。連續失敗達上限時停止其餘項目。
 */
export class FeibStepRunner {
  private consecutiveFailures = 0;
  private halted = false;

  constructor(
    private readonly report: FeibSyncReport,
    private readonly checkSession: () => Promise<void>,
  ) {}

  async run<T>(
    category: FeibSyncCategory,
    stage: string,
    action: () => Promise<T>,
    count = 1,
  ): Promise<T | undefined> {
    if (this.halted) {
      this.report.fail(
        category,
        "skipped",
        new FeibConnectionError("前面連續多項擷取失敗，已略過此項。"),
        count,
      );
      return undefined;
    }
    try {
      const value = await action();
      this.consecutiveFailures = 0;
      return value;
    } catch (error) {
      if (isFeibFatalFetchError(error)) throw error;
      await this.checkSession();
      this.report.fail(category, stage, error, count);
      logFeibEvent("feib_step_failed", {
        category,
        stage,
        ...describeFeibError(error),
      });
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FEIB_MAX_CONSECUTIVE_STEP_FAILURES) {
        this.halted = true;
        logFeibEvent("feib_steps_halted", {
          consecutiveFailures: this.consecutiveFailures,
        });
      }
      return undefined;
    }
  }
}

async function fetchFeibPayloads(
  page: Page,
  report: FeibSyncReport,
): Promise<FeibPayloads> {
  const steps = new FeibStepRunner(report, () => assertStillLoggedIn(page));
  const overview = await steps.run("deposits", "fetch", async () => {
    const html = await navigate(page, FEIB_URLS.depositOverview);
    return { html, parsed: parseFeibDepositOverview(html) };
  });
  if (overview && overview.parsed.timeDepositRows > 0) {
    // TODO(feib-live): 定期性存款（往來單位）尚未接入。
    logFeibEvent("feib_time_deposits_skipped", {
      count: overview.parsed.timeDepositRows,
    });
  }

  const depositTransactions: FeibPayloads["depositTransactions"] = [];
  // 只查新臺幣活存明細（幣別代碼 00）。TODO(feib-live): 外幣活存明細（其他 ccycd）尚未驗證。
  const twdAccounts = (overview?.parsed.accounts ?? []).filter(
    (account) =>
      account.currency === "TWD" && (account.currencyCode ?? "00") === "00",
  );
  const foreign = (overview?.parsed.accounts ?? []).length - twdAccounts.length;
  if (foreign > 0) {
    logFeibEvent("feib_foreign_transactions_skipped", { accounts: foreign });
  }
  if (twdAccounts.length > 0) {
    const chunks = splitFeibRange(feibTransactionRange(new Date()));
    let options: string[] | undefined;
    for (const account of twdAccounts) {
      const pages: FeibPayloads["depositTransactions"][number]["pages"] = [];
      for (const chunk of chunks) {
        const query: FeibTransactionQuery = {
          accountNo: account.accountNo,
          start: chunk.start,
          end: chunk.end,
        };
        const html = await steps.run(
          "depositTransactions",
          "fetch",
          async () => {
            if (!options) {
              const prompt = await navigate(
                page,
                FEIB_URLS.depositTransactions,
              );
              options = parseFeibTransactionAccountOptions(prompt);
            }
            if (!options.includes(normalizeFeibAccountNo(account.accountNo))) {
              throw new FeibProtocolError(
                "遠東商銀交易明細帳號選單沒有此帳戶。",
              );
            }
            try {
              return await queryDepositTransactions(page, query);
            } catch (error) {
              options = undefined; // 下一段重新開啟查詢頁，不沿用狀態不明的頁面。
              throw error;
            }
          },
        );
        if (html !== undefined) pages.push({ html, query });
      }
      if (pages.length > 0) {
        depositTransactions.push({
          accountNo: account.accountNo,
          currency: account.currency,
          pages,
        });
      }
    }
  }

  const statusHtml = await steps.run("cardStatus", "fetch", () =>
    navigate(page, FEIB_URLS.cardStatus),
  );
  if (statusHtml !== undefined) {
    let noCard = false;
    try {
      noCard = !parseFeibCardStatus(statusHtml).hasCreditCard;
    } catch {
      noCard = false;
    }
    if (noCard) {
      logFeibEvent("feib_no_credit_card", {});
      return {
        depositOverviewHtml: overview?.html,
        depositTransactions,
        card: { hasCreditCard: false },
      };
    }
  }

  const statementHtmls: string[] = [];
  const firstStatement = await steps.run("cardBills", "fetch", () =>
    navigate(page, FEIB_URLS.cardStatements),
  );
  if (firstStatement !== undefined) {
    statementHtmls.push(firstStatement);
    const options = parseFeibStatementOptions(firstStatement);
    const selected = options.find((option) => option.selected) ?? options[0];
    // 選單由新到舊；本期已在首頁顯示，再依序查詢較早的期別。
    const remaining = options
      .filter((option) => option !== selected)
      .slice(0, Math.max(0, FEIB_STATEMENT_MONTHS - 1));
    for (const option of remaining) {
      const html = await steps.run("cardBills", "fetch", () =>
        queryStatement(page, option.value, option.label),
      );
      if (html !== undefined) statementHtmls.push(html);
    }
  }
  return {
    depositOverviewHtml: overview?.html,
    depositTransactions,
    card: { hasCreditCard: true, statusHtml, statementHtmls },
  };
}

/**
 * 在交易明細查詢頁填入帳號、幣別（00）與起迄日，呼叫官方 checkData('A') 送出。
 * 官方前端檢核未通過時會以 alert 提示且不送出；此時視為該段查詢失敗。
 */
async function queryDepositTransactions(
  page: Page,
  query: FeibTransactionQuery,
): Promise<string> {
  const ready = await withActionTimeout(
    page.evaluate(
      (account: string, start: string, end: string) => {
        const select = document.querySelector("#acct") as SelectLike | null;
        const startInput = document.querySelector<HTMLInputElement>(
          'input[name="sdate"]',
        );
        const endInput = document.querySelector<HTMLInputElement>(
          'input[name="edate"]',
        );
        const check = document.querySelector<HTMLInputElement>(
          '#inqForm input[name="check"]',
        );
        const win = window as unknown as {
          checkData?: (args: string) => void;
          jQuery?: (selector: unknown) => { change: () => void };
        };
        if (!select || !startInput || !endInput || !check) return false;
        if (typeof win.checkData !== "function") return false;
        const option = Array.from(select.options).find(
          (item: { value: string }) =>
            item.value.replace(/\D/g, "") === account,
        );
        if (!option) return false;
        select.value = option.value;
        // 官方 change handler 依帳號重建幣別選單。
        if (win.jQuery) win.jQuery(select).change();
        else select.dispatchEvent(new Event("change", { bubbles: true }));
        const currency = document.querySelector("#ccycd") as SelectLike | null;
        if (currency) currency.value = "00";
        startInput.value = start;
        endInput.value = end;
        check.value = "false";
        return true;
      },
      normalizeFeibAccountNo(query.accountNo),
      query.start,
      query.end,
    ),
  );
  if (!ready) {
    throw new FeibProtocolError("遠東商銀交易明細查詢表單結構已變更。");
  }
  return submitAndCapture(page, "deposit_transactions");
}

/**
 * 帳單明細：選擇帳單年月後只送出 mainForm 的查詢（state=eStatementQry）。
 * 不呼叫 formSubmit，避免誤觸「立刻繳款」分支。
 */
async function queryStatement(page: Page, value: string, label: string) {
  const ready = await withActionTimeout(
    page.evaluate((month: string) => {
      const form = document.forms.namedItem("mainForm");
      const select = document.querySelector("#yyyyMm") as SelectLike | null;
      if (!form || !select) return false;
      const field = (name: string) =>
        form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (
        field("trx")?.value !== "com.lb.wibc.trx.CCMember" ||
        field("menu_id")?.value !== "5-1-1"
      ) {
        return false;
      }
      const option = Array.from(select.options).find(
        (item: { value: string }) => item.value.trim() === month,
      );
      if (!option) return false;
      select.value = option.value;
      const state = field("state");
      if (!state) return false;
      state.value = "eStatementQry";
      return true;
    }, value),
  );
  if (!ready) {
    throw new FeibProtocolError("遠東商銀帳單查詢表單結構已變更。");
  }
  const html = await submitAndCapture(page, "statement");
  if (feibStatementLabel(html) !== label) {
    throw new FeibProtocolError("遠東商銀帳單年月切換結果不符。");
  }
  return html;
}

/**
 * 在頁面內觸發表單送出並等待下一個主框架導覽完成，回傳伺服器 HTML（非經 JS 修改的 DOM）。
 * 送出前若出現原生 alert（官方前端檢核），立即失敗。
 */
async function submitAndCapture(
  page: Page,
  action: "deposit_transactions" | "statement",
): Promise<string> {
  const context = getContext(page);
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  navigation.catch(() => undefined);
  let dialogWaiter: ((message: string) => void) | undefined;
  const dialog = new Promise<"dialog">((resolve) => {
    dialogWaiter = () => resolve("dialog");
    context.dialogWaiters.push(dialogWaiter);
  });
  try {
    await withActionTimeout(
      page.evaluate((kind: string) => {
        // 以 setTimeout 讓 evaluate 先回傳；送出後的導覽不會中斷本次呼叫。
        setTimeout(() => {
          if (kind === "deposit_transactions") {
            // 官方查詢按鈕的處理函式：前端檢核後送出 inqForm（state=submit）。
            (
              window as unknown as { checkData: (args: string) => void }
            ).checkData("A");
          } else {
            document.forms.namedItem("mainForm")?.submit();
          }
        }, 0);
      }, action),
    );
    const result = await Promise.race([navigation, dialog]);
    if (result === "dialog") {
      throw new FeibProtocolError("遠東商銀頁面拒絕查詢條件（前端檢核提示）。");
    }
    const html = await responseHtml(page, result);
    assertLoggedInHtml(page, html);
    return html;
  } finally {
    context.dialogWaiters = context.dialogWaiters.filter(
      (waiter) => waiter !== dialogWaiter,
    );
  }
}

async function navigate(page: Page, url: string): Promise<string> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const html = await responseHtml(page, response);
  assertLoggedInHtml(page, html);
  return html;
}

async function responseHtml(page: Page, response: HTTPResponse | null) {
  if (response) {
    const status = response.status();
    if (status >= 400) {
      throw new FeibConnectionError(`遠東商銀頁面回應 HTTP ${status}。`);
    }
    try {
      return await withActionTimeout(response.text());
    } catch {
      // 部分導覽（例如 bfcache）沒有可讀取的回應本文，退回目前 DOM。
    }
  }
  return withActionTimeout(page.content());
}

function hasLogoutLink(html: string) {
  return /com\.lb\.wibc\.trx\.Logout/.test(html);
}

function assertLoggedInHtml(page: Page, html: string) {
  if (!hasLogoutLink(html)) {
    getSession(page).loggedIn = false;
    logFeibEvent("feib_session_lost", { path: safePath(page.url()) });
    throw new FeibSessionEndedError();
  }
}

async function assertStillLoggedIn(page: Page) {
  const loggedIn = await page
    .evaluate(() =>
      Boolean(document.querySelector('a[href*="com.lb.wibc.trx.Logout"]')),
    )
    .catch(() => false);
  if (!loggedIn) throw new FeibSessionEndedError();
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
      throw new FeibVerificationRequiredError(
        "遠東商銀驗證工作階段已結束，請重新取得驗證碼。",
      );
    }
    if (preferred.connectionId) {
      throw new FeibBrowserCapacityError(
        "遠東商銀驗證工作階段正在使用中，請稍候再試。",
        3,
      );
    }
    try {
      return await connectBrowserWithCancellation(
        browserFetcher,
        preferred.sessionId,
      );
    } catch {
      throw new FeibBrowserCapacityError(
        "前一個遠東商銀驗證工作階段尚未釋放，請稍候再試。",
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

function getContext(page: Page): FeibPageContext {
  const context = pageContexts.get(page);
  if (!context) throw new FeibConnectionError("遠東商銀頁面尚未初始化。");
  return context;
}

function getSession(page: Page) {
  return getContext(page).session;
}

async function configurePage(page: Page, session: FeibSessionState) {
  await page.setViewport({ width: 1280, height: 900 });
  // 桌面 UA：行動裝置 UA 會讓登入頁詢問是否開啟 App。
  await page.setUserAgent(USER_AGENT);
  // 官方檢核（查詢期間、三年上限）以瀏覽器本地日期計算；Browser Run 預設 UTC。
  await page.emulateTimezone?.("Asia/Taipei").catch(() => undefined);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  const context: FeibPageContext = {
    session,
    dialogs: [],
    dialogWaiters: [],
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
  // 原生對話框一律關閉：alert 確認、confirm／prompt 取消（不接受任何確認動作）。
  page.on("dialog", (dialog: Dialog) => {
    const message = dialog.message();
    if (context.dialogs.length < 10) context.dialogs.push(message);
    for (const waiter of context.dialogWaiters) waiter(message);
    logFeibEvent("feib_dialog", {
      type: dialog.type(),
      length: message.length,
    });
    const handled =
      dialog.type() === "alert" ? dialog.accept() : dialog.dismiss();
    handled.catch(() => undefined);
  });
}

function isLoginRequest(request: HTTPRequest) {
  if (request.method() !== "POST") return false;
  if (safePath(request.url()) !== "/netbank/servlet/TrxDispatcher")
    return false;
  const body = request.postData() ?? "";
  return /(?:^|&)state=login(?:&|$)/.test(body);
}

async function closeFeibBrowser(browser: Browser, binding: Fetcher) {
  if (!(await closeBrowserSession(binding, browser))) {
    logFeibEvent("feib_browser_cleanup_failed", {});
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
          () => reject(new FeibActionTimeoutError()),
          ACTION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireCredentials(config: FeibConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new FeibVerificationRequiredError(
      "請填寫身分證字號、使用者代號與密碼。",
    );
  }
}

export function isValidCaptcha(value: string) {
  return new RegExp(`^\\d{${FEIB_CAPTCHA_DIGIT_COUNT}}$`).test(value);
}

function assertCaptcha(value: string) {
  if (!isValidCaptcha(value)) {
    throw new FeibCaptchaRejectedError(
      `遠東商銀驗證碼必須是 ${FEIB_CAPTCHA_DIGIT_COUNT} 位數字。`,
    );
  }
}

function assertNotExpired(expiresAt: string | undefined, message: string) {
  if (!expiresAt || new Date(expiresAt) <= new Date()) {
    throw new FeibVerificationRequiredError(message);
  }
}

function mapFeibError(error: unknown): Error {
  if (
    error instanceof FeibVerificationRequiredError ||
    error instanceof FeibBrowserCapacityError ||
    error instanceof BrowserRunCapacityError ||
    error instanceof FeibConnectionError
  ) {
    return error;
  }
  if (error instanceof FeibProtocolError) {
    return new FeibConnectionError(error.message, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new FeibConnectionError(
    `遠東商銀連線失敗：${safeLogMessage(message)}`,
    error,
  );
}

function logFeibResult(result: ReturnType<typeof summarizeFeibResult>) {
  console.info(
    JSON.stringify({
      level: "info",
      event: "feib_sync_result",
      connectorId: "feib",
      ...result,
    }),
  );
}

function logFeibEvent(event: string, fields: Record<string, unknown>) {
  console.warn(JSON.stringify({ event, connectorId: "feib", ...fields }));
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
