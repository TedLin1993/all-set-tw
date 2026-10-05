import type { SyncResult } from "../types";
/**
 * 樂天國際銀行 connector（Cloudflare Browser Rendering）。
 *
 * - 驗證碼：有效的人工 challenge（prepareRakutenCaptcha 取得）優先；否則以
 *   Workers AI 自動辨識，只有「驗證碼錯誤」會重試，最多 3 次，其餘登入結果
 *   一律立即中止，避免帳號被鎖。
 * - 不復用 session／cookie：每次同步都重新登入，結束一律 browser.close()；
 *   只有 prepare 階段 disconnect，保留瀏覽器給使用者輸入驗證碼。
 */
import {
  BrowserRunCapacityError,
  launchBrowserWithRetry,
  connectBrowserWithCancellation,
} from "../browser.js";
import puppeteer, {
  type Browser,
  type Dialog,
  type HTTPRequest,
  type HTTPResponse,
  type Page,
} from "@cloudflare/puppeteer";
import { BANK_SYNC_MONTHS } from "../sync-window";
import { parseRakutenData, type RakutenConfig } from "./protocol";

// 網址與 API 端點定義
const LOGIN_URL = "https://www.rakuten-bank.com.tw/ebank/cgn/cgnot0001/010";
const LOGIN_API_PATH = "/channel-cgn/CGNOT0001/login";
const HOME_PATH_MARKER = "/ebank/chm/";
/** 登入頁路徑（/ebank/cgn/…）；session 失效時會被導回這裡。 */
const LOGIN_PAGE_PATH = /^\/ebank\/cgn\//i;
/** 首頁（含臺幣活存）的交易路徑，實際網址前綴為 /ixtein/adapters/ebank/txns。 */
const DASHBOARD_TXN_PATH = "/channel-chm/CHMQU0001/010";
/** 臺幣活存明細：010 是當月，011 是月份下拉選單選定的月份（前綴依實際 API，只比對結尾）。 */
const DEPOSIT_TXN_CURRENT_PATH = "/CTWQU0001/010";
const DEPOSIT_TXN_MONTH_PATH = "/CTWQU0001/011";

export const RAKUTEN_CAPTCHA_LENGTH = 4;
export const RAKUTEN_AUTO_LOGIN_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const CAPTCHA_IMAGE_TIMEOUT_MS = 10_000;
const LOGIN_READY_TIMEOUT_MS = 15_000;
const LOGIN_RESULT_TIMEOUT_MS = 8_000;
const LOGIN_RESULT_POLL_MS = 300;
const OCR_TIMEOUT_MS = 10_000;
/** 一輪 OCR 登入（載入登入頁 → 辨識 → 等待結果）至少需要的剩餘時間。 */
const MIN_OCR_ATTEMPT_MS = 12_000;
const STALE_SESSION_RELEASE_TIMEOUT_MS = 3_000;
const SYNC_DEADLINE_MS = 55_000;
/**
 * 活存明細與其後解析階段的期限。手動同步是一般 HTTP 請求、同步鎖 30 分鐘、排程 15
 * 分鐘，沒有 60 秒硬限制；多出的 20 秒只給活存明細用，登入與首頁存款的時限不變
 * （仍是 SYNC_DEADLINE_MS）。
 */
const DEPOSIT_TXN_DEADLINE_MS = 75_000;
const DASHBOARD_TAP_WAIT_MS = 5_000;
const DEPOSIT_TXN_WAIT_MS = 6_000;
const DEPOSIT_MENU_SETTLE_MS = 300;
const DEPOSIT_MONTH_DROPDOWN_SETTLE_MS = 300;
/** 登出（確認視窗＋等待導回登入頁）與收尾需要保留的時間，明細抓取不得侵占。 */
const SYNC_TAIL_RESERVE_MS = 8_000;
/** 再開始抓一個月份（開下拉、選月份、等回應）至少需要的剩餘時間。 */
const MIN_TXN_MONTH_MS = 5_000;
const TAP_POLL_MS = 200;
/** 等月份下拉按鈕／選項渲染出來的上限（同時受剩餘時間預算封頂）。 */
const MONTH_DROPDOWN_FIND_TIMEOUT_MS = 3_000;
const LOGOUT_CONFIRM_WAIT_MS = 3_000;
const LOGOUT_SETTLE_MS = 2_500;
const NAV_TIMEOUT_MS = 20_000;
const GOTO_ALLOW_TIMEOUT_MS = 5_000;
const ACTION_TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type RakutenSyncStage =
  | "acquire_browser"
  | "initialize_browser_page"
  | "configure_browser_page"
  | "login"
  | "fetch_dashboard"
  | "fetch_deposit_transactions"
  | "parse_payload";

const RAKUTEN_SYNC_STAGE_LABELS: Record<RakutenSyncStage, string> = {
  acquire_browser: "啟動瀏覽器",
  initialize_browser_page: "初始化瀏覽器頁面",
  configure_browser_page: "設定瀏覽器頁面",
  login: "登入樂天網銀",
  fetch_dashboard: "取得帳戶存款資訊",
  fetch_deposit_transactions: "取得臺幣存款明細",
  parse_payload: "解析帳務資料",
};

export class RakutenVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RakutenVerificationRequiredError";
  }
}

export class RakutenCredentialRejectedError extends RakutenVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "RakutenCredentialRejectedError";
  }
}

export class RakutenCaptchaRejectedError extends RakutenVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "RakutenCaptchaRejectedError";
  }
}

export class RakutenSessionConflictError extends RakutenVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "RakutenSessionConflictError";
  }
}

export class RakutenDeviceBindingRequiredError extends RakutenVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "RakutenDeviceBindingRequiredError";
  }
}

export type RakutenAutoCaptchaFailureReason =
  "exhausted" | "recognizer_unavailable" | "out_of_time";

/**
 * 自動辨識驗證碼失敗，前端應改走人工驗證流程（prepareRakutenCaptcha）。
 */
export class RakutenAutoCaptchaFailedError extends RakutenVerificationRequiredError {
  constructor(
    readonly reason: RakutenAutoCaptchaFailureReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "RakutenAutoCaptchaFailedError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** 辨識服務本身失敗或逾時（不是辨識結果錯誤）。 */
export class RakutenCaptchaRecognizerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RakutenCaptchaRecognizerError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class RakutenConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RakutenConnectionError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class RakutenSyncStageError extends RakutenConnectionError {
  constructor(
    readonly stage: RakutenSyncStage,
    cause: unknown,
  ) {
    const detail = safeRuntimeMessage(cause);
    super(
      `樂天同步在${RAKUTEN_SYNC_STAGE_LABELS[stage]}階段失敗${detail ? `：${detail}` : "。"}`,
      cause,
    );
    this.name = "RakutenSyncStageError";
  }
}

class RakutenSyncDeadlineError extends RakutenConnectionError {
  constructor(
    readonly stage: RakutenSyncStage,
    readonly elapsedMs: number,
  ) {
    super(
      `樂天同步在${RAKUTEN_SYNC_STAGE_LABELS[stage]}階段超過整體時間限制 (${Math.round(elapsedMs / 1000)}s)。`,
    );
    this.name = "RakutenSyncDeadlineError";
  }
}

export class RakutenBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "RakutenBrowserCapacityError";
  }
}

class RakutenActionTimeoutError extends Error {
  constructor() {
    super("樂天瀏覽器操作沒有在期限內回應。");
    this.name = "RakutenActionTimeoutError";
  }
}

type PreparedRakutenCaptcha = {
  browserSessionId: string;
  browserSessionExpiresAt: string;
  captchaImage: string;
  captchaLength: number;
};

