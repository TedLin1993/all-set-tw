import puppeteer, {
  type Browser,
  type Dialog,
  type Page,
} from "@cloudflare/puppeteer";
import { decode as decodeJpeg } from "jpeg-js";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
  SyncResult,
} from "@taiwan-fin-hub/core";
import {
  BANK_SYNC_MONTHS,
  type SinopacConfig,
} from "@taiwan-fin-hub/connectors";

const MOBILE_HOST = "https://m.sinopac.com";
const LOGIN_URL = `${MOBILE_HOST}/m/member/login/m_login.aspx?RequestTrans=MobileCard`;
const CARD_SUMMARY_PATH = "/ws/card/cardqry/ws_cardsum.ashx";
const CARD_BILLS_PATH = "/ws/card/cardqry/ws_cardbilling_sp.ashx";
const CARD_SSO_PATH = "/m/SinoCard/api/security/sso";
const CARD_AUTH_PATH = "/m/SinoCard/api/security/auth";
const CARD_LATEST_TX_PATH = "/m/SinoCard/api/Accounting/LatestTx";
const CARD_OUTSTANDING_DETAIL_PATH =
  "/m/SinoCard/api/Accounting/OutstandingDetail";
export const SINOPAC_SESSION_PROTOCOL = "sinopac-mobile-app-json-v1";
export const SINOPAC_AUTO_LOGIN_ATTEMPTS = 3;
const CAPTCHA_BROWSER_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231105.003) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

type JsonRecord = Record<string, unknown>;
type FetchImpl = typeof fetch;
type SinopacApiPayloads = {
  summary: unknown;
  bills: unknown;
  hasValidCard?: boolean;
  latest?: unknown;
  outstanding?: unknown;
  unbilled?: unknown;
};
type Scraped = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

export class SinopacVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinopacVerificationRequiredError";
  }
}

export class SinopacCaptchaRejectedError extends SinopacVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "SinopacCaptchaRejectedError";
  }
}

export class SinopacCredentialRejectedError extends SinopacVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "SinopacCredentialRejectedError";
  }
}

export class SinopacBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "SinopacBrowserCapacityError";
  }
}

export function createSinopacConnector(
  browser?: Fetcher,
  fetchImpl: FetchImpl = fetch,
) {
  return {
    id: "sinopac" as const,
    name: "永豐銀行行動銀行",

    async sync(
      config: SinopacConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      let sessionCookies = config.sessionCookies;
      let browserInstance: Browser | undefined;
      let verifiedThisRun = false;

      if (config.browserSessionId && config.captcha) {
        if (!browser) throw new Error("永豐首次驗證需要 BROWSER binding。");
        if (
          !config.browserSessionExpiresAt ||
          new Date(config.browserSessionExpiresAt) <= new Date()
        ) {
          throw new SinopacVerificationRequiredError(
            "永豐圖形驗證碼已逾時，請重新取得驗證碼。",
          );
        }
        try {
          browserInstance = await puppeteer.connect(
            browser,
            config.browserSessionId,
          );
        } catch {
          throw new SinopacVerificationRequiredError(
            "永豐登入工作階段已失效，請重新取得圖形驗證碼。",
          );
        }
        try {
          const pages = await browserInstance.pages();
          const page =
            pages.find((candidate) =>
              candidate.url().includes("/m/member/login/m_login.aspx"),
            ) ?? pages[0];
          if (!page) {
            throw new SinopacVerificationRequiredError(
              "永豐登入工作階段沒有可用頁面，請重新取得圖形驗證碼。",
            );
          }
          await submitLogin(page, config.captcha);
          sessionCookies = JSON.stringify(await page.cookies());
          verifiedThisRun = true;
        } finally {
          await browserInstance.close();
        }
      }

      if (!sessionCookies) {
        throw new SinopacVerificationRequiredError(
          "永豐同步需要先完成一次圖形驗證。",
        );
      }
      if (!verifiedThisRun && config.protocol !== SINOPAC_SESSION_PROTOCOL) {
        throw new SinopacVerificationRequiredError(
          "永豐連接器已改用行動銀行 App JSON API，請重新完成一次圖形驗證。",
        );
      }

      if (!config.userId) {
        throw new SinopacVerificationRequiredError(
          "永豐最新消費同步需要重新登入以取得身分識別資料。",
        );
      }
      const client = new SinopacAppClient(
        sessionCookies,
        config.userId,
        fetchImpl,
      );
      const payloads = await client.fetchCreditCards();
      const cards = parseSinopacCardData(payloads);
      const now = new Date();

      return {
        records: [],
        ...cards,
        cursor: JSON.stringify({
          sessionCookies,
          protocol: SINOPAC_SESSION_PROTOCOL,
          syncedAt: now.toISOString(),
        }),
      };
    },
  };
}

class SinopacAppClient {
  private readonly cookieHeader: string;
  private readonly sinoCardCookies: Map<string, string>;

  constructor(
    serializedCookies: string,
    private readonly userId: string,
    private readonly fetchImpl: FetchImpl,
  ) {
    this.cookieHeader = cookieHeaderFromSerialized(serializedCookies);
    this.sinoCardCookies = cookieMapFromHeader(this.cookieHeader);
  }

  fetchSummary() {
    return this.post(CARD_SUMMARY_PATH, "信用卡總覽");
  }

  async fetchCreditCards(): Promise<SinopacApiPayloads> {
    const summary = await this.fetchSummary();
    const initialBills = await this.post(
      `${CARD_BILLS_PATH}?TxDate=default&TxType=01`,
      "近期帳單",
    );
    const billMonths = extractAdvertisedBillMonths(initialBills).slice(
      1,
      BANK_SYNC_MONTHS,
    );
    const olderBills = [];
    for (const month of billMonths) {
      olderBills.push(
        await this.post(
          `${CARD_BILLS_PATH}?TxDate=${month}&TxType=01`,
          `${month} 帳單`,
        ),
      );
    }
    const sso = await this.postSinoCard(CARD_SSO_PATH, "信用卡單一登入", {});
    const customerId = sinoCardCustomerId(sso) ?? this.userId;
    await this.postSinoCard(CARD_AUTH_PATH, "信用卡授權", {}, customerId);
    const latest = await this.postSinoCard(
      CARD_LATEST_TX_PATH,
      "最新消費",
      { ID: customerId },
      customerId,
    );
    if (latest == null) {
      return {
        summary,
        bills: [initialBills, ...olderBills],
        hasValidCard: false,
      };
    }
    const outstanding = await this.postSinoCard(
      CARD_OUTSTANDING_DETAIL_PATH,
      "已請款消費明細",
      { IsExcludePaidUp: false, ID: customerId, DateYYYYMMDD: "" },
      customerId,
    );
    return {
      summary,
      bills: [initialBills, ...olderBills],
      latest,
      outstanding,
    };
  }

