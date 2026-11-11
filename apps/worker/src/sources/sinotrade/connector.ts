import type { Browser, Page, Target } from "@cloudflare/puppeteer";
import type {
  SinotradeVerificationChallenge,
  SinotradeVerificationInput,
} from "@taiwan-fin-hub/shared";
import { taipeiDateKey } from "@taiwan-fin-hub/shared";
import {
  launchBrowserWithRetry,
  connectBrowserWithCancellation,
  closeBrowserSession,
  BrowserSessionCleanupError,
} from "../browser";
import {
  SINOTRADE_ORIGINS,
  SinotradeAuthenticationRequiredError,
  SinotradeConnectionError,
  SinotradeLoginExpiredError,
  SinotradeUnattendedLoginError,
  isSinotradeAuthenticationRequiredError,
  isSinotradeCookie,
  parseSinotradeAccounts,
  parseSavingsAccountIdentities,
  restorableSinotradeState,
  selectSinotradeStorage,
  SINOTRADE_SAVINGS_LOGOUT_SELECTOR,
  type SinotradeConfig,
  type SinotradeOriginState,
  type SinotradePlatform,
  type SinotradeAccount,
} from "./session-protocol";
import {
  applyRealizedPnl,
  parseTaiwanUnrealizedResponse,
  parseForeignUnrealizedResponse,
  parseSavingsAssetHtml,
  parseSavingsTransactionTable,
  parseTaiwanRealizedResponse,
  parseTaiwanStatementResponse,
  realizedDateWindows,
  statementDateRange,
  taiwanRealizedRequestBody,
  taiwanStatementRequestBody,
  taiwanUnrealizedRequestBody,
  type SavingsTransactionTable,
  type SinotradeHolding,
  type SinotradeRealizedRow,
  type SinotradeTrade,
} from "./protocol";
import {
  acknowledgeOfficialDialogs,
  isSinotradeOfficialLoginError,
  readSinotradeVerification,
  submitSinotradeCredentials,
  submitSinotradeVerification,
} from "./login-form";

type Binding = Parameters<typeof launchBrowserWithRetry>[0];
// First-time certificate verification waits on an OTP and the terms. Browser Run bills every
// second a session stays open (keep_alive is an inactivity timeout), so match the other OTP
// flows: five minutes, like Fubon.
const LOGIN_TTL_MS = 5 * 60_000;
// A normal sync takes about 20 seconds; stop and close the browser well before it can spend
// the daily Browser Run quota, like HNCB.
const SYNC_DEADLINE_MS = 120_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOGIN_PATHS = {
  newweb: "/newweb/SinoTrade_login/",
  savings: "/Login",
} as const;
const SAVINGS_OVERVIEW_URL = `${SINOTRADE_ORIGINS.savings}/Account/Overview`;
const SAVINGS_ASSET_URL = `${SINOTRADE_ORIGINS.savings}/Account/Asset`;
const SAVINGS_TRANSACTION_URL = `${SINOTRADE_ORIGINS.savings}/Account/Transaction`;

function savingsPageUrl(page: Page) {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    throw new SinotradeConnectionError("豐存股頁面網址無法辨識，請重新連線。");
  }
  if (url.origin !== SINOTRADE_ORIGINS.savings)
    throw new SinotradeConnectionError("豐存股頁面 origin 不符，請重新連線。");
  return url;
}

function requireSavingsPage(page: Page) {
  const url = savingsPageUrl(page);
  if (
    /^\/Login\/?$/i.test(url.pathname) ||
    url.pathname === "/Content/CA/webcaFrm.html"
  )
    throw new SinotradeAuthenticationRequiredError();
  return url;
}

// 官方 API 防火牆拒絕 Browser Run 的 HeadlessChrome UA，回應沒有 CORS 標頭，頁面只顯示
// 「Network Error」。換成同版本的一般 Chrome UA，與 sec-ch-ua 的版本保持一致。
const desktopUserAgent = async (browser: Browser) =>
  (await browser.userAgent()).replace("HeadlessChrome/", "Chrome/");

/**
 * UA 覆寫只在設定它的 CDP 連線有效，官方另開的憑證視窗也不會繼承。每次連上 Browser 都對
 * 現有頁面重新套用，並套用到之後開啟的頁面。
 */