export type RakutenCaptchaRecognizer = (
  imageBytes: ArrayBuffer,
  characterCount: number,
  contentType?: string,
) => Promise<string>;

export function dataUriToBuffer(dataUri: string): {
  bytes: ArrayBuffer;
  contentType: string;
} {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match || !match[1] || !match[2]) {
    throw new RakutenConnectionError("樂天圖形驗證碼格式無效。");
  }
  const contentType = match[1];
  const binary = atob(match[2]);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    uint8[i] = binary.charCodeAt(i);
  }
  return { bytes: uint8.buffer, contentType };
}

export function createRakutenConnector(
  browserFetcher?: Fetcher,
  recognizeCaptcha?: RakutenCaptchaRecognizer,
) {
  return {
    id: "rakuten" as const,
    name: "樂天國際銀行",

    async sync(
      config: RakutenConfig,
      _cursor?: string,
    ): Promise<SyncResult<unknown>> {
      requireCredentials(config);
      if (!browserFetcher) {
        throw new RakutenConnectionError("Browser binding is unavailable.");
      }

      const hasManualChallenge = Boolean(
        config.browserSessionId && config.captcha,
      );
      const manualChallengeExpired =
        hasManualChallenge &&
        (!config.browserSessionExpiresAt ||
          new Date(config.browserSessionExpiresAt) <= new Date());
      // 人工驗證碼有效時優先使用；逾時且有辨識器時退回自動辨識
      const useManualCaptcha = hasManualChallenge && !manualChallengeExpired;

      if (!useManualCaptcha && !recognizeCaptcha) {
        throw new RakutenVerificationRequiredError(
          manualChallengeExpired
            ? "樂天圖形驗證碼已逾時，請重新取得驗證碼。"
            : "請先在樂天網銀取得圖形驗證碼並輸入後再同步。",
        );
      }
      if (useManualCaptcha) assertCaptcha(config.captcha!);

      let stage: RakutenSyncStage = "acquire_browser";
      let browserInstance: Browser | undefined;
      let page: Page | undefined;
      const syncStartedAt = Date.now();
      const summary: RakutenSyncSummary = {
        loginMode: useManualCaptcha ? "manual" : "ocr",
        ocrAttempts: 0,
        depositSource: "none",
        depositAccountCount: 0,
        depositTxnMonthsFetched: 0,
        depositTxnCount: 0,
        loginMs: 0,
        dashboardMs: 0,
        depositTxnMs: 0,
        logoutMs: 0,
      };
      let outcome = "success";
      // 階段計時：切換階段時把前一階段的耗時記進 summary；失敗時由外層 finally 收尾，
      // 所以中途失敗的階段也有耗時
      let timedStage: RakutenTimedStage | undefined;
      let timedStageStartedAt = Date.now();
      const switchTimedStage = (next?: RakutenTimedStage) => {
        const now = Date.now();
        if (timedStage) summary[timedStage] += now - timedStageStartedAt;
        timedStage = next;
        timedStageStartedAt = now;
      };

      try {
        if (useManualCaptcha) {
          browserInstance = await reconnectPreparedBrowser(
            browserFetcher,
            config.browserSessionId!,
          );
        } else {
          // 釋放先前人工流程留下、已不會再用到的瀏覽器，避免佔用名額
          if (config.browserSessionId) {
            await releasePreparedBrowser(
              browserFetcher,
              config.browserSessionId,
            );
          }
          browserInstance = await acquireBrowser(browserFetcher);
        }

        stage = "initialize_browser_page";
        const pages = await browserInstance.pages();
        page = pages[0] ?? (await browserInstance.newPage());

        stage = "configure_browser_page";
        await configurePage(page);

        // 網路層只看得到加密的 rsData，監聽器只用來記錄呼叫過的路徑（空結果診斷）；
        // 資料一律讀取頁面內攔截到的解密後回應（見 installRakutenResponseTap）。
        const capturedUrls: string[] = [];
        const onGlobalResponse = (response: HTTPResponse) => {
          const url = response.url();
          if (!url.includes("rakuten-bank.com.tw")) return;
          const path = pathOfUrl(url);
          if (/\.(js|css|png|jpe?g|svg|ico|woff2?|ttf)$/i.test(path)) return;
          capturedUrls.push(
            `${response.request().method()} ${path} (${response.status()})`,
          );
        };
        page.on("response", onGlobalResponse);

        let loggedIn = false;
        try {
          stage = "login";
          switchTimedStage("loginMs");
          if (useManualCaptcha) {
            await fillAngularInput(page, "#captcha", config.captcha!);
            await clickLogin(page);
            const outcome = await waitForLoginResult(
              page,
              Math.min(
                LOGIN_RESULT_TIMEOUT_MS,
                remainingMs(syncStartedAt, stage),
              ),
            );
            throwForLoginOutcome(outcome);
          } else {
            await loginWithOcr(page, config, recognizeCaptcha!, syncStartedAt, {
              onAttemptStarted: () => {
                summary.ocrAttempts += 1;
              },
            });
          }

          // 登入後確保已進入首頁並放行 SPA
          await page.waitForFunction(
            (marker) => window.location.href.includes(marker),
            { timeout: remainingMs(syncStartedAt, stage) },
            HOME_PATH_MARKER,
          );
          loggedIn = true;

          // --- 存款：首頁 CHMQU0001 解密後的回應 ---
          stage = "fetch_dashboard";
          switchTimedStage("dashboardMs");
          const dashboardPayload = await waitForTappedResponse(
            page,
            DASHBOARD_TXN_PATH,
            Math.min(DASHBOARD_TAP_WAIT_MS, remainingMs(syncStartedAt, stage)),
          );
          let depositPageText: string | undefined;
          if (
            dashboardPayload === undefined &&
            remainingMs(syncStartedAt, stage) > 2000
          ) {
            console.warn(
              JSON.stringify({
                event: "rakuten_fallback",
                target: "deposit",
                step: "nav_click",
              }),
            );
            await clickRakutenNav(page, { exact: "臺幣存款" });
            await delay(Math.min(1500, remainingMs(syncStartedAt, stage)));
            depositPageText = await readBodyInnerText(page);
          }

          // --- 臺幣活存明細：存款 → 臺幣存款，當月加下拉選單往前的月份 ---
          stage = "fetch_deposit_transactions";
          switchTimedStage("depositTxnMs");
          const depositTxnPayloads = await fetchDepositTransactionPayloads(
            page,
            syncStartedAt,
          );
          summary.depositTxnMonthsFetched = depositTxnPayloads.length;

          stage = "parse_payload";
          switchTimedStage();
          // 呼叫底層共用 parser 轉換標準模型；存款優先使用 JSON，取不到才用文字
          const hasDeposit = (parsed: {
            bankAccounts: { accountType?: string }[];
          }) =>
            parsed.bankAccounts.some(
              (account) => account.accountType === "savings",
            );
          let data = parseRakutenData({
            dashboardPayload,
            depositPageText,
            depositTxnPayloads,
          });

          if (!hasDeposit(data) && !depositPageText) {
            console.warn(
              JSON.stringify({
                event: "rakuten_fallback",
                target: "deposit",
                step: "text_reread",
              }),
            );
            // 首頁資料沒有帶出存款，切到臺幣存款頁再讀文字（明細抓取後可能已在該頁）
            if (remainingMs(syncStartedAt, stage) > 2000) {
              await clickRakutenNav(page, { exact: "臺幣存款" });
              await delay(Math.min(1500, remainingMs(syncStartedAt, stage)));
            }
            depositPageText = await readBodyInnerText(page);
            data = parseRakutenData({
              dashboardPayload,
              depositPageText,
              depositTxnPayloads,
            });
          }

          summary.depositAccountCount = data.bankAccounts.filter(
            (account) => account.accountType === "savings",
          ).length;
          summary.depositSource = hasDeposit(
            parseRakutenData({ dashboardPayload }),
          )
            ? "tap"
            : hasDeposit(parseRakutenData({ depositPageText }))
              ? "text"
              : "none";
          // 樂天一定有臺幣活存帳戶；解析不到存款就視為頁面結構改變
          if (!hasDeposit(data)) {
            if (LOGIN_PAGE_PATH.test(pathOfUrl(page.url()))) {
              loggedIn = false;
              throw new RakutenVerificationRequiredError(
                "樂天網銀 session 已失效，請重新登入。",
              );
            }
            console.warn(
              JSON.stringify({
                event: "rakuten_sync_empty_result",
                capturedUrls,
                accountCount: data.bankAccounts.length,
                hasDashboardPayload: dashboardPayload !== undefined,
                hasDepositText: Boolean(depositPageText),
                // 不記錄頁面內容本身（可能含帳號、餘額、姓名）
                depositTextLength: depositPageText?.length,
                depositTextLineCount: depositPageText
                  ? depositPageText.split(/\r?\n/).filter(Boolean).length
                  : undefined,
              }),
            );
            throw new RakutenConnectionError(
              "樂天網銀頁面解析不到臺幣存款資料，請確認網頁結構。",
            );
          }

          summary.depositTxnCount = data.bankTransactions.length;
          const { transactionStats, ...syncData } = data;
          logRakutenTransactionStats(transactionStats);
          return {
            records: [],
            ...syncData,
          };
        } finally {
          page.off("response", onGlobalResponse);
          // 中途失敗時，先把當下階段的耗時收尾
          switchTimedStage();
          // 不留銀行端 session，避免下一次同步撞上「已在其他裝置登入」
          if (loggedIn) {
            const logoutStartedAt = Date.now();
            await logoutRakuten(page);
            summary.logoutMs = Date.now() - logoutStartedAt;
          }
        }
      } catch (error) {
        const normalized = normalizeRakutenSyncError(error, stage);
        outcome = normalized.name;
        throw normalized;
      } finally {
        if (browserInstance) await closeRakutenBrowser(browserInstance);
        // 整次同步一筆摘要（資訊類，不含帳號、餘額等值）。此處已在登出與關閉瀏覽器
        // 之後，所以 logoutMs 一定已寫入 summary
        console.log(
          JSON.stringify({
            event: "rakuten_sync_summary",
            outcome,
            stage: outcome === "success" ? undefined : stage,
            ...summary,
            durationMs: Date.now() - syncStartedAt,
          }),
        );
      }
    },
  };
}