  private async post(path: string, label: string) {
    const response = await this.fetchImpl.call(
      globalThis,
      `${MOBILE_HOST}${path}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: this.cookieHeader,
          Referer: `${MOBILE_HOST}/m/m_home.aspx`,
          "User-Agent": ANDROID_USER_AGENT,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: "",
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`永豐${label} API 回應 HTTP ${response.status}。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (/m_login|尚未登入|登入\/Login/i.test(text)) {
        throw new SinopacVerificationRequiredError(
          "永豐銀行 session 已失效，請重新完成圖形驗證。",
        );
      }
      throw new Error(`永豐${label} API 回應不是有效 JSON。`);
    }
    assertSinopacApiSuccess(payload, label);
    return payload;
  }

  private async postSinoCard(
    path: string,
    label: string,
    content: JsonRecord,
    userId = this.userId,
  ) {
    const response = await this.fetchImpl.call(
      globalThis,
      `${MOBILE_HOST}${path}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Cookie: cookieHeaderFromMap(this.sinoCardCookies),
          Referer: `${MOBILE_HOST}/m/SinoCard/Account/UnbilledTxInquiry`,
          "User-Agent": ANDROID_USER_AGENT,
        },
        body: JSON.stringify({
          Content: content,
          Header: {
            ApplicationName: "MWEB",
            UserID: userId,
            ClientRefNo: crypto.randomUUID().replaceAll("-", ""),
            ClientTimestamp: new Date().toISOString(),
          },
        }),
      },
    );
    storeSetCookies(this.sinoCardCookies, response.headers);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`永豐${label} API 回應 HTTP ${response.status}。`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (/m_login|尚未登入|登入\/Login/i.test(text)) {
        throw new SinopacVerificationRequiredError(
          "永豐銀行 session 已失效，請重新完成圖形驗證。",
        );
      }
      throw new Error(`永豐${label} API 回應不是有效 JSON。`);
    }
    if (
      path === CARD_LATEST_TX_PATH &&
      isRecord(payload) &&
      stringValue(payload.ResultMessage) === "您沒有有效卡"
    ) {
      return undefined;
    }
    assertSinoCardApiSuccess(payload, label);
    return payload;
  }
}

export async function prepareSinopacCaptcha(
  browser: Fetcher | undefined,
  config: SinopacConfig,
) {
  if (!config.userId || !config.account || !config.password) {
    throw new Error("請先儲存永豐身分證字號／統編、使用者代碼與網路密碼。");
  }
  if (!browser) throw new Error("永豐首次驗證需要 BROWSER binding。");

  const browserInstance = await getCaptchaBrowser(
    browser,
    config.browserSessionId,
  );
  const pages = await browserInstance.pages();
  const page =
    pages.find((candidate) =>
      candidate.url().includes("/m/member/login/m_login.aspx"),
    ) ??
    pages[0] ??
    (await browserInstance.newPage());
  let preserved = false;
  try {
    await configurePage(page);
    await openLoginAndFill(page, config);
    const bytes = await captureSinopacCaptcha(page);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
    };
  } finally {
    if (!preserved) await browserInstance.close();
  }
}

export async function loginSinopacWithOcr(
  browser: Fetcher | undefined,
  config: SinopacConfig,
  recognizeCaptcha: (imageBytes: ArrayBuffer) => Promise<string>,
): Promise<{
  sessionCookies: string;
  protocol: typeof SINOPAC_SESSION_PROTOCOL;
}> {
  if (!config.userId || !config.account || !config.password) {
    throw new SinopacVerificationRequiredError(
      "請先儲存永豐身分證字號／統編、使用者代碼與網路密碼。",
    );
  }
  if (!browser) throw new Error("永豐自動驗證需要 BROWSER binding。");

  const browserInstance = await getCaptchaBrowser(
    browser,
    config.browserSessionId,
  );
  const pages = await browserInstance.pages();
  const page =
    pages.find((candidate) =>
      candidate.url().includes("/m/member/login/m_login.aspx"),
    ) ??
    pages[0] ??
    (await browserInstance.newPage());
  try {
    await configurePage(page);
    for (
      let attempt = 1;
      attempt <= SINOPAC_AUTO_LOGIN_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await openLoginAndFill(page, config);
        const imageBytes = await captureSinopacCaptcha(page);
        const captcha = await recognizeCaptcha(toArrayBuffer(imageBytes));
        if (!/^\d{6}$/.test(captcha)) {
          throw new Error("Gemma 4 未回傳六位數字。");
        }
        await submitLogin(page, captcha);
        return {
          sessionCookies: JSON.stringify(await page.cookies()),
          protocol: SINOPAC_SESSION_PROTOCOL,
        };
      } catch (error) {
        if (error instanceof SinopacCredentialRejectedError) throw error;
      }
    }
    throw new SinopacVerificationRequiredError(
      `永豐自動驗證連續失敗 ${SINOPAC_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
    );
  } finally {
    await browserInstance.close();
  }
}

async function captureSinopacCaptcha(page: Page) {
  let bytes: Uint8Array | string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForFunction(
      () => {
        const image = document.querySelector<HTMLImageElement>(
          'img[name="imgCode"]',
        );
        return Boolean(image?.complete && image.naturalWidth > 0);
      },
      { timeout: 10_000 },
    );
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await page.$('img[name="imgCode"]');
    if (!image) throw new Error("永豐行動網銀登入頁沒有取得圖形驗證碼。");
    const candidate = await image.screenshot({ type: "jpeg" });
    if (captchaHasVisibleDigits(candidate)) {
      bytes = candidate;
      break;
    }
  }
  if (!bytes) throw new Error("永豐圖形驗證碼影像為空白，請稍後再試。");
  return bytes;
}