async function useDesktopUserAgent(browser: Browser) {
  const userAgent = await desktopUserAgent(browser);
  const apply = async (page: Page | null) => {
    await page?.setUserAgent(userAgent).catch(() => undefined);
  };
  browser.on("targetcreated", (target: Target) => {
    void target.page().then(apply, () => undefined);
  });
  await Promise.all((await browser.pages()).map(apply));
}

async function restoreOrigin(
  page: Page,
  platform: SinotradePlatform,
  state?: SinotradeOriginState,
  preserveSharedCookies = false,
) {
  const origin = SINOTRADE_ORIGINS[platform];
  // 導覽前直接設定，不等待 targetcreated 的非同步套用。
  await page.setUserAgent(await desktopUserAgent(page.browser()));
  if (state) {
    const cookies = state.cookies.filter(
      (cookie) =>
        isSinotradeCookie(platform, cookie) &&
        !(
          preserveSharedCookies &&
          cookie.domain.replace(/^\./, "") === "sinotrade.com.tw"
        ),
    );
    if (cookies.length) await page.setCookie(...cookies);
    const storage = selectSinotradeStorage(platform, state.localStorage);
    const preload = await page.evaluateOnNewDocument(
      (expectedOrigin, items) => {
        if (location.origin !== expectedOrigin) return;
        for (const [key, value] of Object.entries(items))
          localStorage.setItem(key, value);
      },
      origin,
      storage,
    );
    await page.goto(origin + LOGIN_PATHS[platform], {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.removeScriptToEvaluateOnNewDocument(preload.identifier);
  } else
    await page.goto(origin + LOGIN_PATHS[platform], {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
}

async function captureOrigin(
  page: Page,
  platform: SinotradePlatform,
): Promise<SinotradeOriginState> {
  if (new URL(page.url()).origin !== SINOTRADE_ORIGINS[platform])
    throw new SinotradeConnectionError();
  // Only allowlisted keys leave the page; never enumerate/export the full profile.
  const storage = await page.evaluate((selectedPlatform) => {
    const result: Record<string, string> = {};
    const keys =
      selectedPlatform === "newweb"
        ? ["newweb_token", "acnts", "userID", "TWCACertIdxRef"]
        : ["TWCACertIdxRef"];
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value) result[key] = value;
    }
    if (result.TWCACertIdxRef) {
      let index: unknown;
      try {
        index = JSON.parse(result.TWCACertIdxRef);
      } catch {
        return result;
      }
      if (index && typeof index === "object" && !Array.isArray(index))
        for (const key of Object.keys(index)) {
          if (/^TWCA\d+$/.test(key)) {
            const value = localStorage.getItem(key);
            if (value) result[key] = value;
          }
        }
    }
    return result;
  }, platform);
  const urls =
    platform === "newweb"
      ? [SINOTRADE_ORIGINS.newweb, "https://service.sinotrade.com.tw"]
      : [SINOTRADE_ORIGINS.savings];
  const cookies = (await page.cookies(...urls)).filter((cookie) =>
    isSinotradeCookie(platform, cookie),
  );
  return {
    authenticated: true,
    cookies,
    localStorage: selectSinotradeStorage(platform, storage),
    capturedAt: new Date().toISOString(),
  };
}

export async function prepareSinotradeLogin(
  binding: Binding,
  config: SinotradeConfig,
  platform: SinotradePlatform,
) {
  if (
    config.browserSessionId &&
    Date.parse(config.browserSessionExpiresAt ?? "") > Date.now()
  )
    throw new SinotradeConnectionError(
      "已有登入驗證等待完成，請先完成或取消。",
    );
  const browser = await launchBrowserWithRetry(binding, {
    keep_alive: LOGIN_TTL_MS,
  });
  let retained = false;
  acknowledgeOfficialDialogs(browser);
  try {
    await useDesktopUserAgent(browser);
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768 });
    await restoreOrigin(
      page,
      platform,
      restorableSinotradeState(config.webState, platform),
    );
    const challenge = await submitSinotradeCredentials(
      browser,
      platform,
      config,
    );
    // Nothing can follow an official error (e.g. service paused): close the browser now
    // instead of keeping it alive for the whole login TTL.
    if (isSinotradeOfficialLoginError(challenge))
      throw new SinotradeConnectionError(challenge.message);
    retained = true;
    return {
      platform,
      challenge,
      expiresAt: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
      browserSessionId: browser.sessionId(),
    };
  } finally {
    if (retained) await browser.disconnect();
    else await closeBrowserSession(binding, browser);
  }
}