type RakutenDataSource = "tap" | "text" | "none";

type RakutenSyncSummary = {
  loginMode: "manual" | "ocr";
  ocrAttempts: number;
  depositSource: RakutenDataSource;
  depositAccountCount: number;
  /** 成功讀到活存明細回應的月份數（不論之後是否解析成功） */
  depositTxnMonthsFetched: number;
  /** 解析出的活存交易筆數 */
  depositTxnCount: number;
  /** 各階段耗時（毫秒）；該階段沒執行到就維持 0 */
  loginMs: number;
  dashboardMs: number;
  depositTxnMs: number;
  logoutMs: number;
};

type RakutenTimedStage = "loginMs" | "dashboardMs" | "depositTxnMs";

// ---------------------------------------------------------------------------
// 讀取網頁自己解密後的 API 回應
// ---------------------------------------------------------------------------
type TappedResponse = { path: string; statusCode: string; rsData: unknown };

/**
 * 樂天網銀的 API 回應是以 session 金鑰 AES 加密的 `rsData`，網路層只看得到
 * 密文。這段程式在頁面載入前執行：包住 JSON.parse，網頁自己解密出
 * `{ statusCode, rsData }` 時，連同最近一個完成的 XHR 路徑記在頁面記憶體。
 * 資料只留在這個瀏覽器頁面裡供 worker 讀取，不送往任何地方、不寫入 log。
 */
export function installRakutenResponseTap() {
  const w = window as unknown as {
    __tfhRakutenTap?: { lastPath: string; responses: TappedResponse[] };
  };
  if (w.__tfhRakutenTap) return;
  const store = { lastPath: "", responses: [] as TappedResponse[] };
  w.__tfhRakutenTap = store;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    ...args: unknown[]
  ) {
    try {
      const path = new URL(String(args[1]), window.location.href).pathname;
      // 早於 Angular 自己的 load listener 註冊，解密前就記下路徑
      this.addEventListener("load", () => {
        store.lastPath = path;
      });
    } catch {
      // 忽略無法解析的網址
    }
    return (originalOpen as (...values: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const originalParse = JSON.parse;
  JSON.parse = function (
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ) {
    const result: unknown = originalParse.call(JSON, text, reviver as never);
    try {
      if (
        result !== null &&
        typeof result === "object" &&
        "statusCode" in result &&
        "rsData" in result &&
        typeof (result as { rsData: unknown }).rsData === "object" &&
        (result as { rsData: unknown }).rsData !== null &&
        store.responses.length < 50
      ) {
        store.responses.push({
          path: store.lastPath,
          statusCode: String((result as { statusCode: unknown }).statusCode),
          rsData: (result as { rsData: unknown }).rsData,
        });
      }
    } catch {
      // 絕不影響網頁本身的 JSON.parse
    }
    return result;
  } as typeof JSON.parse;
}

type TappedRead = { count: number; rsData: unknown };

/**
 * 讀取指定交易最新一筆成功的解密後回應；`afterIndex` 之前記錄的回應不算
 * （用來等「點擊之後」才送出的那一次）。同時回傳目前已記錄的筆數。
 */
async function readTappedResponse(
  page: Page,
  txnPath: string,
  afterIndex = 0,
): Promise<TappedRead> {
  const read = await withActionTimeout(
    page.evaluate(
      (input: { suffix: string; afterIndex: number }) => {
        const store = (
          window as unknown as {
            __tfhRakutenTap?: { responses: TappedResponse[] };
          }
        ).__tfhRakutenTap;
        const responses = store?.responses ?? [];
        for (let i = responses.length - 1; i >= input.afterIndex; i -= 1) {
          const entry = responses[i]!;
          if (
            !entry.path.endsWith(input.suffix) ||
            entry.statusCode !== "0000"
          ) {
            continue;
          }
          return { count: responses.length, rsData: entry.rsData };
        }
        return { count: responses.length, rsData: null };
      },
      { suffix: txnPath, afterIndex },
    ),
  ).catch(() => null);
  return {
    count: read?.count ?? 0,
    rsData: read?.rsData ?? undefined,
  };
}

/** 等待指定交易的解密後回應；頁面回到登入頁（session 失效）就不再等。 */
async function waitForTappedResponse(
  page: Page,
  txnPath: string,
  timeoutMs: number,
  afterIndex = 0,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rsData } = await readTappedResponse(page, txnPath, afterIndex);
    if (rsData !== undefined) return rsData;
    if (LOGIN_PAGE_PATH.test(pathOfUrl(page.url()))) return undefined;
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    await delay(Math.min(TAP_POLL_MS, left));
  }
}

// ---------------------------------------------------------------------------
// 臺幣活存明細（CTWQU0001）
// ---------------------------------------------------------------------------
/**
 * 明細抓取可用的剩餘時間：明細專用期限（DEPOSIT_TXN_DEADLINE_MS）扣掉登出與收尾
 * 要保留的時間；可能為負數。
 */