async function getCaptchaBrowser(
  browser: Fetcher,
  preferredSessionId?: string,
) {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browser).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      throw new SinopacBrowserCapacityError(
        "永豐驗證碼正在產生中，請稍候再試。",
        3,
      );
    }
    if (preferred) {
      try {
        return await puppeteer.connect(browser, preferred.sessionId);
      } catch {
        throw new SinopacBrowserCapacityError(
          "前一個永豐驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
  }

  const limits = await puppeteer.limits(browser).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
    );
    throw new SinopacBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再取得驗證碼。",
      retryAfterSeconds,
    );
  }
  return launchBrowser(browser, { keep_alive: CAPTCHA_BROWSER_KEEP_ALIVE_MS });
}

async function launchBrowser(
  browser: Fetcher,
  options?: { keep_alive?: number },
) {
  try {
    return await puppeteer.launch(browser, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new SinopacBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完，請於額度重置後再試。",
        60,
      );
    }
    if (/code:\s*429|rate limit exceeded/i.test(message)) {
      throw new SinopacBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限，請稍後再試。",
        20,
      );
    }
    throw error;
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.setUserAgent(ANDROID_USER_AGENT);
}

async function openLoginAndFill(page: Page, config: SinopacConfig) {
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const userIdSelector =
    'input[placeholder="ID"], input[placeholder*="身分證"]';
  const accountSelector =
    'input[placeholder="User Code"], input[placeholder*="使用者"]';
  const passwordSelector =
    'input[placeholder="Password"], input[placeholder*="密碼"]';
  await page.waitForSelector(userIdSelector, { timeout: 30_000 });
  await page.type(userIdSelector, config.userId!);
  await page.type(accountSelector, config.account!);
  await page.type(passwordSelector, config.password!);
}

async function submitLogin(page: Page, captcha: string) {
  let stage = "填寫圖形驗證碼";
  let dialogMessage = "";
  let dialogType = "";
  try {
    await page.type("#CheckValidateNumber", captcha);
    stage = "送出登入";
    let resolveDialog: (() => void) | undefined;
    const dialogSignal = new Promise<void>((resolve) => {
      resolveDialog = resolve;
    });
    const onDialog = async (dialog: Dialog) => {
      dialogMessage = dialog.message();
      dialogType = dialog.type();
      await dialog.accept();
      resolveDialog?.();
    };
    page.once("dialog", onDialog);
    const navigation = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch(() => null);
    const loginStateChanged = page
      .waitForFunction(
        () => {
          const form = document.querySelector<HTMLElement>("form#m_login");
          const visible =
            form &&
            getComputedStyle(form).display !== "none" &&
            getComputedStyle(form).visibility !== "hidden";
          return (
            !visible ||
            /驗證碼(?:錯誤|有誤)|密碼(?:錯誤|有誤)|登入失敗|使用者代(?:碼|號)(?:錯誤|有誤)/.test(
              document.body.innerText,
            )
          );
        },
        { timeout: 20_000 },
      )
      .catch(() => null);
    await page.click("#MMA_Login");
    try {
      await Promise.race([navigation, loginStateChanged, dialogSignal]);
      if (dialogType === "confirm")
        await Promise.race([navigation, loginStateChanged]);
    } finally {
      page.off("dialog", onDialog);
    }

    stage = "確認登入結果";
    await page
      .waitForFunction(() => document.readyState !== "loading", {
        timeout: 8_000,
      })
      .catch(() => undefined);
    if (await needsMobileLogin(page)) {
      const message = await page
        .evaluate(() => {
          const text = document.body.innerText.replace(/\s+/g, " ").trim();
          return (
            text.match(
              /.{0,40}(?:驗證碼(?:錯誤|有誤)|密碼(?:錯誤|有誤)|登入失敗|使用者代(?:碼|號)(?:錯誤|有誤)).{0,100}/,
            )?.[0] ?? ""
          );
        })
        .catch(() => "");
      const detail = dialogMessage || message;
      if (/驗證碼錯誤|驗證碼有誤/.test(detail)) {
        throw new SinopacCaptchaRejectedError(`永豐銀行登入失敗：${detail}`);
      }
      if (
        /密碼.*(?:錯誤|有誤)|使用者代(?:碼|號).*(?:錯誤|有誤)|帳號.*(?:錯誤|有誤)|身分證.*(?:錯誤|有誤)/.test(
          detail,
        )
      ) {
        throw new SinopacCredentialRejectedError(`永豐銀行登入失敗：${detail}`);
      }
      throw new SinopacVerificationRequiredError(
        `永豐銀行登入失敗：${detail || "請確認帳密或驗證碼"}`,
      );
    }
  } catch (error) {
    if (error instanceof SinopacVerificationRequiredError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SinopacVerificationRequiredError(
      `永豐登入在「${stage}」失敗：${message}`,
    );
  }
}

async function needsMobileLogin(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector<HTMLElement>("form#m_login");
    if (!form) return false;
    const style = getComputedStyle(form);
    const rect = form.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  });
}

function bytesToBase64(bytes: Uint8Array | string) {
  if (typeof bytes === "string") return bytes;
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1)
    binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array | string) {
  if (typeof bytes !== "string")
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  const binary = atob(bytes);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    decoded[index] = binary.charCodeAt(index);
  return decoded.buffer;
}

function captchaHasVisibleDigits(bytes: Uint8Array | string) {
  if (typeof bytes === "string") return bytes.length > 100;
  try {
    const decoded = decodeJpeg(bytes, { useTArray: true });
    const pixels = decoded.width * decoded.height;
    if (pixels === 0) return false;
    let darkPixels = 0;
    for (let offset = 0; offset < decoded.data.length; offset += 4) {
      const luminance =
        0.299 * (decoded.data[offset] ?? 255) +
        0.587 * (decoded.data[offset + 1] ?? 255) +
        0.114 * (decoded.data[offset + 2] ?? 255);
      if (luminance < 170) darkPixels += 1;
    }
    return darkPixels / pixels >= 0.12;
  } catch {
    return false;
  }
}