async function withPendingLogin<T>(
  binding: Binding,
  config: SinotradeConfig,
  task: (browser: Browser, platform: SinotradePlatform) => Promise<T>,
) {
  if (
    !config.browserSessionId ||
    !config.loginPlatform ||
    !(Date.parse(config.browserSessionExpiresAt ?? "") > Date.now())
  )
    throw new SinotradeLoginExpiredError();
  const browser = await connectBrowserWithCancellation(
    binding,
    config.browserSessionId,
  ).catch(() => {
    throw new SinotradeLoginExpiredError();
  });
  acknowledgeOfficialDialogs(browser);
  try {
    await useDesktopUserAgent(browser);
    return await task(browser, config.loginPlatform);
  } finally {
    await browser.disconnect();
  }
}

export function readSinotradeLoginChallenge(
  binding: Binding,
  config: SinotradeConfig,
) {
  return withPendingLogin(binding, config, readSinotradeVerification);
}

export function verifySinotradeLogin(
  binding: Binding,
  config: SinotradeConfig,
  input: SinotradeVerificationInput,
) {
  return withPendingLogin(binding, config, (browser, platform) =>
    submitSinotradeVerification(browser, platform, input, config),
  );
}

/**
 * The state of the pending login page once it holds an issued certificate. Issuing one costs
 * an OTP, so it is kept before anything else can fail; null while no certificate is stored.
 */
export function captureSinotradeIssuedState(
  binding: Binding,
  config: SinotradeConfig,
) {
  return withPendingLogin(binding, config, async (browser, platform) => {
    const page = (await browser.pages())
      .filter((page) =>
        page.url().startsWith(SINOTRADE_ORIGINS[platform] + "/"),
      )
      .at(-1);
    if (!page) return null;
    const state = await captureOrigin(page, platform);
    return state.localStorage.TWCACertIdxRef ? state : null;
  });
}

export async function closeSinotradeLogin(
  binding: Binding,
  config: SinotradeConfig,
) {
  if (!config.browserSessionId) return;
  let browser: Browser;
  try {
    browser = await connectBrowserWithCancellation(
      binding,
      config.browserSessionId,
    );
  } catch {
    return;
  }
  if (!(await closeBrowserSession(binding, browser)))
    throw new BrowserSessionCleanupError();
}

export async function completeSinotradeLogin(
  binding: Binding,
  config: SinotradeConfig,
): Promise<{
  webState: NonNullable<SinotradeConfig["webState"]>;
  pending?: {
    platform: SinotradePlatform;
    browserSessionId: string;
    challenge: SinotradeVerificationChallenge;
    expiresAt: string;
  };
}> {
  if (
    !config.browserSessionId ||
    !config.loginPlatform ||
    !(Date.parse(config.browserSessionExpiresAt ?? "") > Date.now())
  )
    throw new SinotradeLoginExpiredError();
  const browser = await connectBrowserWithCancellation(
    binding,
    config.browserSessionId,
  ).catch(() => {
    throw new SinotradeLoginExpiredError();
  });
  acknowledgeOfficialDialogs(browser);
  let closed = false;
  try {
    await useDesktopUserAgent(browser);
    const platform = config.loginPlatform;
    const page = (await browser.pages())
      .filter((page) =>
        page.url().startsWith(SINOTRADE_ORIGINS[platform] + "/"),
      )
      .at(-1);
    if (!page) throw new SinotradeLoginExpiredError();
    if (platform === "newweb") await verifyNewwebSession(page);
    else {
      await readSinotradeSavingsOverview(page);
      if (!(await page.$(SINOTRADE_SAVINGS_LOGOUT_SELECTOR)))
        throw new SinotradeConnectionError(
          "豐存股尚未登入完成，請在連線表單完成驗證。",
        );
    }
    const state = await captureOrigin(page, platform);
    const webState = { ...config.webState, [platform]: state };
    const otherPlatform = platform === "newweb" ? "savings" : "newweb";
    const otherPage = await browser.newPage();
    await otherPage.setViewport({ width: 1024, height: 768 });
    await restoreOrigin(
      otherPage,
      otherPlatform,
      restorableSinotradeState(webState, otherPlatform),
      true,
    );
    try {
      if (otherPlatform === "newweb") await verifyNewwebSession(otherPage);
      else await readSinotradeSavingsOverview(otherPage);
      webState[otherPlatform] = await captureOrigin(otherPage, otherPlatform);
    } catch (error) {
      if (!isSinotradeAuthenticationRequiredError(error)) throw error;
      const previousState = config.webState?.[otherPlatform];
      if (previousState)
        webState[otherPlatform] = { ...previousState, authenticated: false };
      await restoreOrigin(
        otherPage,
        otherPlatform,
        restorableSinotradeState(webState, otherPlatform),
        true,
      );
      const challenge = await submitSinotradeCredentials(
        browser,
        otherPlatform,
        config,
      );
      return {
        webState,
        pending: {
          platform: otherPlatform,
          challenge,
          expiresAt: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
          browserSessionId: browser.sessionId(),
        },
      };
    }
    closed = await closeBrowserSession(binding, browser);
    if (!closed) throw new BrowserSessionCleanupError();
    return { webState };
  } finally {
    if (!closed) await browser.disconnect();
  }
}