function txnBudgetMs(syncStartedAt: number): number {
  return (
    DEPOSIT_TXN_DEADLINE_MS -
    (Date.now() - syncStartedAt) -
    SYNC_TAIL_RESERVE_MS
  );
}

/** "2026/09" 往前推 n 個月（回傳 "YYYY/MM"）；無法解析就回傳 undefined。 */
export function shiftRakutenMonthLabel(
  label: string,
  monthsBack: number,
): string | undefined {
  const match = label.match(/(\d{4})\s*\/\s*(\d{1,2})/);
  if (!match) return undefined;
  const index = Number(match[1]) * 12 + (Number(match[2]) - 1) - monthsBack;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  if (!(year > 0) || month < 1 || month > 12) return undefined;
  return `${year}/${String(month).padStart(2, "0")}`;
}

type RakutenMonthSelect =
  { action: "toggle" } | { action: "choose"; label: string };

type RakutenMonthSelectResult = {
  /** toggle：下拉按鈕目前顯示的月份（"YYYY/MM"，不含帳務資料）。 */
  label: string;
  /** toggle：是否點了下拉按鈕；choose：是否點了目標月份選項。 */
  clicked: boolean;
  /** 畫面上長得像「YYYY/MM 活存明細」的元素數（只用於診斷）。 */
  labelShapedCount: number;
};

/**
 * 操作臺幣存款頁的月份下拉選單：toggle 點開按鈕並回報目前月份（"YYYY/MM"），
 * choose 點選指定月份的選項。只找文字含「YYYY/MM 活存明細」的元素（容忍圖示、
 * 零寬字元等額外文字），不點彈出視窗裡的東西。
 *
 * Angular 在回應到達後才會渲染按鈕／選項，所以找不到時每 TAP_POLL_MS 重試，
 * 最多等 maxWaitMs（呼叫端會用剩餘時間預算封頂）。
 */
async function operateMonthDropdown(
  page: Page,
  spec: RakutenMonthSelect,
  maxWaitMs: number,
): Promise<RakutenMonthSelectResult> {
  const deadline = Date.now() + Math.max(0, maxWaitMs);
  let last: RakutenMonthSelectResult = {
    label: "",
    clicked: false,
    labelShapedCount: 0,
  };
  for (;;) {
    const result = await withActionTimeout(
      page.evaluate((input: RakutenMonthSelect): RakutenMonthSelectResult => {
        // rakuten-month-select：測試 mock 依函式原始碼辨識這個 evaluate
        const normalize = (text: string | null | undefined) =>
          (text ?? "").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
        const shape = /(\d{4})\/(\d{2})活存明細/;
        const menuSelector =
          ".dropdown-menu, [role='listbox'], [role='menu'], ul";
        const clickableSelector =
          "button, a, [role='option'], [role='menuitem'], .combo-item";
        const monthOf = (element: HTMLElement) => {
          const texts = [
            element.innerText || element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ];
          for (const text of texts) {
            const found = shape.exec(normalize(text));
            if (found) return `${found[1]}/${found[2]}`;
          }
          return undefined;
        };
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(
            "a, button, li, span, div, p, [role='option'], [role='menuitem'], .dropdown-item, .combo-item",
          ),
        ).flatMap((element) => {
          if (element.closest(".modal")) return [];
          const month = monthOf(element);
          return month ? [{ element, month }] : [];
        });
        // 只留最內層符合的元素，避免外層容器被當成按鈕或選項
        const innermost = candidates.filter(
          (candidate) =>
            !candidates.some(
              (other) =>
                other !== candidate &&
                candidate.element.contains(other.element),
            ),
        );
        const entries: { element: HTMLElement; month: string }[] = [];
        for (const { element, month } of innermost) {
          const clickable =
            element.closest<HTMLElement>(clickableSelector) ??
            element.querySelector<HTMLElement>("a, button") ??
            element;
          if (!entries.some((entry) => entry.element === clickable)) {
            entries.push({ element: clickable, month });
          }
        }
        const labelShapedCount = entries.length;
        const outsideMenu = (entry: { element: HTMLElement }) =>
          !entry.element.closest(menuSelector);
        const toggle =
          entries.find(
            (entry) => entry.element.matches("button") && outsideMenu(entry),
          ) ?? entries.find(outsideMenu);
        if (input.action === "toggle") {
          if (!toggle) return { label: "", clicked: false, labelShapedCount };
          const expanded =
            toggle.element.getAttribute("aria-expanded") === "true";
          if (!expanded) toggle.element.click();
          return { label: toggle.month, clicked: true, labelShapedCount };
        }
        const wanted = /(\d{4})\/(\d{2})/.exec(normalize(input.label));
        const wantedMonth = wanted ? `${wanted[1]}/${wanted[2]}` : undefined;
        const others = entries.filter(
          (entry) => entry !== toggle && entry.month === wantedMonth,
        );
        const option =
          others.find((entry) => entry.element.closest(menuSelector)) ??
          others[0];
        if (!option) return { label: "", clicked: false, labelShapedCount };
        option.element.click();
        return { label: "", clicked: true, labelShapedCount };
      }, spec),
    ).catch(() => undefined);
    if (result) last = result;
    if (result?.clicked) return result;
    const left = deadline - Date.now();
    if (left <= 0) return last;
    await delay(Math.min(TAP_POLL_MS, left));
  }
}

function logRakutenTxnSkipped(
  reason: string,
  extra: Record<string, number> = {},
) {
  console.warn(
    JSON.stringify({ event: "rakuten_tx_fetch_skipped", reason, ...extra }),
  );
}

/**
 * 點選單「存款」→「臺幣存款」讀當月明細（CTWQU0001/010），再用月份下拉選單往前
 * 選到 BANK_SYNC_MONTHS 個月（每個月 CTWQU0001/011）。
 *
 * 明細只是附加資料：任何一步失敗、逾時或時間不足都只記錄事件並回傳已取得的
 * 月份，絕不讓同步失敗（餘額照常）。回傳的每個元素是一個月份的 rsData。
 * 目前不分頁：display.dataEnd === false／dataLimit === true 時保留已回傳的資料。
 */