function cookieHeaderFromSerialized(serialized: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SinopacVerificationRequiredError(
      "永豐銀行 session 格式無效，請重新完成圖形驗證。",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SinopacVerificationRequiredError(
      "永豐銀行 session 格式無效，請重新完成圖形驗證。",
    );
  }
  const nowSeconds = Date.now() / 1000;
  const header = parsed
    .filter((cookie): cookie is JsonRecord => isRecord(cookie))
    .filter((cookie) => {
      const domain = stringValue(cookie.domain)
        .replace(/^\./, "")
        .toLowerCase();
      if (
        domain &&
        domain !== "sinopac.com" &&
        !domain.endsWith(".sinopac.com")
      )
        return false;
      const expires =
        typeof cookie.expires === "number" && Number.isFinite(cookie.expires)
          ? cookie.expires
          : undefined;
      return expires == null || expires <= 0 || expires > nowSeconds;
    })
    .map((cookie) => {
      const name = stringValue(cookie.name);
      const value = stringValue(cookie.value);
      return name && value ? `${name}=${value}` : "";
    })
    .filter(Boolean)
    .join("; ");
  if (!header) {
    throw new SinopacVerificationRequiredError(
      "永豐銀行 session 沒有可用 Cookie，請重新完成圖形驗證。",
    );
  }
  return header;
}

function cookieMapFromHeader(header: string) {
  return new Map(
    header.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return [];
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      return name && value ? [[name, value] as const] : [];
    }),
  );
}

function cookieHeaderFromMap(cookies: Map<string, string>) {
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
}

function storeSetCookies(cookies: Map<string, string>, headers: Headers) {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  const values =
    typeof withGetter.getSetCookie === "function"
      ? withGetter.getSetCookie()
      : splitCombinedSetCookie(headers.get("set-cookie") ?? "");
  for (const value of values) {
    const [pair] = value.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (cookieValue) cookies.set(name, cookieValue);
    else cookies.delete(name);
  }
}

function splitCombinedSetCookie(value: string) {
  return value
    ? value
        .split(/,(?=\s*[^;,=]+=[^;,]+)/g)
        .map((cookie) => cookie.trim())
        .filter(Boolean)
    : [];
}

function assertSinopacApiSuccess(payload: unknown, label: string) {
  const envelope = flattenRecords(payload).find(
    (record) => typeof record.Header === "string",
  );
  if (!envelope) throw new Error(`永豐${label} API 回應缺少 Header。`);
  const header = stringValue(envelope.Header).toUpperCase();
  const message = stringValue(envelope.Message) || "銀行未提供錯誤訊息";
  if (header === "TIMEOUT" || /尚未登入|登入逾時|session/i.test(message)) {
    throw new SinopacVerificationRequiredError(
      "永豐銀行 session 已失效，請重新完成圖形驗證。",
    );
  }
  if (message === "查無消費紀錄") return;
  if (header !== "SUCCESS")
    throw new Error(`永豐${label} API 失敗：${message}`);
}

function assertSinoCardApiSuccess(payload: unknown, label: string) {
  if (!isRecord(payload)) throw new Error(`永豐${label} API 回應格式無效。`);
  const resultCode = stringValue(payload.ResultCode);
  const message =
    stringValue(payload.ResultMessage) ||
    stringValue(payload.Error) ||
    "銀行未提供錯誤訊息";
  if (resultCode === "00") return;
  if (
    /尚未登入|登入|逾時|session|授權|驗證/i.test(message) ||
    /單一登入|信用卡授權/.test(label)
  ) {
    throw new SinopacVerificationRequiredError(
      "永豐銀行 session 已失效，請重新完成圖形驗證。",
    );
  }
  throw new Error(`永豐${label} API 失敗：${message}`);
}

function sinoCardCustomerId(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.Result)) return undefined;
  return stringValue(payload.Result.ID) || undefined;
}