export async function readSinotradeNewwebSession(page: Page) {
  const session = await page.evaluate(() => ({
    token: localStorage.getItem("newweb_token"),
    accounts: localStorage.getItem("acnts"),
  }));
  if (!session.token)
    throw new SinotradeAuthenticationRequiredError(
      "新理財網登入已失效，請在連線表單重新完成驗證。",
    );
  if (!session.accounts)
    throw new SinotradeConnectionError(
      "新理財網登入資料格式錯誤，請重新連線。",
    );
  let accounts: unknown;
  try {
    accounts = JSON.parse(session.accounts);
  } catch {
    throw new SinotradeConnectionError();
  }
  return { token: session.token, accounts: parseSinotradeAccounts(accounts) };
}

async function verifyNewwebSession(page: Page) {
  const session = await readSinotradeNewwebSession(page);
  const account = session.accounts[0]!;
  const payload = await requestGeneral(page, account, session.token);
  const result =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const nested = result.result as
    { status?: { success?: unknown } } | undefined;
  const authenticated =
    account.market === "TW"
      ? result.success === "True"
      : result.success === true && nested?.status?.success === true;
  if (!authenticated)
    throw new SinotradeConnectionError(
      "新理財網登入尚未生效，請完成連線驗證。",
    );
  return session;
}

const UNATTENDED_STEP_DETAILS = {
  certificate: "官方要求確認憑證",
  birthday: "官方要求驗證生日",
  otp: "官方要求 OTP 驗證",
  terms: "官方要求同意憑證作業條款",
} as const;

/**
 * 同步中的無人值守登入：只送出已儲存的帳密一次，並載入已儲存的憑證（與連線表單自動接續的
 * 範圍相同）。生日、OTP、條款或被官方拒絕都是使用者的決定，一律停止，不寄送、不勾選、不重試。
 */
export async function signInSinotradeUnattended(
  browser: Browser,
  platform: SinotradePlatform,
  config: SinotradeConfig,
) {
  const startedAt = Date.now();
  let challenge = await submitSinotradeCredentials(browser, platform, config);
  if (
    challenge.step === "certificate" &&
    challenge.fields.length === 0 &&
    challenge.actions.length === 1 &&
    challenge.actions[0] === "confirm_certificate"
  )
    challenge = await submitSinotradeVerification(
      browser,
      platform,
      { action: "confirm_certificate", values: {} },
      config,
    );
  // 只記平台、停下的步驟與耗時；不記帳號、頁面文字或官方訊息。
  console.log(
    JSON.stringify({
      event: "sinotrade_session_relogin",
      platform,
      step: challenge.step,
      durationMs: Date.now() - startedAt,
    }),
  );
  if (challenge.step === "ready") return;
  throw new SinotradeUnattendedLoginError(
    platform,
    challenge.step,
    challenge.step === "blocked"
      ? challenge.message?.replace(/[。.]+$/, "")
      : UNATTENDED_STEP_DETAILS[challenge.step],
  );
}