async function fetchDepositTransactionPayloads(
  page: Page,
  syncStartedAt: number,
): Promise<unknown[]> {
  const payloads: unknown[] = [];
  try {
    if (txnBudgetMs(syncStartedAt) < MIN_TXN_MONTH_MS) {
      logRakutenTxnSkipped("out_of_time");
      return payloads;
    }

    const { count: beforeOpen } = await readTappedResponse(
      page,
      DEPOSIT_TXN_CURRENT_PATH,
    );
    // 子選單可能要先展開；找不到「存款」不算失敗（臺幣存款連結可能一直在 DOM 裡）
    await clickRakutenNav(page, { exact: "存款" });
    await delay(
      Math.max(0, Math.min(DEPOSIT_MENU_SETTLE_MS, txnBudgetMs(syncStartedAt))),
    );
    const opened = await clickRakutenNav(page, { exact: "臺幣存款" });
    if (!opened) {
      logRakutenTxnSkipped("nav_missing");
      return payloads;
    }
    // 已經在臺幣存款頁時 SPA 不會重送 010，改讀先前已攔截到的最新一筆
    const current =
      (await waitForTappedResponse(
        page,
        DEPOSIT_TXN_CURRENT_PATH,
        Math.max(0, Math.min(DEPOSIT_TXN_WAIT_MS, txnBudgetMs(syncStartedAt))),
        beforeOpen,
      )) ?? (await readTappedResponse(page, DEPOSIT_TXN_CURRENT_PATH)).rsData;
    if (current === undefined) {
      logRakutenTxnSkipped("no_response");
      return payloads;
    }
    payloads.push(current);

    const dropdownWaitMs = () =>
      Math.max(
        0,
        Math.min(MONTH_DROPDOWN_FIND_TIMEOUT_MS, txnBudgetMs(syncStartedAt)),
      );
    let currentLabel: string | undefined;
    for (let back = 1; back < BANK_SYNC_MONTHS; back += 1) {
      if (txnBudgetMs(syncStartedAt) < MIN_TXN_MONTH_MS) {
        logRakutenTxnSkipped("out_of_time", {
          monthsFetched: payloads.length,
          monthsWanted: BANK_SYNC_MONTHS,
        });
        break;
      }
      const { count: beforeMonth } = await readTappedResponse(
        page,
        DEPOSIT_TXN_MONTH_PATH,
      );
      const toggled = await operateMonthDropdown(
        page,
        { action: "toggle" },
        dropdownWaitMs(),
      );
      if (!toggled.clicked) {
        logRakutenTxnSkipped("month_dropdown_missing", {
          labelShapedCount: toggled.labelShapedCount,
        });
        break;
      }
      // 目標月份依「當月」的下拉按鈕文字往前推（第一次的按鈕顯示的就是當月）
      currentLabel ??= toggled.label;
      const target = shiftRakutenMonthLabel(currentLabel, back);
      if (!target) {
        logRakutenTxnSkipped("month_label_unreadable");
        break;
      }
      await delay(
        Math.max(
          0,
          Math.min(
            DEPOSIT_MONTH_DROPDOWN_SETTLE_MS,
            txnBudgetMs(syncStartedAt),
          ),
        ),
      );
      const chosen = await operateMonthDropdown(
        page,
        { action: "choose", label: `${target} 活存明細` },
        dropdownWaitMs(),
      );
      if (!chosen.clicked) {
        logRakutenTxnSkipped("month_option_missing", {
          labelShapedCount: chosen.labelShapedCount,
        });
        break;
      }
      const monthPayload = await waitForTappedResponse(
        page,
        DEPOSIT_TXN_MONTH_PATH,
        Math.max(0, Math.min(DEPOSIT_TXN_WAIT_MS, txnBudgetMs(syncStartedAt))),
        beforeMonth,
      );
      if (monthPayload === undefined) {
        logRakutenTxnSkipped("no_response", {
          monthsFetched: payloads.length,
        });
        break;
      }
      payloads.push(monthPayload);
    }
  } catch (error) {
    // 只記錄錯誤名稱：訊息可能帶有頁面內容
    console.warn(
      JSON.stringify({
        event: "rakuten_tx_fetch_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
        monthsFetched: payloads.length,
      }),
    );
  }
  return payloads;
}

/** 交易解析結果的筆數統計；只有數字與原因代碼，沒有任何交易內容。 */
function logRakutenTransactionStats(stats: {
  monthsProvided: number;
  monthsSkipped: number;
  rowsSkipped: number;
  monthsTruncated: number;
  skipReasons: Record<string, number>;
}) {
  if (stats.monthsSkipped > 0 || stats.rowsSkipped > 0) {
    console.warn(
      JSON.stringify({
        event: "rakuten_tx_skipped",
        monthsProvided: stats.monthsProvided,
        monthsSkipped: stats.monthsSkipped,
        rowsSkipped: stats.rowsSkipped,
        reasons: stats.skipReasons,
      }),
    );
  }
  if (stats.monthsTruncated > 0) {
    console.log(
      JSON.stringify({
        event: "rakuten_tx_truncated",
        monthsTruncated: stats.monthsTruncated,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 登出
// ---------------------------------------------------------------------------
type RakutenLogoutResult =
  | "logged_out"
  | "no_logout_link"
  | "no_confirm_modal"
  | "no_confirm_button"
  | "error";

/**
 * 同步結束前登出，避免銀行端 session 殘留。只點頁首的「登出」，以及標題含
 * 「登出」、內文含「確認登出」的確認視窗裡的「確認」；絕不點其他視窗的按鈕。
 * 失敗只記錄事件，不影響同步結果。
 */
async function logoutRakuten(page: Page): Promise<void> {
  const startedAt = Date.now();
  let result: RakutenLogoutResult = "error";
  try {
    const clicked = await clickRakutenNav(page, { exact: "登出" });
    if (!clicked) {
      result = "no_logout_link";
    } else {
      result = "no_confirm_modal";
      const deadline = Date.now() + LOGOUT_CONFIRM_WAIT_MS;
      while (Date.now() < deadline) {
        const state = await withActionTimeout(
          page.evaluate(() => {
            // rakuten-logout-confirm：只處理「確認登出」視窗
            const modals = Array.from(
              document.querySelectorAll<HTMLElement>(".modal"),
            );
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              const visible =
                modal.classList.contains("show") || style.display !== "none";
              if (!visible) continue;
              const title =
                modal.querySelector(".modal-title")?.textContent?.trim() ?? "";
              const info =
                modal.querySelector(".txt_info")?.textContent?.trim() ?? "";
              if (!title.includes("登出") || !info.includes("確認登出")) {
                continue;
              }
              const confirm = Array.from(
                modal.querySelectorAll<HTMLElement>(
                  ".modal-footer a, .modal-footer button",
                ),
              ).find(
                (element) => (element.textContent ?? "").trim() === "確認",
              );
              if (!confirm) return "no_confirm_button";
              confirm.click();
              return "clicked";
            }
            return "no_modal";
          }),
        ).catch(() => "no_modal");
        if (state === "clicked") {
          result = "logged_out";
          break;
        }
        if (state === "no_confirm_button") {
          result = "no_confirm_button";
          break;
        }
        await delay(TAP_POLL_MS);
      }
      if (result === "logged_out") {
        // 等登出請求送出（頁面回到登入頁）再關閉瀏覽器
        const settleDeadline = Date.now() + LOGOUT_SETTLE_MS;
        while (
          Date.now() < settleDeadline &&
          !LOGIN_PAGE_PATH.test(pathOfUrl(page.url()))
        ) {
          await delay(TAP_POLL_MS);
        }
      }
    }
  } catch {
    result = "error";
  }
  const line = JSON.stringify({
    event: "rakuten_logout",
    result,
    durationMs: Date.now() - startedAt,
  });
  if (result === "logged_out") console.log(line);
  else console.warn(line);
}

// ---------------------------------------------------------------------------
// 驗證碼準備與瀏覽器初始化流程
// ---------------------------------------------------------------------------
export async function prepareRakutenCaptcha(
  browserFetcher?: Fetcher,
  config?: RakutenConfig,
): Promise<PreparedRakutenCaptcha> {
  if (!config) {
    throw new RakutenVerificationRequiredError(
      "請填寫身分證字號、使用者代號與登入密碼。",
    );
  }
  requireCredentials(config);
  if (!browserFetcher) {
    throw new RakutenConnectionError("Browser binding is unavailable.");
  }

  const browserInstance = await acquireBrowserForPrepare(
    browserFetcher,
    config.browserSessionId,
  );
  let preserved = false;
  try {
    const pages = await browserInstance.pages();
    const page = pages[0] ?? (await browserInstance.newPage());
    await configurePage(page);
    const captchaImage = await openLoginAndCaptureCaptcha(page, config);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaLength: RAKUTEN_CAPTCHA_LENGTH,
      captchaImage,
    };
  } finally {
    if (!preserved) await closeRakutenBrowser(browserInstance);
  }
}

/** 依剩餘時間縮短各步驟逾時；未傳入時使用預設值。 */
type TimeBudget = (preferredMs: number) => number;
const noBudget: TimeBudget = (ms) => ms;

async function prepareLoginAndCapture(
  page: Page,
  config: RakutenConfig,
  budget: TimeBudget = noBudget,
): Promise<{
  captchaDataUri: string;
  fillCredentials: () => Promise<void>;
}> {
  await gotoAllowingTimeout(page, LOGIN_URL, budget(GOTO_ALLOW_TIMEOUT_MS));
  try {
    await page.waitForFunction(
      () =>
        Boolean(document.getElementById("custNo")) &&
        Boolean(document.getElementById("userNo")) &&
        Boolean(document.getElementById("pcode")) &&
        Boolean(document.getElementById("captcha")),
      { timeout: budget(LOGIN_READY_TIMEOUT_MS) },
    );
  } catch (error) {
    if (error instanceof RakutenSyncDeadlineError) throw error;
    throw new RakutenConnectionError(
      "樂天登入頁沒有在期限內載入完整表單，請稍後再試。",
      error,
    );
  }

  const blockingModal = await readVisibleModalText(page);
  if (/維護/.test(blockingModal)) {
    throw new RakutenConnectionError(
      "樂天網銀系統維護中，暫時無法登入，請稍後再試。",
    );
  }

  const captchaDataUri = await captureCaptchaImage(
    page,
    budget(CAPTCHA_IMAGE_TIMEOUT_MS),
  );

  const fillCredentials = async () => {
    await fillAngularInput(page, "#custNo", config.userId ?? "");
    await fillAngularInput(page, "#userNo", config.account ?? "");
    await fillAngularInput(page, "#pcode", config.password ?? "");
  };

  return { captchaDataUri, fillCredentials };
}

async function openLoginAndCaptureCaptcha(
  page: Page,
  config: RakutenConfig,
): Promise<string> {
  const { captchaDataUri, fillCredentials } = await prepareLoginAndCapture(
    page,
    config,
  );
  await fillCredentials();
  // 若驗證碼圖片在填寫帳密後被刷新，回傳最新那張
  const latest = await readCaptchaDataUri(page);
  return latest && latest !== captchaDataUri ? latest : captchaDataUri;
}

async function readCaptchaDataUri(page: Page): Promise<string> {
  const dataUri = await withActionTimeout(
    page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>(
        "div.pic_veri captcha-image img",
      );
      return image?.src ?? "";
    }),
  ).catch(() => "");
  return dataUri.startsWith("data:") ? dataUri : "";
}

async function captureCaptchaImage(
  page: Page,
  timeoutMs = CAPTCHA_IMAGE_TIMEOUT_MS,
): Promise<string> {
  try {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          "div.pic_veri captcha-image img",
        );
        return Boolean(image?.src && image.src.startsWith("data:"));
      },
      { timeout: timeoutMs },
    );
  } catch (error) {
    throw new RakutenConnectionError(
      "樂天登入頁沒有在期限內取得圖形驗證碼。",
      error,
    );
  }
  const dataUri = await readCaptchaDataUri(page);
  if (!dataUri) {
    throw new RakutenConnectionError("樂天登入頁沒有取得圖形驗證碼。");
  }
  return dataUri;
}