export function parseSinopacCardData(
  payloads: SinopacApiPayloads,
  now = new Date(),
): Scraped {
  if (payloads.hasValidCard === false) {
    return {
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
      creditCardBills: [],
    };
  }
  const summary = parseSummary(payloads.summary);
  const bills = parseBills(payloads.bills, now);
  const transactions =
    payloads.outstanding != null || payloads.latest != null
      ? parseSinoCardTransactions(payloads.latest, payloads.outstanding)
      : parseTransactions(payloads.unbilled);
  const latestTwdBill = bills
    .filter((bill) => bill.currency === "TWD")
    .sort((left, right) =>
      right.billingPeriod.localeCompare(left.billingPeriod),
    )[0];
  if (
    latestTwdBill &&
    latestTwdBill.statementAmount != null &&
    summary.recentPaymentAmount != null &&
    summary.recentPaymentDate &&
    summary.recentPaymentAmount >= latestTwdBill.statementAmount &&
    (!latestTwdBill.statementClosingDate ||
      summary.recentPaymentDate >= latestTwdBill.statementClosingDate)
  ) {
    latestTwdBill.paidAmount = summary.recentPaymentAmount;
    latestTwdBill.isPaid = true;
  }
  const currencies = new Set([
    "TWD",
    ...bills.map((bill) => bill.currency),
    ...transactions.map((item) => item.currency),
  ]);

  const bankAccounts: Scraped["bankAccounts"] = Array.from(currencies).map(
    (currency) => {
      const sourceId = accountIdForCurrency(currency);
      const suffix = currency === "TWD" ? "" : `（${currency}）`;
      const last4 =
        currency === "TWD" && summary.cardLast4
          ? ` 末四碼 ${summary.cardLast4}`
          : "";
      return {
        sourceId,
        institutionName: "永豐銀行",
        accountName: `永豐信用卡${suffix}${last4}`,
        accountType: "credit",
        currency,
        creditLimit: currency === "TWD" ? summary.creditLimit : undefined,
        raw: {
          provider: "sinopac.mobile-app-json",
          protocol: SINOPAC_SESSION_PROTOCOL,
          currency,
          cardLast4: currency === "TWD" ? summary.cardLast4 : undefined,
        },
      };
    },
  );

  const statementAmount =
    summary.statementAmount ?? latestTwdBill?.statementAmount;
  const minimumPayment =
    summary.minimumPayment ?? latestTwdBill?.minimumPayment;
  const paymentDueDate =
    summary.paymentDueDate ?? latestTwdBill?.paymentDueDate;
  const statementClosingDate =
    summary.statementClosingDate ?? latestTwdBill?.statementClosingDate;
  const latestBillMatchesStatement =
    latestTwdBill?.statementAmount != null &&
    statementAmount != null &&
    Math.abs(latestTwdBill.statementAmount) === Math.abs(statementAmount) &&
    (!latestTwdBill.paymentDueDate ||
      !paymentDueDate ||
      latestTwdBill.paymentDueDate === paymentDueDate) &&
    (!latestTwdBill.statementClosingDate ||
      !statementClosingDate ||
      latestTwdBill.statementClosingDate === statementClosingDate);
  const noOutstandingStatement =
    summary.noPaymentNeeded ||
    (latestBillMatchesStatement && latestTwdBill?.isPaid === true);
  const bankBalanceSnapshots: Scraped["bankBalanceSnapshots"] = [];
  if (
    statementAmount != null ||
    summary.availableCredit != null ||
    summary.creditLimit != null ||
    summary.noPaymentNeeded
  ) {
    const accountId = accountIdForCurrency("TWD");
    bankBalanceSnapshots.push({
      accountId,
      sourceId: `${accountId}:${now.toISOString().slice(0, 10)}`,
      balance: noOutstandingStatement
        ? 0
        : statementAmount == null
          ? 0
          : -Math.abs(statementAmount),
      availableBalance: summary.availableCredit,
      statementBalance:
        statementAmount == null ? undefined : Math.abs(statementAmount),
      paymentDueDate,
      statementClosingDate,
      noPaymentNeeded: noOutstandingStatement,
      currency: "TWD",
      asOfAt: now.toISOString(),
      raw: {
        provider: "sinopac.mobile-app-json",
        creditLimit: summary.creditLimit,
        availableCredit: summary.availableCredit,
        statementAmount,
        minimumPayment,
      },
    });
  }

  return {
    bankAccounts,
    bankBalanceSnapshots,
    creditCardBills: bills.map((bill) => ({
      ...bill,
      accountId: accountIdForCurrency(bill.currency),
    })),
    bankTransactions: transactions.map((transaction) => ({
      ...transaction,
      accountId: accountIdForCurrency(transaction.currency),
    })),
  };
}

function parseSummary(payload: unknown) {
  const records = flattenRecords(payload);
  const text = records.flatMap(primitiveStrings).join(" ");
  const cardValue = findLabeledString(records, /卡號|card\s*(?:no|number)/i);
  return {
    creditLimit: findLabeledAmount(
      records,
      /永久信用額度|總信用額度|信用卡額度|信用額度|總額度|credit\s*limit/i,
    ),
    availableCredit: findLabeledAmount(
      records,
      /剩餘可用額度|可用額度|available\s*(?:credit|amount)/i,
    ),
    statementAmount: findLabeledAmount(
      records,
      /本期應繳(?:金額)?|本期帳單(?:金額)?|帳單總額|statement\s*amount/i,
    ),
    minimumPayment: findLabeledAmount(
      records,
      /最低應繳(?:金額)?|最低繳款(?:金額)?|minimum\s*payment/i,
    ),
    recentPaymentAmount: findLabeledAmount(
      records,
      /最近繳款金額|recent\s*payment\s*amount/i,
    ),
    recentPaymentDate: findLabeledDate(
      records,
      /最近繳款日期|recent\s*payment\s*date/i,
    ),
    paymentDueDate: findLabeledDate(
      records,
      /繳款截止日|繳費截止日|繳款期限|payment\s*due/i,
    ),
    statementClosingDate: findLabeledDate(
      records,
      /帳單截止日|結帳日|結帳日期|statement\s*(?:closing|date)/i,
    ),
    noPaymentNeeded: /無需繳(?:費|款)|本期無應繳|免繳/.test(text),
    cardLast4: cardValue?.match(/(\d{4})\D*$/)?.[1],
  };
}

function parseBills(payload: unknown, now: Date) {
  const out: Array<Omit<CreditCardBill, "id" | "connectorId" | "accountId">> =
    [];

  for (const record of logicalRecords(payload)) {
    const period = findPeriod(record);
    const statementAmount = findRecordAmount(
      record,
      /本期應繳(?:金額)?|帳單金額|帳單總額|應繳金額|statement\s*amount|bill\s*amount/i,
    );
    if (!period || statementAmount == null) continue;
    const currency = currencyFromRecord(record);
    const paymentStatus = findRecordString(
      record,
      /繳款狀態|付款狀態|payment\s*status/i,
    );
    out.push({
      sourceId: `sinopac:card:statement:${period}:${currency}`,
      billingPeriod: period,
      statementAmount: Math.abs(statementAmount),
      minimumPayment: absoluteOrUndefined(
        findRecordAmount(record, /最低應繳|最低繳款|minimum\s*payment/i),
      ),
      isPaid:
        paymentStatus == null
          ? undefined
          : /已繳|繳清|無需繳|免繳/.test(paymentStatus)
            ? true
            : /未繳|待繳/.test(paymentStatus)
              ? false
              : undefined,
      paymentDueDate: findRecordDate(
        record,
        /繳款截止|繳費截止|到期日|payment\s*due/i,
      ),
      statementClosingDate: findRecordDate(
        record,
        /結帳日|帳單截止|statement\s*(?:closing|date)|bill\s*date/i,
      ),
      currency,
      raw: sanitizeValue(record),
    });
  }

  return Array.from(
    new Map(
      out.map((bill) => [`${bill.billingPeriod}:${bill.currency}`, bill]),
    ).values(),
  )
    .sort((left, right) =>
      right.billingPeriod.localeCompare(left.billingPeriod),
    )
    .slice(0, BANK_SYNC_MONTHS);
}