/**
 * 官方明確回應未登入時，在同一個 Browser 以已儲存的帳密與憑證重新登入一次再檢查；其他錯誤
 * （403、5xx、格式不符）不重送帳密。
 */
async function withSessionRelogin<T>(
  page: Page,
  platform: SinotradePlatform,
  config: SinotradeConfig,
  check: () => Promise<T>,
): Promise<{ value: T; relogged: boolean }> {
  try {
    return { value: await check(), relogged: false };
  } catch (error) {
    if (!isSinotradeAuthenticationRequiredError(error)) throw error;
  }
  const browser = page.browser();
  acknowledgeOfficialDialogs(browser);
  await useDesktopUserAgent(browser);
  await page.setViewport({ width: 1024, height: 768 });
  // 過期的 token 仍在 localStorage 時，登入頁會被判讀成已登入；先移除，憑證項目保留。
  if (platform === "newweb")
    await page.evaluate((origin) => {
      if (location.origin !== origin) return;
      for (const key of ["newweb_token", "acnts", "userID"])
        localStorage.removeItem(key);
    }, SINOTRADE_ORIGINS.newweb);
  await page.goto(SINOTRADE_ORIGINS[platform] + LOGIN_PATHS[platform], {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await signInSinotradeUnattended(browser, platform, config);
  try {
    return { value: await check(), relogged: true };
  } catch (error) {
    if (!isSinotradeAuthenticationRequiredError(error)) throw error;
    throw new SinotradeUnattendedLoginError(
      platform,
      "not_authenticated",
      "登入後官方仍回應未登入",
    );
  }
}

export async function readSinotradeSavingsOverview(page: Page) {
  const controller = new AbortController();
  // 剛登入時，登入後頁面自己發出的總覽請求可能還在途中，會被這次導覽取消而讀不到內容。
  // 不論回應到達的先後，只採用內容讀得到的回應，讀不到的略過並繼續等。
  const bodies = new WeakMap<object, string>();
  try {
    const [response] = await Promise.all([
      page.waitForResponse(
        async (response) => {
          const url = new URL(response.url());
          if (
            url.origin !== SINOTRADE_ORIGINS.savings ||
            url.pathname !== "/API_Account/GetOverviewData"
          )
            return false;
          if (!response.ok()) return true;
          try {
            bodies.set(response, await response.text());
            return true;
          } catch {
            return false;
          }
        },
        { timeout: NAVIGATION_TIMEOUT_MS, signal: controller.signal },
      ),
      page
        .goto(SAVINGS_OVERVIEW_URL, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        })
        .then(async (navigation) => {
          const url = requireSavingsPage(page);
          if (navigation?.status() === 401)
            throw new SinotradeAuthenticationRequiredError();
          if (!/^\/Account\/Overview\/?$/i.test(url.pathname))
            throw new SinotradeConnectionError(
              "豐存股總覽頁面網址不符，請重新連線。",
            );
          if (!(await page.$(SINOTRADE_SAVINGS_LOGOUT_SELECTOR)))
            throw new SinotradeConnectionError(
              "豐存股還需要完成官方登入確認。",
            );
        }),
    ]);
    requireSavingsPage(page);
    if (!response.ok())
      throw response.status() === 401
        ? new SinotradeAuthenticationRequiredError()
        : new SinotradeConnectionError("豐存股帳戶總覽查詢失敗，請重新連線。");
    let payload: unknown;
    try {
      payload = JSON.parse(bodies.get(response) ?? "");
    } catch {
      throw new SinotradeConnectionError(
        "豐存股帳戶總覽格式錯誤，請重新連線。",
      );
    }
    return parseSavingsAccountIdentities(payload);
  } finally {
    controller.abort();
  }
}

/** POSTs to the new site's service API as the logged-in page does. `basic` adds its public client header. */
async function requestNewweb(
  page: Page,
  request: { path: string; body: unknown; basic: boolean },
  label: string,
): Promise<unknown> {
  const response = await page.evaluate(
    async ({ url, body, basic, timeoutMs }) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      // Public website client identifier from the official CRYL bundle, not user credentials.
      if (basic) headers.Authorization = "Basic " + btoa("nweb:Nweb123");
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        credentials: basic ? "omit" : "include",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { httpStatus: response.status, payload: null };
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { httpStatus: 502, payload: null };
      }
      return {
        httpStatus: response.status,
        payload,
      };
    },
    {
      url: "https://service.sinotrade.com.tw" + request.path,
      body: request.body,
      basic: request.basic,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );
  if (response.httpStatus === 401)
    throw new SinotradeAuthenticationRequiredError();
  if (response.httpStatus === 403) throw new SinotradeConnectionError();
  if (response.httpStatus !== 200)
    throw new Error(
      `${label}查詢失敗（HTTP ${response.httpStatus}），未更新持倉。`,
    );
  return response.payload;
}