async function clickLogin(page: Page) {
  // 對話框可能在按下登入的瞬間就出現，因此在點擊前（而非等待結果時）清除
  rakutenDialogLoginOutcomes.delete(page);
  await withActionTimeout(
    page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(
        "div.login-box a.btn.btn-primary.w-100",
      );
      if (button) button.click();
    }),
  );
}

type LoginOutcomeKind =
  | "success"
  | "session_conflict"
  | "captcha"
  | "credential"
  | "maintenance"
  | "device_binding"
  | "unknown";

type LoginOutcome = { kind: LoginOutcomeKind; text?: string };

/**
 * 輪詢登入結果：成功（進入首頁）或可見 modal 中的錯誤訊息。
 *
 * 刻意「不」以整頁 innerText 分類：登入頁本身就有「身分證字號」「密碼」
 * 「驗證碼」等欄位標籤，回應稍慢就會被誤判成帳密或驗證碼錯誤。
 * 期限內判斷不出來一律回傳 unknown。
 */
async function waitForLoginResult(
  page: Page,
  timeoutMs = LOGIN_RESULT_TIMEOUT_MS,
): Promise<LoginOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let polls = 0;
  let loginRequestCount = 0;
  let loginResponseCount = 0;
  const pendingResponses: Promise<void>[] = [];

  const isLoginUrl = (url: string) =>
    url.includes(LOGIN_API_PATH) || url.includes("/CGNOT0001/");

  const onRequest = (request: HTTPRequest) => {
    if (isLoginUrl(request.url())) loginRequestCount += 1;
  };
  const onResponse = (response: HTTPResponse) => {
    if (!isLoginUrl(response.url())) return;
    loginResponseCount += 1;
    pendingResponses.push(logRakutenLoginResponse(response));
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  try {
    for (;;) {
      polls += 1;
      if (page.url().includes(HOME_PATH_MARKER)) return { kind: "success" };
      // 原生對話框（例如 confirm「已在其他裝置登入」）已被 dismiss，依其分類結束
      const dialogOutcome = rakutenDialogLoginOutcomes.get(page);
      if (dialogOutcome) {
        rakutenDialogLoginOutcomes.delete(page);
        return { kind: dialogOutcome };
      }
      const modalText = await readVisibleModalText(
        page,
        Math.max(1_000, deadline - Date.now()),
      );
      const classified = classifyRakutenLoginText(modalText);
      if (classified !== "unknown") {
        return { kind: classified, text: modalText };
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await delay(Math.min(LOGIN_RESULT_POLL_MS, left));
    }

    await Promise.allSettled(pendingResponses);
    console.warn(
      JSON.stringify({
        event: "rakuten_login_outcome_unknown",
        elapsedMs: Date.now() - startedAt,
        polls,
        loginRequestCount,
        loginResponseCount,
        currentUrl: page.url().replace(/[?#].*/, ""),
      }),
    );
    return { kind: "unknown" };
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    await Promise.allSettled(pendingResponses);
  }
}

function throwForLoginOutcome(outcome: LoginOutcome): void {
  switch (outcome.kind) {
    case "success":
      return;
    case "session_conflict":
      throw new RakutenSessionConflictError(
        "樂天網銀已在其他裝置登入，請先登出樂天 App 或其他瀏覽器後再同步。",
      );
    case "captcha":
      throw new RakutenCaptchaRejectedError(
        "樂天圖形驗證碼錯誤，請重新取得驗證碼。",
      );
    case "credential":
      throw new RakutenCredentialRejectedError(
        "樂天銀行身分證字號、使用者代號或密碼錯誤。",
      );
    case "maintenance":
      throw new RakutenConnectionError(
        "樂天網銀系統維護中，暫時無法登入，請稍後再試。",
      );
    case "device_binding":
      throw new RakutenDeviceBindingRequiredError(
        "樂天要求此裝置進行身分驗證（簡訊／Email 驗證碼或晶片卡綁定），請改用手動記錄。",
      );
    case "unknown":
      throw new RakutenConnectionError(
        "樂天網銀登入結果無法辨識，請確認登入狀態或重試。",
      );
  }
}

/**
 * 自動辨識驗證碼登入。只有「驗證碼錯誤」（含辨識結果格式不符）會重試；
 * 帳密錯誤、重複登入、裝置綁定、維護、結果無法辨識一律立即中止，
 * 避免以錯誤帳密重複送出而觸發帳號鎖定。
 */
async function loginWithOcr(
  page: Page,
  config: RakutenConfig,
  recognizeCaptcha: RakutenCaptchaRecognizer,
  syncStartedAt: number,
  hooks: { onAttemptStarted?: () => void } = {},
): Promise<void> {
  const budget: TimeBudget = (preferredMs) =>
    Math.min(preferredMs, remainingMs(syncStartedAt, "login"));

  await runRakutenOcrAttempts(
    async () => {
      hooks.onAttemptStarted?.();
      const { captchaDataUri, fillCredentials } = await prepareLoginAndCapture(
        page,
        config,
        budget,
      );

      // 帳密填寫與辨識平行進行；用 allSettled 確保兩者都結束後才往下走，
      // 避免辨識失敗時背景仍在打字、與下一輪的頁面重新載入互相干擾。
      const ocrTimeoutMs = budget(OCR_TIMEOUT_MS);
      const [filled, recognized] = await Promise.allSettled([
        fillCredentials(),
        recognizeCaptchaImage(recognizeCaptcha, captchaDataUri, ocrTimeoutMs),
      ]);
      if (filled.status === "rejected") throw filled.reason;
      if (recognized.status === "rejected") throw recognized.reason;
      let answer = recognized.value;

      // 驗證碼圖片若在填寫帳密後被刷新，改辨識最新那張
      const latest = await readCaptchaDataUri(page);
      if (latest && latest !== captchaDataUri) {
        answer = await recognizeCaptchaImage(
          recognizeCaptcha,
          latest,
          budget(OCR_TIMEOUT_MS),
        );
      }

      await fillAngularInput(page, "#captcha", answer);
      await clickLogin(page);
      const outcome = await waitForLoginResult(
        page,
        budget(LOGIN_RESULT_TIMEOUT_MS),
      );
      throwForLoginOutcome(outcome);
    },
    {
      maxAttempts: RAKUTEN_AUTO_LOGIN_ATTEMPTS,
      hasTimeForAttempt: () =>
        SYNC_DEADLINE_MS - (Date.now() - syncStartedAt) >= MIN_OCR_ATTEMPT_MS,
      onAttemptFailed: (attempt, error) => {
        console.warn(
          JSON.stringify({
            event: "rakuten_ocr_attempt_failed",
            attempt,
            maxAttempts: RAKUTEN_AUTO_LOGIN_ATTEMPTS,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    },
  );
}

export type RakutenOcrAttemptOptions = {
  maxAttempts: number;
  hasTimeForAttempt: () => boolean;
  onAttemptFailed?: (attempt: number, error: unknown) => void;
};

/**
 * OCR 重試邏輯（不依賴 puppeteer，方便單元測試）。
 * - 成功：正常結束
 * - RakutenCaptchaRejectedError：重試
 * - RakutenCaptchaRecognizerError：辨識服務不可用，改要求人工驗證
 * - 其他錯誤：原樣拋出
 */
export async function runRakutenOcrAttempts(
  attemptOnce: (attempt: number) => Promise<void>,
  options: RakutenOcrAttemptOptions,
): Promise<void> {
  let attemptsMade = 0;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (!options.hasTimeForAttempt()) break;
    attemptsMade = attempt;
    try {
      await attemptOnce(attempt);
      return;
    } catch (error) {
      if (error instanceof RakutenCaptchaRecognizerError) {
        throw new RakutenAutoCaptchaFailedError(
          "recognizer_unavailable",
          "樂天驗證碼自動辨識服務暫時無法使用，請改用人工驗證。",
          error,
        );
      }
      if (!(error instanceof RakutenCaptchaRejectedError)) throw error;
      lastError = error;
      options.onAttemptFailed?.(attempt, error);
    }
  }

  if (attemptsMade === 0) {
    throw new RakutenAutoCaptchaFailedError(
      "out_of_time",
      "樂天同步剩餘時間不足以自動辨識驗證碼，請改用人工驗證。",
    );
  }
  throw new RakutenAutoCaptchaFailedError(
    "exhausted",
    `樂天驗證碼自動辨識連續失敗 ${attemptsMade} 次，請改用人工驗證。`,
    lastError,
  );
}

async function recognizeCaptchaImage(
  recognizeCaptcha: RakutenCaptchaRecognizer,
  dataUri: string,
  timeoutMs: number,
): Promise<string> {
  const { bytes, contentType } = dataUriToBuffer(dataUri);
  let raw: string;
  try {
    raw = await withTimeout(
      recognizeCaptcha(bytes, RAKUTEN_CAPTCHA_LENGTH, contentType),
      timeoutMs,
      () => new RakutenCaptchaRecognizerError("驗證碼辨識服務逾時。"),
    );
  } catch (error) {
    if (error instanceof RakutenCaptchaRecognizerError) throw error;
    throw new RakutenCaptchaRecognizerError("驗證碼辨識服務失敗。", error);
  }
  return normalizeRakutenCaptchaAnswer(raw);
}

/** 清掉辨識結果中的空白與標點；長度或字元不符時視為驗證碼錯誤（會重試）。 */
export function normalizeRakutenCaptchaAnswer(raw: unknown): string {
  const answer = String(raw ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (!new RegExp(`^[A-Za-z0-9]{${RAKUTEN_CAPTCHA_LENGTH}}$`).test(answer)) {
    throw new RakutenCaptchaRejectedError(
      `驗證碼辨識結果格式不符（${answer.length} 字）。`,
    );
  }
  return answer;
}

export function classifyRakutenLoginText(text: string): LoginOutcomeKind {
  if (!text) return "unknown";
  if (/重複登入|其他裝置/.test(text)) return "session_conflict";
  if (/晶片|裝置綁定|裝置認證|手機號碼|電子信箱|簡訊|OTP|約定條款/i.test(text))
    return "device_binding";
  if (/驗證碼/.test(text)) return "captcha";
  if (/密碼|代號|身分證|錯誤次數/.test(text)) return "credential";
  if (/維護/.test(text)) return "maintenance";
  return "unknown";
}

async function readVisibleModalText(
  page: Page,
  timeoutMs = ACTION_TIMEOUT_MS,
): Promise<string> {
  return withTimeout(
    page.evaluate(() => {
      const modals = Array.from(
        document.querySelectorAll<HTMLElement>(".modal"),
      );
      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        const visible =
          modal.classList.contains("show") || style.display !== "none";
        if (!visible) continue;
        const title =
          modal.querySelector(".modal-title")?.textContent?.trim() ?? "";
        const info =
          modal.querySelector(".txt_info")?.textContent?.trim() ?? "";
        const combined = `${title}\n${info}`.trim();
        if (combined) return combined;
      }
      return "";
    }),
    timeoutMs,
    () => new RakutenActionTimeoutError(),
  ).catch(() => "");
}

// ---------------------------------------------------------------------------
// 登入回應診斷
// ---------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathOfUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

async function logRakutenLoginResponse(response: HTTPResponse) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // Do not log response bodies or upstream exception messages.
  }
  const result = isRecord(payload)
    ? (payload.result ?? payload.RESULT)
    : undefined;
  const code = isRecord(payload) ? (payload.code ?? payload.CODE) : undefined;
  console.log(
    JSON.stringify({
      event: "rakuten_login_response",
      url: response.url().split("?")[0],
      httpStatus: response.status(),
      validJson: payload !== undefined,
      result: typeof result === "string" ? result.slice(0, 30) : undefined,
      code: typeof code === "string" ? code.slice(0, 20) : undefined,
      hasMessage:
        isRecord(payload) &&
        Boolean(payload.message ?? payload.MESSAGE ?? payload.msg),
    }),
  );
}

// ---------------------------------------------------------------------------
// 整體同步時間限制
// ---------------------------------------------------------------------------
/**
 * 各階段的整體期限：活存明細與其後的解析階段（明細抓完後才會走到，可能已超過
 * 55 秒）使用延長後的期限，其餘階段維持 SYNC_DEADLINE_MS。
 */
function stageDeadlineMs(stage: RakutenSyncStage): number {
  return stage === "fetch_deposit_transactions" || stage === "parse_payload"
    ? DEPOSIT_TXN_DEADLINE_MS
    : SYNC_DEADLINE_MS;
}

function remainingMs(syncStartedAt: number, stage: RakutenSyncStage): number {
  const elapsed = Date.now() - syncStartedAt;
  const remaining = stageDeadlineMs(stage) - elapsed;
  if (remaining <= 0) {
    throw new RakutenSyncDeadlineError(stage, elapsed);
  }
  return remaining;
}

// ---------------------------------------------------------------------------
// 輔助函式庫與連線管理
// ---------------------------------------------------------------------------
type RakutenNavClick = { exact: string };

async function clickRakutenNav(
  page: Page,
  click: RakutenNavClick,
): Promise<boolean> {
  return withActionTimeout(
    page.evaluate((spec: RakutenNavClick) => {
      // rakuten-nav-click：測試 mock 依函式原始碼辨識這個 evaluate
      // 絕不點彈出視窗（常用功能編輯、確認視窗等）裡的元素
      const links = Array.from(
        document.querySelectorAll<HTMLElement>("a, button"),
      ).filter((element) => !element.closest(".modal"));
      const target = links.find(
        (element) => (element.textContent || "").trim() === spec.exact,
      );
      if (!target) return false;
      target.click();
      return true;
    }, click),
  ).catch(() => false);
}

async function readBodyInnerText(page: Page): Promise<string> {
  return withActionTimeout(
    page.evaluate(() => document.body?.innerText ?? ""),
  ).catch(() => "");
}

async function withActionTimeout<T>(action: Promise<T>): Promise<T> {
  return withTimeout(
    action,
    ACTION_TIMEOUT_MS,
    () => new RakutenActionTimeoutError(),
  );
}

async function withTimeout<T>(
  action: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  action.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function gotoAllowingTimeout(
  page: Page,
  url: string,
  timeoutMs = GOTO_ALLOW_TIMEOUT_MS,
) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  } catch (error) {
    if (!isNavigationTimeout(error)) throw error;
  }
}

function isNavigationTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Navigation timeout of \d+ ms exceeded/i.test(message);
}

async function reconnectPreparedBrowser(
  browserFetcher: Fetcher,
  sessionId: string,
): Promise<Browser> {
  const sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
  const preferred = sessions.find((session) => session.sessionId === sessionId);
  if (!preferred) {
    throw new RakutenVerificationRequiredError(
      "樂天圖形驗證碼工作階段已逾時，請重新取得驗證碼。",
    );
  }
  if (preferred.connectionId) {
    throw new RakutenBrowserCapacityError(
      "樂天驗證碼正在產生中，請稍候再試。",
      3,
    );
  }
  try {
    return await connectBrowserWithCancellation(browserFetcher, sessionId);
  } catch {
    throw new RakutenBrowserCapacityError(
      "前一個樂天驗證工作階段尚未釋放，請稍候再試。",
      3,
    );
  }
}

async function acquireBrowserForPrepare(
  browserFetcher: Fetcher,
  preferredSessionId?: string,
): Promise<Browser> {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browserFetcher).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      throw new RakutenBrowserCapacityError(
        "樂天驗證碼正在產生中，請稍候再試。",
        3,
      );
    }
    if (preferred) {
      try {
        return await connectBrowserWithCancellation(
          browserFetcher,
          preferred.sessionId,
        );
      } catch {
        throw new RakutenBrowserCapacityError(
          "前一個樂天驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
  }

  return acquireBrowser(browserFetcher);
}

/** 盡力關閉人工流程遺留的瀏覽器；失敗不影響同步。 */
async function releasePreparedBrowser(
  browserFetcher: Fetcher,
  sessionId: string,
): Promise<void> {
  try {
    await withTimeout(
      (async () => {
        const sessions = await puppeteer.sessions(browserFetcher);
        const session = sessions.find((item) => item.sessionId === sessionId);
        if (!session || session.connectionId) return;
        const browser = await connectBrowserWithCancellation(
          browserFetcher,
          sessionId,
        );
        await closeRakutenBrowser(browser);
      })(),
      STALE_SESSION_RELEASE_TIMEOUT_MS,
      () => new RakutenActionTimeoutError(),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "rakuten_release_prepared_browser_failed",
        reason: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

async function acquireBrowser(browserFetcher: Fetcher): Promise<Browser> {
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

async function closeRakutenBrowser(browser: Browser) {
  try {
    await browser.close();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "rakuten_browser_close_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }
}

const rakutenDialogGuardedPages = new WeakSet<Page>();

async function configurePage(page: Page) {
  // 必須在載入樂天頁面前註冊，網頁解密 API 回應時才攔截得到
  await page.evaluateOnNewDocument(installRakutenResponseTap);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  guardRakutenDialogs(page);
}

/** 登入等待期間，原生對話框訊息分類出的登入結果（不保存訊息本身）。 */
const rakutenDialogLoginOutcomes = new WeakMap<Page, LoginOutcomeKind>();

/**
 * 原生對話框：alert 只能關閉，一律 accept；confirm／prompt／beforeunload
 * 一律 dismiss，絕不替使用者按「確定」（例如「是否登出其他裝置並繼續？」）。
 * log 只記錄類型、處理方式、訊息長度與分類，不記錄訊息內容。
 */
function guardRakutenDialogs(page: Page) {
  if (rakutenDialogGuardedPages.has(page)) return;
  rakutenDialogGuardedPages.add(page);
  page.on("dialog", (dialog: Dialog) => {
    const type = dialog.type();
    const message = dialog.message();
    const category = classifyRakutenLoginText(message);
    if (category !== "unknown") rakutenDialogLoginOutcomes.set(page, category);
    const action = type === "alert" ? "accepted" : "dismissed";
    const logLine = JSON.stringify({
      event: "rakuten_dialog_handled",
      type,
      action,
      category,
      messageLength: message.length,
    });
    if (action === "accepted") {
      console.log(logLine);
      dialog.accept().catch(() => undefined);
    } else {
      console.warn(logLine);
      dialog.dismiss().catch(() => undefined);
    }
  });
}

async function fillAngularInput(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector, { timeout: 10_000 });
  await withActionTimeout(
    page.evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>(target);
      if (input) {
        input.focus();
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, selector),
  );
  await page.type(selector, value, { delay: 5 });
}

function requireCredentials(config: RakutenConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new RakutenVerificationRequiredError(
      "請填寫身分證字號、使用者代號與登入密碼。",
    );
  }
}

function assertCaptcha(value: string) {
  if (!new RegExp(`^[A-Za-z0-9]{${RAKUTEN_CAPTCHA_LENGTH}}$`).test(value)) {
    throw new RakutenCaptchaRejectedError(
      `樂天驗證碼必須是 ${RAKUTEN_CAPTCHA_LENGTH} 位英數字。`,
    );
  }
}

function normalizeRakutenSyncError(
  error: unknown,
  stage: RakutenSyncStage,
): Error {
  if (
    error instanceof RakutenVerificationRequiredError ||
    error instanceof RakutenBrowserCapacityError ||
    error instanceof BrowserRunCapacityError ||
    error instanceof RakutenConnectionError
  ) {
    return error;
  }
  return new RakutenSyncStageError(stage, error);
}

function safeRuntimeMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : error === null || error === undefined
        ? ""
        : String(error);
  return message
    .replace(
      /\b(authorization|cookie|password|passwd|token|secret|session)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .slice(0, 200);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