function parseTransactions(payload: unknown) {
  const out: Array<Omit<BankTransaction, "id" | "connectorId" | "accountId">> =
    [];
  const seen = new Map<string, number>();

  for (const record of logicalRecords(payload)) {
    const postedDate = findRecordDate(
      record,
      /交易日|消費日|入帳日|日期|transaction\s*date|posting\s*date/i,
    );
    const rawAmount = findRecordAmount(
      record,
      /新臺幣金額|消費金額|交易金額|金額|amount|amt/i,
    );
    if (!postedDate || rawAmount == null || rawAmount === 0) continue;
    const description = findRecordDescription(record) || "永豐信用卡消費";
    const statusText = recordText(record);
    const isCredit =
      rawAmount < 0 ||
      /退款|退貨|折讓|回饋|沖銷|貸方|繳款|自扣|payment|credit|refund/i.test(
        `${description} ${statusText}`,
      );
    const amount = isCredit ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    const currency = currencyFromRecord(record);
    const key = [
      currency,
      postedDate,
      amount,
      description,
      hashString(JSON.stringify(record)),
    ].join(":");
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    out.push({
      sourceId: `sinopac:card:tx:${key}:${occurrence}`,
      postedDate,
      amount,
      currency,
      description,
      status: "posted",
      raw: {
        ...(sanitizeValue(record) as JsonRecord),
        duplicateOccurrence: occurrence,
      },
    });
  }

  return out;
}

type SinoCardTransactionCandidate = Omit<
  BankTransaction,
  "id" | "connectorId" | "accountId" | "sourceId"
> & {
  matchKey: string;
};

function parseSinoCardTransactions(
  latestPayload: unknown,
  outstandingPayload: unknown,
) {
  const pending = sinoCardResultRecords(
    latestPayload,
    "Items",
  ).flatMap<SinoCardTransactionCandidate>((record) => {
    const transactionDate = parseDate(stringValue(record.AuthDate));
    const rawAmount =
      parseAmount(stringValue(record.AuthAmt)) ??
      parseAmount(stringValue(record.AuthAmtDesc));
    if (!transactionDate || rawAmount == null || rawAmount === 0) return [];
    const description = stringValue(record.Memo).trim() || "永豐信用卡消費";
    const amount = signedTransactionAmount(
      rawAmount,
      description,
      recordText(record),
    );
    const cardLast4 = last4FromValue(record.CardNo);
    const authorizedAt = dateTimeWithTaipeiOffset(
      transactionDate,
      stringValue(record.AuthTime),
    );
    return [
      {
        matchKey: sinoCardTransactionMatchKey(
          "TWD",
          transactionDate,
          amount,
          cardLast4,
        ),
        authorizedAt,
        amount,
        currency: "TWD",
        description,
        counterparty: description,
        status: "pending",
        raw: sanitizeValue(record),
      },
    ];
  });

  const posted = sinoCardResultRecords(
    outstandingPayload,
    "Detail",
  ).flatMap<SinoCardTransactionCandidate>((record) => {
    const transactionDate = parseDate(stringValue(record.TXDATE));
    const rawAmount =
      parseAmount(stringValue(record.AMT)) ??
      parseAmount(stringValue(record.TXAMT));
    if (!transactionDate || rawAmount == null || rawAmount === 0) return [];
    const description = stringValue(record.MEMO).trim() || "永豐信用卡消費";
    const amount = signedTransactionAmount(
      rawAmount,
      description,
      recordText(record),
    );
    const currency = normalizeCurrency(
      stringValue(record.CurrencyCode) || stringValue(record.TXCUR),
    );
    const cardLast4 =
      last4FromValue(record.CardNoLast4) ?? last4FromValue(record.CardLast4);
    return [
      {
        matchKey: sinoCardTransactionMatchKey(
          currency,
          transactionDate,
          amount,
          cardLast4,
        ),
        authorizedAt: transactionDate,
        postedDate: parseDate(stringValue(record.DEDATE)) ?? transactionDate,
        amount,
        currency,
        description,
        counterparty: description,
        status: "posted",
        raw: sanitizeValue(record),
      },
    ];
  });

  const postedTransactions = assignSinoCardSourceIds(posted);
  const pendingTransactions = assignSinoCardSourceIds(pending);
  const postedCounts = new Map<string, number>();
  for (const transaction of postedTransactions) {
    postedCounts.set(
      transaction.matchKey,
      (postedCounts.get(transaction.matchKey) ?? 0) + 1,
    );
  }
  const pendingCounts = new Map<string, number>();
  const unmatchedPending = pendingTransactions.filter((transaction) => {
    const occurrence = (pendingCounts.get(transaction.matchKey) ?? 0) + 1;
    pendingCounts.set(transaction.matchKey, occurrence);
    return occurrence > (postedCounts.get(transaction.matchKey) ?? 0);
  });

  return [...postedTransactions, ...unmatchedPending].map(
    ({ matchKey: _matchKey, ...transaction }) => transaction,
  );
}

function sinoCardResultRecords(payload: unknown, key: "Items" | "Detail") {
  if (
    !isRecord(payload) ||
    !isRecord(payload.Result) ||
    !Array.isArray(payload.Result[key])
  )
    return [];
  return payload.Result[key].filter(isRecord);
}

function assignSinoCardSourceIds(candidates: SinoCardTransactionCandidate[]) {
  const occurrences = new Map<string, number>();
  return candidates.map((candidate) => {
    const occurrence = (occurrences.get(candidate.matchKey) ?? 0) + 1;
    occurrences.set(candidate.matchKey, occurrence);
    return {
      ...candidate,
      sourceId: `sinopac:card:tx:v2:${candidate.matchKey}:${occurrence}`,
      raw: {
        ...(candidate.raw as JsonRecord),
        duplicateOccurrence: occurrence,
      },
    };
  });
}