function requestGeneral(
  page: Page,
  account: SinotradeAccount,
  token: string,
): Promise<unknown> {
  return requestNewweb(
    page,
    account.market === "TW"
      ? {
          path: "/api/v1/Equity/UnRealPrtlos",
          body: taiwanUnrealizedRequestBody(account, token),
          basic: true,
        }
      : {
          path: "/divo/api/v1/assets/querySubBrokerageUnrealizedPrtLos",
          body: {
            account: account.brokerAccount,
            branch: account.brokerNo,
            market: "US",
            stock_id: "",
            token,
          },
          basic: false,
        },
    "證券庫存",
  );
}

async function queryGeneral(
  page: Page,
  account: SinotradeAccount,
  token: string,
): Promise<SinotradeHolding[]> {
  const payload = await requestGeneral(page, account, token);
  return account.market === "TW"
    ? parseTaiwanUnrealizedResponse(payload)
    : parseForeignUnrealizedResponse(payload);
}

/**
 * 新理財網「交易紀錄 → 對帳單」：台股現股的完整買賣、手續費與交易稅，官方只提供近五年；
 * 賣出再對上「庫存損益 → 已實現」的官方損益。
 */
async function queryTaiwanTrades(
  page: Page,
  account: SinotradeAccount,
  token: string,
  range: { start: string; end: string },
): Promise<SinotradeTrade[]> {
  const trades = parseTaiwanStatementResponse(
    await requestNewweb(
      page,
      {
        path: "/api/v1/Equity/ReconciliationStatement",
        body: taiwanStatementRequestBody(account, token, range),
        basic: true,
      },
      "證券交易紀錄",
    ),
  );
  const windows = realizedDateWindows(
    trades
      .filter((trade) => trade.side === "S")
      .map((trade) => trade.tradeDate),
  );
  if (windows.length === 0) return trades;
  const realized: SinotradeRealizedRow[] = [];
  for (const window of windows)
    realized.push(
      ...parseTaiwanRealizedResponse(
        await requestNewweb(
          page,
          {
            path: "/api/v1/Equity/RealPrtlosSum",
            body: taiwanRealizedRequestBody(account, token, window),
            basic: true,
          },
          "已實現損益",
        ),
      ),
    );
  return applyRealizedPnl(trades, realized);
}

/**
 * 豐存股「成交」頁：新理財網的海外複委託對帳單沒有豐存美股的買進，這裡是唯一來源。
 * 與總覽卡片相同，以 #form1 的 CSRF token 與帳號 POST，並放寬日期區間。
 */
export async function querySinotradeSavingsTrades(
  page: Page,
  account: SinotradeAccount,
  dateRange: string,
): Promise<SinotradeTrade[]> {
  requireSavingsPage(page);
  const result = await page.evaluate(
    async ({
      accountValue,
      expectedOrigin,
      url,
      dateRange,
      timeoutMs,
    }): Promise<{
      status: number;
      recognized?: boolean;
      table?: SavingsTransactionTable | null;
    }> => {
      if (location.origin !== expectedOrigin) return { status: 0 };
      const csrf = (
        document.querySelector(
          '#form1 input[name="__RequestVerificationToken"]',
        ) as HTMLInputElement | null
      )?.value;
      if (!csrf) return { status: 0 };
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        credentials: "same-origin",
        body: new URLSearchParams({
          __RequestVerificationToken: csrf,
          SelectAct: accountValue,
          QueryPage: "1",
          QueryDateRange: dateRange,
          ShowCurrency: "False",
          Stock: "",
          QueryAssetCategories: "",
          QueryFilter: "",
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { status: response.status };
      const doc = new DOMParser().parseFromString(
        await response.text(),
        "text/html",
      );
      const clean = (element: Element) =>
        (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const table = Array.from(doc.querySelectorAll("table")).find(
        (candidate) =>
          /成交日/.test(candidate.textContent ?? "") &&
          /成交均價/.test(candidate.textContent ?? ""),
      );
      return {
        status: response.status,
        // 沒有成交時沒有成交表格；查詢表單在，才表示頁面確實是成交頁。
        recognized: Boolean(doc.querySelector("#QueryDateRange")),
        table: table
          ? {
              headers: Array.from(table.querySelectorAll("thead th"), clean),
              rows: Array.from(table.querySelectorAll("tbody tr"), (row) =>
                Array.from(row.children, clean),
              ),
            }
          : null,
      };
    },
    {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: SAVINGS_TRANSACTION_URL,
      dateRange,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );
  requireSavingsPage(page);
  if (result.status === 401) throw new SinotradeAuthenticationRequiredError();
  if (result.status !== 200 || !result.recognized)
    throw new SinotradeConnectionError("豐存股成交紀錄查詢失敗，請重新連線。");
  return parseSavingsTransactionTable(result.table ?? null, {
    market: account.market,
    currency: account.market === "TW" ? "TWD" : "USD",
  });
}

export async function querySinotradeSavings(
  page: Page,
  account: SinotradeAccount,
) {
  requireSavingsPage(page);
  const result = await page.evaluate(
    async ({ accountValue, expectedOrigin, url, timeoutMs }) => {
      if (location.origin !== expectedOrigin) return { status: 0, html: null };
      // The overview's account cards submit this form with the account number.
      const csrf = (
        document.querySelector(
          '#form1 input[name="__RequestVerificationToken"]',
        ) as HTMLInputElement | null
      )?.value;
      if (!csrf) return { status: 0, html: null };
      const data = new URLSearchParams({
        __RequestVerificationToken: csrf,
        SelectAct: accountValue,
      });
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        credentials: "same-origin",
        body: data,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { status: response.status, html: null };
      return { status: response.status, html: await response.text() };
    },
    {
      accountValue: account.brokerAccount,
      expectedOrigin: SINOTRADE_ORIGINS.savings,
      url: SAVINGS_ASSET_URL,
      timeoutMs: REQUEST_TIMEOUT_MS,
    },
  );
  requireSavingsPage(page);
  if (result.status === 401) throw new SinotradeAuthenticationRequiredError();
  if (!result.html)
    throw new SinotradeConnectionError("豐存股庫存查詢失敗，請重新連線。");
  return parseSavingsAssetHtml(result.html, {
    market: account.market,
    currency: account.market === "TW" ? "TWD" : "USD",
  });
}

/** One account's snapshots are alternatives; differing quantities must never be guessed or added. */
export function mergeSinotradeAccountHoldings(
  general: SinotradeHolding[],
  savings: SinotradeHolding[],
) {
  const positions = new Map<string, SinotradeHolding>();
  for (const row of general) {
    const previous = positions.get(row.symbol);
    if (previous)
      positions.set(row.symbol, {
        ...previous,
        quantity: previous.quantity + row.quantity,
        marketValue: previous.marketValue + row.marketValue,
        costBasis:
          previous.costBasis === undefined || row.costBasis === undefined
            ? undefined
            : previous.costBasis + row.costBasis,
        unrealizedPnl:
          previous.unrealizedPnl === undefined ||
          row.unrealizedPnl === undefined
            ? undefined
            : previous.unrealizedPnl + row.unrealizedPnl,
      });
    else positions.set(row.symbol, row);
  }
  for (const row of savings) {
    const previous = positions.get(row.symbol);
    if (
      previous &&
      (previous.market !== row.market || previous.currency !== row.currency)
    )
      throw new Error("兩平台的同一持倉市場或幣別不一致，未更新持倉。");
    if (previous && Math.abs(previous.quantity - row.quantity) > 1e-8)
      throw new Error("兩平台的同一持倉數量不一致，請稍後重新同步。");
    if (
      previous &&
      row.market === "US" &&
      previous.costBasis !== undefined &&
      row.costBasis !== undefined &&
      Math.abs(previous.costBasis - row.costBasis) > 0.01
    )
      throw new Error(
        "兩平台的同一美股成本不一致，尚無法確認重疊範圍，未更新持倉。",
      );
    if (!previous) positions.set(row.symbol, row);
  }
  return [...positions.values()];
}

export async function fetchSinotradeSnapshot(
  binding: Binding,
  config: SinotradeConfig,
) {
  if (
    !config.webState?.newweb ||
    !config.webState.savings ||
    config.webState.newweb.authenticated === false ||
    config.webState.savings.authenticated === false
  )
    throw new SinotradeConnectionError();
  if (
    config.browserSessionId &&
    Date.parse(config.browserSessionExpiresAt ?? "") > Date.now()
  )
    throw new SinotradeConnectionError(
      "請先完成或取消目前的登入驗證，再同步。",
    );
  const browser = await launchBrowserWithRetry(binding);
  const work = collectSnapshot(browser, config);
  // A step still waiting at the deadline fails once the browser closes; nobody awaits it then.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SinotradeSyncTimeoutError()),
          SYNC_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await closeBrowserSession(binding, browser);
  }
}

class SinotradeSyncTimeoutError extends Error {
  constructor() {
    super(
      `永豐證券同步超過 ${SYNC_DEADLINE_MS / 1000} 秒，已停止並關閉瀏覽器，請稍後再試。`,
    );
    this.name = "SinotradeSyncTimeoutError";
  }
}

async function collectSnapshot(browser: Browser, config: SinotradeConfig) {
  // 兩個平台都先確認官方仍認得保存的登入，失效就重新登入，之後才查詢。
  const newweb = await browser.newPage();
  await restoreOrigin(
    newweb,
    "newweb",
    restorableSinotradeState(config.webState, "newweb"),
  );
  const {
    value: { accounts, token },
    relogged,
  } = await withSessionRelogin(newweb, "newweb", config, () =>
    verifyNewwebSession(newweb),
  );
  const savings = await browser.newPage();
  // 剛重新登入時保留新取得的父網域 cookie，不被保存的舊值覆寫。
  await restoreOrigin(
    savings,
    "savings",
    restorableSinotradeState(config.webState, "savings"),
    relogged,
  );
  const { value: savingsAccounts } = await withSessionRelogin(
    savings,
    "savings",
    config,
    async () => {
      const identities = await readSinotradeSavingsOverview(savings);
      if (!(await savings.$(SINOTRADE_SAVINGS_LOGOUT_SELECTOR)))
        throw new SinotradeConnectionError();
      return identities;
    },
  );
  const accountHoldings: Array<{
    account: SinotradeAccount;
    holdings: SinotradeHolding[];
    trades: SinotradeTrade[];
  }> = [];
  const today = taipeiDateKey(new Date());
  const statementRange = statementDateRange(today);
  // 豐存股不限查詢年限；從最早的年份起查，取得全部買進紀錄。
  const savingsDateRange = `2000/01/01 ~ ${today.replaceAll("-", "/")}`;
  for (const account of accounts) {
    if (
      !savingsAccounts.some(
        (savingsAccount) =>
          savingsAccount.brokerNo === account.brokerNo &&
          savingsAccount.brokerAccount === account.brokerAccount &&
          savingsAccount.market === account.market,
      )
    )
      throw new Error("兩平台的券商分公司與帳戶無法對應，未更新持倉。");
    const general = await queryGeneral(newweb, account, token);
    const recurring = await querySinotradeSavings(savings, account);
    // 台股以對帳單為準（含賣出與費稅）；豐存美股的買進只在豐存股「成交」頁。
    const trades =
      account.market === "TW"
        ? await queryTaiwanTrades(newweb, account, token, statementRange)
        : await querySinotradeSavingsTrades(savings, account, savingsDateRange);
    accountHoldings.push({
      account,
      holdings: mergeSinotradeAccountHoldings(general, recurring),
      trades,
    });
  }
  return {
    accountHoldings,
    webState: {
      newweb: await captureOrigin(newweb, "newweb"),
      savings: await captureOrigin(savings, "savings"),
    },
  };
}