function sinoCardTransactionMatchKey(
  currency: string,
  transactionDate: string,
  amount: number,
  cardLast4?: string,
) {
  return [currency, transactionDate, amount, cardLast4 || "unknown"].join(":");
}

function signedTransactionAmount(
  rawAmount: number,
  description: string,
  statusText: string,
) {
  const isCredit =
    rawAmount < 0 ||
    /退款|退貨|折讓|回饋|沖銷|貸方|繳款|自扣|payment|credit|refund/i.test(
      `${description} ${statusText}`,
    );
  return isCredit ? Math.abs(rawAmount) : -Math.abs(rawAmount);
}

function last4FromValue(value: unknown) {
  return stringValue(value).match(/(\d{4})\D*$/)?.[1];
}

function dateTimeWithTaipeiOffset(date: string, time: string) {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return date;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return date;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+08:00`;
}

function extractAdvertisedBillMonths(payload: unknown) {
  for (const record of flattenRecords(payload)) {
    const months = [record.Last1Mon, record.Last2Mon, record.Last3Mon]
      .map(stringValue)
      .filter((value) => /^\d{6}$/.test(value));
    if (months.length > 0) return months;
  }
  return [];
}

function logicalRecords(value: unknown) {
  const out: JsonRecord[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      if (item.length > 0 && item.every(isLabelValuePair)) {
        out.push(pairArrayRecord(item));
        return;
      }
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;

    const tableRecords = recordsFromHeadInfo(item);
    if (tableRecords.length > 0) out.push(...tableRecords);
    if (Object.keys(item).some((key) => /^Data(?:Text|Value)\d*$/.test(key))) {
      out.push(item);
    }
    for (const [key, nested] of Object.entries(item)) {
      if (key === "HeadInfo" || (key === "SubInfo" && tableRecords.length > 0))
        continue;
      visit(nested);
    }
  };
  visit(value);
  return out;
}

function isLabelValuePair(value: unknown): value is JsonRecord {
  return (
    isRecord(value) &&
    typeof value.DataText === "string" &&
    value.DataValue != null &&
    typeof value.DataValue !== "object"
  );
}

function pairArrayRecord(items: JsonRecord[]) {
  return items.reduce<JsonRecord>((record, item, index) => {
    const suffix = String(index + 1);
    record[`DataText${suffix}`] = item.DataText;
    record[`DataValue${suffix}`] = item.DataValue;
    return record;
  }, {});
}

function recordsFromHeadInfo(container: JsonRecord) {
  if (!Array.isArray(container.HeadInfo) || !Array.isArray(container.SubInfo))
    return [];
  const headers = container.HeadInfo.filter(isRecord)
    .map((header) => ({
      fieldKey: stringValue(header.FieldKey).trim(),
      label: stringValue(header.HeadText).trim(),
    }))
    .filter((header) => header.fieldKey && header.label);
  if (headers.length === 0) return [];

  return container.SubInfo.filter(isRecord).map((row) => {
    const record: JsonRecord = {};
    const usedKeys = new Set<string>();
    let index = 1;
    for (const header of headers) {
      const value = row[header.fieldKey];
      if (value == null || typeof value === "object") continue;
      record[`DataText${index}`] = header.label;
      record[`DataValue${index}`] = value;
      usedKeys.add(header.fieldKey);
      index += 1;
    }
    for (const [key, value] of Object.entries(row)) {
      if (usedKeys.has(key) || value == null || typeof value === "object")
        continue;
      record[`DataText${index}`] = key;
      record[`DataValue${index}`] = value;
      index += 1;
    }
    return record;
  });
}

function flattenRecords(value: unknown): JsonRecord[] {
  const out: JsonRecord[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    out.push(item);
    Object.values(item).forEach(visit);
  };
  visit(value);
  return out;
}

function pairs(record: JsonRecord) {
  const out: Array<{ label: string; value: string }> = [];
  const pairedKeys = new Set<string>();
  const suffixes = Object.keys(record)
    .map((key) => key.match(/^DataText(\d*)$/)?.[1])
    .filter((suffix): suffix is string => suffix != null)
    .sort((left, right) => Number(left || 0) - Number(right || 0));
  for (const suffix of suffixes) {
    const textKey = `DataText${suffix}`;
    const valueKey = `DataValue${suffix}`;
    const label = stringValue(record[textKey]).trim();
    const value = stringValue(record[valueKey]).trim();
    if (label && value) {
      out.push({ label, value });
      pairedKeys.add(textKey);
      pairedKeys.add(valueKey);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (pairedKeys.has(key) || value == null || typeof value === "object")
      continue;
    const text = stringValue(value).trim();
    if (text) out.push({ label: key, value: text });
  }
  return out;
}

function findLabeledString(records: JsonRecord[], pattern: RegExp) {
  for (const record of records) {
    for (const pair of pairs(record)) {
      if (pattern.test(normalizeLabel(pair.label))) return pair.value;
    }
  }
  return undefined;
}

function findLabeledAmount(records: JsonRecord[], pattern: RegExp) {
  for (const record of records) {
    const value = findRecordAmount(record, pattern, false);
    if (value != null) return Math.abs(value);
  }
  return undefined;
}

function findLabeledDate(records: JsonRecord[], pattern: RegExp) {
  for (const record of records) {
    const value = findRecordDate(record, pattern, false);
    if (value) return value;
  }
  return undefined;
}

function findRecordAmount(
  record: JsonRecord,
  pattern: RegExp,
  allowFallback = true,
) {
  for (const pair of pairs(record)) {
    if (!pattern.test(normalizeLabel(pair.label))) continue;
    const value = parseAmount(pair.value);
    if (value != null) return value;
  }
  if (!allowFallback) return undefined;
  const candidates = primitiveStrings(record)
    .filter(
      (value) =>
        !parseDate(value) && !parsePeriod(value) && !/\d{12,19}/.test(value),
    )
    .map(parseAmount)
    .filter((value): value is number => value != null);
  return candidates.at(-1);
}

function findRecordString(record: JsonRecord, pattern: RegExp) {
  for (const pair of pairs(record)) {
    if (pattern.test(normalizeLabel(pair.label))) return pair.value;
  }
  return undefined;
}

function findRecordDate(
  record: JsonRecord,
  pattern: RegExp,
  allowFallback = true,
) {
  for (const pair of pairs(record)) {
    if (!pattern.test(normalizeLabel(pair.label))) continue;
    const value = parseDate(pair.value);
    if (value) return value;
  }
  if (!allowFallback) return undefined;
  return primitiveStrings(record)
    .map(parseDate)
    .find((value): value is string => Boolean(value));
}

function findPeriod(record: JsonRecord) {
  for (const pair of pairs(record)) {
    if (
      !/帳單年月|帳單月份|帳單期|billing|bill\s*(?:month|period|date)|statement\s*(?:month|period)/i.test(
        normalizeLabel(pair.label),
      )
    ) {
      continue;
    }
    const value = parsePeriod(pair.value);
    if (value) return value;
  }
  return primitiveStrings(record)
    .map(parsePeriod)
    .find((value): value is string => Boolean(value));
}

function findRecordDescription(record: JsonRecord) {
  for (const pair of pairs(record)) {
    if (
      /特店|商店|摘要|說明|消費明細|交易名稱|merchant|store|description|memo/i.test(
        normalizeLabel(pair.label),
      )
    ) {
      return pair.value.trim();
    }
  }
  return primitiveStrings(record)
    .filter(
      (value) =>
        value.length >= 2 &&
        !parseDate(value) &&
        !parsePeriod(value) &&
        parseAmount(value) == null &&
        !/^(TWD|USD|JPY|EUR|CNY|RMB|HKD|NTD)$/i.test(value) &&
        !/^(SUCCESS|TIMEOUT|Y|N)$/i.test(value),
    )
    .sort((left, right) => right.length - left.length)[0];
}

function currencyFromRecord(record: JsonRecord) {
  for (const pair of pairs(record)) {
    if (/幣別|currency|curr/i.test(normalizeLabel(pair.label)))
      return normalizeCurrency(pair.value);
  }
  const value = primitiveStrings(record).find((item) =>
    /^(000|840|978|392|TWD|NTD|USD|JPY|EUR|CNY|RMB|HKD)$/i.test(item.trim()),
  );
  return normalizeCurrency(value);
}

function normalizeCurrency(value?: string) {
  const currency = value?.trim().toUpperCase();
  if (
    !currency ||
    currency === "000" ||
    currency === "NTD" ||
    /新臺幣|台幣|臺幣/.test(value ?? "")
  )
    return "TWD";
  if (currency === "840") return "USD";
  if (currency === "978") return "EUR";
  if (currency === "392") return "JPY";
  if (currency === "RMB" || /人民幣/.test(value ?? "")) return "CNY";
  if (/美元/.test(value ?? "")) return "USD";
  if (/日圓|日幣/.test(value ?? "")) return "JPY";
  return /^(TWD|USD|JPY|EUR|CNY|HKD)$/.test(currency) ? currency : "TWD";
}

function primitiveStrings(record: JsonRecord) {
  return Object.values(record)
    .filter((value) => value != null && typeof value !== "object")
    .map(stringValue)
    .map((value) => value.trim())
    .filter(Boolean);
}

function recordText(record: JsonRecord) {
  return primitiveStrings(record).join(" ");
}

function accountIdForCurrency(currency: string) {
  return currency === "TWD"
    ? "credit:sinopac:main"
    : `credit:sinopac:main:${currency}`;
}

function absoluteOrUndefined(value?: number) {
  return value == null ? undefined : Math.abs(value);
}

function parsePeriod(value: string | undefined) {
  if (!value) return undefined;
  const text = value.trim();
  const separated = text.match(
    /(\d{2,4})\s*(?:年|[\/-])\s*(\d{1,2})(?:\s*月)?/,
  );
  if (separated)
    return normalizePeriod(Number(separated[1]), Number(separated[2]));
  const compact = text.match(/(?:^|\D)(20\d{2}|1\d{2})(0[1-9]|1[0-2])(?:\D|$)/);
  if (compact) return normalizePeriod(Number(compact[1]), Number(compact[2]));
  const date = parseDate(text);
  return date?.slice(0, 7);
}

function normalizePeriod(year: number, month: number) {
  if (month < 1 || month > 12) return undefined;
  const normalizedYear = year < 1911 ? year + 1911 : year;
  if (normalizedYear < 2000 || normalizedYear > 2200) return undefined;
  return `${normalizedYear}-${String(month).padStart(2, "0")}`;
}

export function parseAmount(value: string | undefined): number | undefined {
  if (!value || /%/.test(value)) return undefined;
  const normalized = value
    .replace(
      /新臺幣|臺幣|台幣|人民幣|美元|日圓|日幣|港幣|歐元|NT\$|US\$|HK\$|TWD|NTD|USD|JPY|EUR|CNY|RMB|HKD|元/gi,
      "",
    )
    .replace(/[$,\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}

export function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const separated = text.match(
    /(\d{3,4})\s*(?:年|[\/-])\s*(\d{1,2})\s*(?:月|[\/-])\s*(\d{1,2})(?:\s*日)?/,
  );
  if (separated)
    return normalizeDateParts(
      Number(separated[1]),
      Number(separated[2]),
      Number(separated[3]),
    );
  const compact = text.match(/(?:^|\D)(20\d{6}|1\d{6})(?:\D|$)/);
  if (!compact) return undefined;
  const digits = compact[1];
  const roc = digits.length === 7;
  const yearLength = roc ? 3 : 4;
  return normalizeDateParts(
    Number(digits.slice(0, yearLength)),
    Number(digits.slice(yearLength, yearLength + 2)),
    Number(digits.slice(yearLength + 2, yearLength + 4)),
  );
}

function normalizeDateParts(year: number, month: number, day: number) {
  const normalizedYear = year < 1911 ? year + 1911 : year;
  const date = new Date(Date.UTC(normalizedYear, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    date.getUTCFullYear() !== normalizedYear ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${normalizedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\b\d{12,19}\b/g, (match) => `****${match.slice(-4)}`);
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]),
  );
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeLabel(value: string) {
  return value.replace(/[\s_／/：:()（）]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
