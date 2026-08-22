import puppeteer, {
  type Browser,
  type CookieParam,
  type Page,
} from "@cloudflare/puppeteer";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
  SyncResult,
} from "@taiwan-fin-hub/core";
import {
  BANK_SYNC_MONTHS,
  type CathaybkConfig,
} from "@taiwan-fin-hub/connectors";

const LOGIN_URL = "https://www.cathaybk.com.tw/MyBank/";
const DEPOSIT_OVERVIEW_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0101_DepInq";
const CREDIT_CARD_OVERVIEW_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/CQuery/C0101_BillOverview";
const CREDIT_CARD_BILL_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/CQuery/C0102_BillInq";

const API_DEPOSIT_TX = "B_ACCT_Q_TransferDetail";
const OTP_SESSION_TTL_MS = 2 * 60 * 1000;
const TRUSTED_DEVICE_NAME = "ALL SET 同步";
const OTP_SUBMIT_LABEL_PATTERN = /驗證|確認|確定|送出|登入/;
const TRUST_DEVICE_CONTEXT_PATTERN =
  /登入安全再升級|立即啟用|信任裝置|設定裝置名稱|裝置名稱|裝置暱稱|確定加入/;
const TRUST_DEVICE_CONFIRM_PATTERN =
  /確定加入|確認加入|完成設定|^確定$|^確認$|^完成$/;

export class CathayVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CathayVerificationRequiredError";
  }
}

export class CathayOtpChannelRequiredError extends CathayVerificationRequiredError {
  constructor(
    message: string,
    readonly browserSessionId: string,
    readonly browserSessionExpiresAt: string,
  ) {
    super(message);
    this.name = "CathayOtpChannelRequiredError";
  }
}

export class CathayOtpRequiredError extends CathayVerificationRequiredError {
  constructor(
    message: string,
    readonly channel: "email" | "sms",
  ) {
    super(message);
    this.name = "CathayOtpRequiredError";
  }
}

export class CathayOtpInvalidError extends CathayVerificationRequiredError {
  constructor(
    message = "國泰世華驗證碼錯誤或已逾時，請重新輸入或取得驗證碼。",
  ) {
    super(message);
    this.name = "CathayOtpInvalidError";
  }
}

export class CathayOtpSessionExpiredError extends CathayVerificationRequiredError {
  constructor() {
    super("國泰世華驗證工作階段已逾時，請重新同步後再取得驗證碼。");
    this.name = "CathayOtpSessionExpiredError";
  }
}

function maskAccountNumber(value: string) {
  const suffix = value.slice(-4);
  return suffix ? `***${suffix}` : "***";
}

type Scraped = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

export function createCathaybkConnector(browser?: Fetcher) {
  return {
    id: "cathaybk" as const,
    name: "國泰世華銀行 Cathay United Bank",

    async sync(
      config: CathaybkConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      if (!config.userId || !config.account || !config.password) {
        throw new Error(
          "Cathay United Bank requires userId (身分證字號), account (用戶代號), and password.",
        );
      }

      if (!browser) {
        throw new Error("Cathay United Bank requires the BROWSER binding.");
      }

      const {
        bankAccounts,
        bankBalanceSnapshots,
        bankTransactions,
        creditCardBills,
        freshCookies,
        sessionExpiresAt,
      } = await scrapeWithBrowser(browser, config);

      return {
        records: [],
        bankAccounts,
        bankBalanceSnapshots,
        bankTransactions,
        creditCardBills,
        cursor: JSON.stringify({
          sessionCookies: freshCookies,
          sessionExpiresAt,
          syncedAt: new Date().toISOString(),
        }),
      };
    },
  };
}

async function scrapeWithBrowser(
  browserBinding: Fetcher,
  config: CathaybkConfig,
) {
  const reconnecting = Boolean(config.browserSessionId);
  if (
    reconnecting &&
    (!config.browserSessionExpiresAt ||
      new Date(config.browserSessionExpiresAt) <= new Date())
  ) {
    throw new CathayOtpSessionExpiredError();
  }

  const syncWindowDays = BANK_SYNC_MONTHS * 30;
  let b: Browser | undefined;
  let page: Page | undefined;
  let preserveSession = false;
  let loggedOut = false;

  try {
    console.log(
      reconnecting
        ? "[cathaybk] reconnecting to verification session"
        : "[cathaybk] launching browser",
    );
    b = reconnecting
      ? await connectCathayBrowser(browserBinding, config.browserSessionId!)
      : await puppeteer.launch(browserBinding, {
          keep_alive: OTP_SESSION_TTL_MS,
        });
    const pages = await b.pages();
    page = pages[0] ?? (await b.newPage());

    await page.setViewport({ width: 1280, height: 800 });

    if (config.browserSessionId) {
      if (!config.otpChannel) {
        await b.disconnect();
        preserveSession = true;
        throw new CathayOtpChannelRequiredError(
          "請選擇以 Email 或簡訊接收國泰世華驗證碼。",
          config.browserSessionId,
          config.browserSessionExpiresAt!,
        );
      }
      if (!config.otp) {
        await sendCathayOtp(page, config.otpChannel);
        await b.disconnect();
        preserveSession = true;
        throw new CathayOtpRequiredError(
          config.otpChannel === "email"
            ? "國泰世華 Email 驗證碼已寄出，請輸入驗證碼。"
            : "國泰世華簡訊驗證碼已寄出，請輸入驗證碼。",
          config.otpChannel,
        );
      }
      try {
        await submitCathayOtp(page, config.otp);
      } catch (error) {
        if (!(error instanceof CathayOtpInvalidError)) throw error;
        await b.disconnect();
        preserveSession = true;
        throw error;
      }
    } else {
      const restoredState = await restoreCathayTrustedState(page, config);
      if (restoredState) {
        console.log("[cathaybk] restored trusted browser state");
      }
      try {
        await loginCathay(page, config);
      } catch (error) {
        if (!(error instanceof CathayVerificationRequiredError)) throw error;
        const sessionId = b.sessionId();
        const expiresAt = new Date(
          Date.now() + OTP_SESSION_TTL_MS,
        ).toISOString();
        await b.disconnect();
        preserveSession = true;
        throw new CathayOtpChannelRequiredError(
          "國泰世華要求額外驗證，請選擇 Email 或簡訊接收驗證碼。",
          sessionId,
          expiresAt,
        );
      }
    }

    console.log("[cathaybk] collecting deposit accounts");
    const deposits = await scrapeDeposits(page, syncWindowDays);

    console.log("[cathaybk] collecting credit cards");
    const cards = await scrapeCreditCards(page);

    const trustedState = await captureCathayTrustedState(page);
    await logoutCathay(page);
    loggedOut = true;

    return {
      bankAccounts: [...deposits.bankAccounts, ...cards.bankAccounts],
      bankBalanceSnapshots: [
        ...deposits.bankBalanceSnapshots,
        ...cards.bankBalanceSnapshots,
      ],
      bankTransactions: [
        ...deposits.bankTransactions,
        ...cards.bankTransactions,
      ],
      creditCardBills: cards.creditCardBills,
      freshCookies: trustedState.sessionCookies,
      sessionExpiresAt: trustedState.sessionExpiresAt,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cathaybk_scrape_failed",
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      }),
    );
    throw error;
  } finally {
    if (!preserveSession && b) {
      try {
        if (!loggedOut && page) {
          // Always logout so next run doesn't hit the "未完成正常的登出" interstitial
          await logoutCathay(page);
        }
      } finally {
        await b.close();
      }
    }
  }
}

async function logoutCathay(page: Pick<Page, "goto">) {
  console.log("[cathaybk] logging out");
  await page
    .goto("https://www.cathaybk.com.tw/OnlineBanking/Logout/Index", {
      waitUntil: "networkidle2",
      timeout: 30_000,
    })
    .catch(() => null);
}

type CathayTrustedStatePage = Pick<Page, "setCookie">;

export async function restoreCathayTrustedState(
  page: CathayTrustedStatePage,
  config: Pick<CathaybkConfig, "sessionCookies">,
) {
  const cookies = parseCathayCookies(config.sessionCookies);
  if (cookies.length === 0) return false;

  await page.setCookie(...cookies);

  return true;
}

export async function captureCathayTrustedState(page: Pick<Page, "cookies">) {
  const cookies = (
    await page.cookies(
      LOGIN_URL,
      DEPOSIT_OVERVIEW_URL,
      CREDIT_CARD_OVERVIEW_URL,
    )
  ).filter(isCathayCookie);
  const expires = cookies
    .map((cookie) => cookie.expires)
    .filter((value): value is number => typeof value === "number" && value > 0);

  return {
    sessionCookies: JSON.stringify(cookies),
    sessionExpiresAt:
      expires.length > 0
        ? new Date(Math.max(...expires) * 1000).toISOString()
        : undefined,
  };
}

function parseCathayCookies(value: string | undefined): CookieParam[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCathayCookie).map((cookie) => ({ ...cookie }));
  } catch {
    return [];
  }
}

function isCathayCookie(value: unknown): value is CookieParam {
  if (!value || typeof value !== "object") return false;
  const cookie = value as Partial<CookieParam>;
  if (typeof cookie.name !== "string" || typeof cookie.value !== "string") {
    return false;
  }
  const domain = String(cookie.domain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  return (
    cookie.name === "CUB.eBank.DeviceId" &&
    (domain === "cathaybk.com.tw" || domain.endsWith(".cathaybk.com.tw"))
  );
}

async function connectCathayBrowser(
  browserBinding: Fetcher,
  sessionId: string,
): Promise<Browser> {
  const sessions = await puppeteer.sessions(browserBinding).catch(() => []);
  const session = sessions.find(
    (candidate) => candidate.sessionId === sessionId,
  );
  if (!session) throw new CathayOtpSessionExpiredError();
  try {
    return await puppeteer.connect(browserBinding, sessionId);
  } catch {
    throw new CathayOtpSessionExpiredError();
  }
}

export async function sendCathayOtp(
  page: Pick<Page, "click" | "evaluate" | "waitForSelector">,
  channel: "email" | "sms",
) {
  const selector = channel === "email" ? "#js-otp-email-send" : "#js-otp-send";
  await page.evaluate((selectedChannel) => {
    const selector =
      selectedChannel === "email" ? "#js-otp-email-send" : "#js-otp-send";
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return;
    const expectedText =
      selectedChannel === "email" ? /Email|電子信箱/i : /簡訊|手機/;
    const toggles = Array.from(
      document.querySelectorAll<HTMLElement>(".js-otp-change-view"),
    );
    (
      toggles.find((toggle) => expectedText.test(toggle.innerText)) ??
      toggles[0]
    )?.click();
  }, channel);
  await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  await page.click(selector);
  await page.waitForSelector(
    '.js-otp-view input:not([type="hidden"]), .login-otp input:not([type="hidden"]), input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="後6位數字"]',
    { timeout: 15_000 },
  );
}

export async function submitCathayOtp(
  page: Pick<
    Page,
    | "click"
    | "evaluate"
    | "type"
    | "url"
    | "waitForFunction"
    | "waitForNavigation"
  >,
  otp: string,
) {
  const otpMatch = otp
    .trim()
    .toUpperCase()
    .match(/^(?:[A-Z]{2,8}-)?(\d{4,8})$/);
  if (!otpMatch) {
    throw new CathayOtpInvalidError(
      "請輸入驗證碼後 4 至 8 位數字；英文前綴可省略。",
    );
  }
  const normalizedOtp = otpMatch[1];

  const selectors = await page.evaluate((submitLabelPatternSource) => {
    const submitLabelPattern = new RegExp(submitLabelPatternSource);
    const visible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return !element.hidden && rect.width > 0 && rect.height > 0;
    };
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '.js-otp-view input:not([type="hidden"]), .login-otp input:not([type="hidden"]), input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[placeholder*="後6位數字"]',
      ),
    );
    const input =
      inputs.find(
        (candidate) =>
          visible(candidate) && /後\s*6\s*位數字/.test(candidate.placeholder),
      ) ??
      inputs.find(
        (candidate) =>
          visible(candidate) &&
          candidate.maxLength >= 4 &&
          candidate.maxLength <= 8,
      ) ??
      inputs.find(visible);
    if (input) input.dataset.cathayOtpInput = "true";

    const verificationRoot =
      input?.closest<HTMLElement>("form, [role='dialog'], main, section") ??
      document;
    const controls = Array.from(
      verificationRoot.querySelectorAll<HTMLElement>(
        'button, input[type="submit"], input[type="button"], [role="button"]',
      ),
    );
    const submit = controls.find((candidate) => {
      const text = `${candidate.textContent ?? ""} ${candidate.getAttribute("value") ?? ""}`;
      return visible(candidate) && submitLabelPattern.test(text);
    });
    if (submit) submit.dataset.cathayOtpSubmit = "true";

    const trustCheckbox = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"], input[type="radio"]',
      ),
    ).find((candidate) => {
      const explicitLabel = candidate.id
        ? document.querySelector<HTMLLabelElement>(
            `label[for="${CSS.escape(candidate.id)}"]`,
          )?.innerText
        : "";
      const context = `${explicitLabel ?? ""} ${candidate.parentElement?.innerText ?? ""}`;
      return (
        /加入.*信任|信任.*裝置|常用.*裝置|記住.*裝置/.test(context) &&
        !/不要|取消|移除/.test(context)
      );
    });
    if (trustCheckbox && !trustCheckbox.checked) trustCheckbox.click();
    return { hasInput: Boolean(input), hasSubmit: Boolean(submit) };
  }, OTP_SUBMIT_LABEL_PATTERN.source);

  if (!selectors.hasInput) {
    throw new CathayVerificationRequiredError(
      "國泰世華驗證頁面格式已變更，找不到驗證碼輸入欄。",
    );
  }
  if (!selectors.hasSubmit) {
    throw new CathayVerificationRequiredError(
      "國泰世華驗證頁面格式已變更，找不到「確定」按鈕。",
    );
  }

  await page.click('[data-cathay-otp-input="true"]', { clickCount: 3 });
  await page.type('[data-cathay-otp-input="true"]', normalizedOtp);
  const verificationResult = Promise.race([
    page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      })
      .catch(() => null),
    page
      .waitForFunction(
        () =>
          (window.location.href.includes("/OnlineBanking/") &&
            document.querySelector('[data-cathay-otp-input="true"]') ===
              null) ||
          /登入安全再升級|立即啟用|信任裝置|設定裝置名稱|確定加入|啟用成功/.test(
            (document.body?.innerText ?? "").replace(/\s+/g, ""),
          ) ||
          /驗證碼.*(錯誤|失敗|逾時)/.test(document.body?.innerText ?? ""),
        { timeout: 45_000 },
      )
      .catch(() => null),
  ]);
  await page.click('[data-cathay-otp-submit="true"]');
  await verificationResult;
  const verified = await page.evaluate(() => {
    const normalizedText = (document.body?.innerText ?? "").replace(/\s+/g, "");
    return (
      (window.location.href.includes("/OnlineBanking/") &&
        document.querySelector('[data-cathay-otp-input="true"]') === null) ||
      /登入安全再升級|立即啟用|信任裝置|設定裝置名稱|確定加入|啟用成功/.test(
        normalizedText,
      )
    );
  });
  if (!verified) {
    throw new CathayOtpInvalidError();
  }
  const trustedDeviceReady = await completeCathayTrustedDeviceSetup(page);
  if (!trustedDeviceReady) {
    throw new CathayVerificationRequiredError(
      "國泰世華已通過 OTP，但未完成加入信任裝置。",
    );
  }
}

export async function completeCathayTrustedDeviceSetup(
  page: Pick<Page, "click" | "evaluate" | "type" | "waitForFunction">,
) {
  await page
    .waitForFunction(
      () =>
        document.cookie.includes("CUB.eBank.DeviceId=") ||
        /登入安全再升級|立即啟用|信任裝置|設定裝置名稱|裝置名稱|確定加入|啟用成功/.test(
          (document.body?.innerText ?? "").replace(/\s+/g, ""),
        ),
      { timeout: 15_000 },
    )
    .catch(() => null);

  const findStep = () =>
    page.evaluate(
      (patterns) => {
        const trustContextPattern = new RegExp(patterns.context);
        const trustConfirmPattern = new RegExp(patterns.confirm);
        const visible = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return !element.hidden && rect.width > 0 && rect.height > 0;
        };
        const trustDialog = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"], [aria-modal="true"]',
          ),
        ).find(
          (dialog) =>
            visible(dialog) &&
            trustContextPattern.test(
              (dialog.innerText ?? "").replace(/\s+/g, ""),
            ),
        );
        const trustRoot =
          trustDialog ??
          (trustContextPattern.test(
            (document.body?.innerText ?? "").replace(/\s+/g, ""),
          )
            ? document.body
            : null);
        const controls = Array.from(
          trustRoot?.querySelectorAll<HTMLElement>(
            'button, a, input[type="button"], input[type="submit"], [role="button"]',
          ) ?? [],
        );
        const textOf = (element: HTMLElement) =>
          `${element.textContent ?? ""} ${element.getAttribute("value") ?? ""}`
            .replace(/\s+/g, "")
            .trim();
        const next = controls.find(
          (control) =>
            visible(control) &&
            /立即啟用|啟用信任裝置|加入信任裝置|設定信任裝置/.test(
              textOf(control),
            ),
        );
        if (next) next.dataset.cathayTrustNext = "true";

        const inputs = Array.from(
          trustRoot?.querySelectorAll<HTMLInputElement>(
            'input:not([type="hidden"]):not([type="password"])',
          ) ?? [],
        );
        const nameInput = inputs.find((input) => {
          const explicitLabel = input.id
            ? document.querySelector<HTMLLabelElement>(
                `label[for="${CSS.escape(input.id)}"]`,
              )?.innerText
            : "";
          const context = [
            input.name,
            input.placeholder,
            input.getAttribute("aria-label"),
            explicitLabel,
            input.parentElement?.innerText,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            visible(input) &&
            /裝置名稱|裝置暱稱|方便記憶的裝置名稱/.test(context)
          );
        });
        if (nameInput) nameInput.dataset.cathayTrustName = "true";

        const confirm = controls.find(
          (control) =>
            visible(control) && trustConfirmPattern.test(textOf(control)),
        );
        if (confirm) confirm.dataset.cathayTrustConfirm = "true";

        return {
          hasNext: Boolean(next),
          hasNameInput: Boolean(nameInput),
          hasConfirm: Boolean(confirm),
          success:
            document.cookie.includes("CUB.eBank.DeviceId=") ||
            /啟用成功|已加入信任裝置/.test(
              (document.body?.innerText ?? "").replace(/\s+/g, ""),
            ),
        };
      },
      {
        context: TRUST_DEVICE_CONTEXT_PATTERN.source,
        confirm: TRUST_DEVICE_CONFIRM_PATTERN.source,
      },
    );

  let step = await findStep();
  if (step.hasNext) {
    await page.click('[data-cathay-trust-next="true"]');
    await page
      .waitForFunction(
        () =>
          /設定裝置名稱|裝置名稱|確定加入/.test(
            (document.body?.innerText ?? "").replace(/\s+/g, ""),
          ),
        { timeout: 15_000 },
      )
      .catch(() => null);
    step = await findStep();
  }

  if (!step.hasNameInput && !step.hasConfirm) return step.success;
  if (!step.hasNameInput || !step.hasConfirm) {
    console.warn(
      JSON.stringify({
        event: "cathaybk_trusted_device_controls_missing",
        hasNext: step.hasNext,
        hasNameInput: step.hasNameInput,
        hasConfirm: step.hasConfirm,
      }),
    );
    throw new CathayVerificationRequiredError(
      "國泰世華已通過 OTP，但無法完成信任裝置設定。",
    );
  }

  await page.click('[data-cathay-trust-name="true"]', { clickCount: 3 });
  await page.type('[data-cathay-trust-name="true"]', TRUSTED_DEVICE_NAME);
  await page.click('[data-cathay-trust-confirm="true"]');
  await page
    .waitForFunction(
      () =>
        document.cookie.includes("CUB.eBank.DeviceId=") ||
        /啟用成功|已加入信任裝置/.test(
          (document.body?.innerText ?? "").replace(/\s+/g, ""),
        ),
      { timeout: 15_000 },
    )
    .catch(() => null);
  return page.evaluate(() => {
    const normalizedText = (document.body?.innerText ?? "").replace(/\s+/g, "");
    return (
      document.cookie.includes("CUB.eBank.DeviceId=") ||
      /啟用成功|已加入信任裝置/.test(normalizedText)
    );
  });
}

export type CathayLoginPage = Pick<
  Page,
  | "$"
  | "click"
  | "evaluate"
  | "goto"
  | "on"
  | "type"
  | "url"
  | "waitForFunction"
  | "waitForSelector"
>;

function safeCathayDiagnosticUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

function safeCathayDiagnosticOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid-origin";
  }
}

function safeCathayDiagnosticMessage(value: string, secrets: string[] = []) {
  let sanitized = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeCathayDiagnosticUrl(url))
    .replace(/[A-Za-z0-9_-]{16,}/g, "[redacted]");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized.slice(0, 240);
}

function attachCathaySafeDiagnostics(
  page: CathayLoginPage,
  config: CathaybkConfig,
) {
  const ignoredAbortedOrigins = new Set([
    "https://ad.doubleclick.net",
    "https://analytics.google.com",
    "https://cathayunitedbank.tt.omtrdc.net",
    "https://faro-collector-prod-ap-southeast-1.grafana.net",
    "https://www.google.com",
  ]);
  const recordedResponses = new Set<string>();
  const recordedFailures = new Set<string>();
  const secrets = [
    config.userId,
    config.account,
    config.password,
    config.otp,
  ].filter((value): value is string => Boolean(value));

  page.on("pageerror", (error) => {
    const diagnostic = JSON.stringify({
      event: "cathaybk_page_error",
      errorType: error.name,
      message: safeCathayDiagnosticMessage(error.message, secrets),
    });
    if (error.name === "ReferenceError" && error.message.includes("getMbox")) {
      console.warn(diagnostic);
      return;
    }
    console.error(diagnostic);
  });
  page.on("requestfailed", (request) => {
    const origin = safeCathayDiagnosticOrigin(request.url());
    const errorText = safeCathayDiagnosticMessage(
      request.failure()?.errorText ?? "unknown",
      secrets,
    );
    if (errorText === "net::ERR_ABORTED" && ignoredAbortedOrigins.has(origin)) {
      return;
    }
    const key = `${origin}:${errorText}`;
    if (recordedFailures.size >= 20 || recordedFailures.has(key)) return;
    recordedFailures.add(key);
    console.warn(
      JSON.stringify({
        event: "cathaybk_request_failed",
        origin,
        errorText,
      }),
    );
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const origin = safeCathayDiagnosticOrigin(response.url());
    const key = `${origin}:${status}`;
    if (recordedResponses.size >= 20 || recordedResponses.has(key)) return;
    recordedResponses.add(key);
    console.warn(
      JSON.stringify({
        event: "cathaybk_http_error",
        origin,
        status,
      }),
    );
  });
}

async function logCathayLoginTimeout(page: CathayLoginPage, error: unknown) {
  const state = await page
    .evaluate(() => ({
      customerIdCleared:
        (document.querySelector<HTMLInputElement>("#CustID")?.value ?? "") ===
        "",
      userIdCleared:
        (document.querySelector<HTMLInputElement>("#UserIdKeyin")?.value ??
          "") === "",
      passwordCleared:
        (document.querySelector<HTMLInputElement>("#PasswordKeyin")?.value ??
          "") === "",
      encryptedUserIdReady: Boolean(
        document.querySelector<HTMLInputElement>("#UserId")?.value,
      ),
      encryptedPasswordReady: Boolean(
        document.querySelector<HTMLInputElement>("#Password")?.value,
      ),
      formMarkedSubmitting:
        (window as typeof window & { blnSubmit?: boolean }).blnSubmit === true,
      hasVisibleValidation: Array.from(
        document.querySelectorAll<HTMLElement>(
          ".control-group.was-validated .error-msg",
        ),
      ).some((element) => element.innerText.trim() !== ""),
    }))
    .catch(() => null);

  console.error(
    JSON.stringify({
      event: "cathaybk_login_wait_failed",
      errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      currentUrl: safeCathayDiagnosticUrl(page.url()),
      state,
    }),
  );
}

async function dismissInterstitialIfPresent(
  page: CathayLoginPage,
): Promise<boolean> {
  const hasWarning = await page
    .evaluate(() => document.body.innerText.includes("未完成正常的登出程序"))
    .catch(() => false);
  if (hasWarning) {
    console.log("[cathaybk] dismissing logout warning interstitial");
    await page.evaluate(() => {
      const btn = Array.from(
        document.querySelectorAll<HTMLElement>("a, button"),
      ).find((el) => el.textContent?.includes("回登入頁"));
      btn?.click();
    });
    await page.waitForSelector("#CustID", { timeout: 15000 });
  }
  return hasWarning as boolean;
}

export async function dismissCathaySystemMessageIfPresent(
  page: Pick<CathayLoginPage, "$" | "waitForSelector">,
): Promise<boolean> {
  const dismissButton = await page.$(
    "#divSystemLoginMsgList.show button.btn-fill",
  );
  if (!dismissButton) return false;

  console.log("[cathaybk] dismissing system message modal");
  await dismissButton.click();
  await page.waitForSelector("#divSystemLoginMsgList.show", {
    hidden: true,
    timeout: 5000,
  });
  return true;
}

export async function submitCathayLoginForm(
  page: Pick<CathayLoginPage, "click" | "evaluate">,
) {
  const invokedBankHandler = await page.evaluate(() => {
    const normalDataCheck = (
      window as typeof window & { NormalDataCheck?: () => boolean }
    ).NormalDataCheck;
    if (typeof normalDataCheck !== "function") return false;
    normalDataCheck();
    return true;
  });
  if (!invokedBankHandler) await page.click(".js-login");
}

export async function loginCathay(
  page: CathayLoginPage,
  config: CathaybkConfig,
) {
  attachCathaySafeDiagnostics(page, config);
  console.log("[cathaybk] navigating to login page");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // ponytail: bank shows "未完成正常的登出程序" both on page load AND after clicking login
  // if a prior session didn't log out — retry up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dismissInterstitialIfPresent(page);
    await dismissCathaySystemMessageIfPresent(page);
    await page.waitForSelector("#CustID", { timeout: 15000 });

    await page.click("#CustID", { clickCount: 3 });
    await page.type("#CustID", config.userId!.toUpperCase());
    await page.click("#UserIdKeyin", { clickCount: 3 });
    await page.type("#UserIdKeyin", config.account!);
    await page.click("#PasswordKeyin", { clickCount: 3 });
    await page.type("#PasswordKeyin", config.password!);

    console.log(`[cathaybk] submitting login form (attempt ${attempt}/3)`);
    const loginResult = page.waitForFunction(
      () => {
        const controlsText = Array.from(
          document.querySelectorAll<HTMLElement>(
            'a, button, input[type="button"], input[type="submit"], [role="button"]',
          ),
        )
          .map((element) =>
            [
              element.textContent,
              element.getAttribute("aria-label"),
              element.getAttribute("value"),
            ]
              .filter(Boolean)
              .join(" "),
          )
          .join(" ");
        const pageText = `${document.body?.innerText ?? ""} ${controlsText}`;
        const normalizedText = pageText.replace(/\s+/g, "");

        return (
          window.location.href.includes("/OnlineBanking/") ||
          document.querySelector(
            ".js-otp-view, #js-otp-send, #js-otp-email-send",
          ) !== null ||
          normalizedText.includes("未完成正常的登出程序") ||
          normalizedText.includes("登入失敗") ||
          normalizedText.includes("錯誤") ||
          (normalizedText.includes("Email驗證") &&
            normalizedText.includes("簡訊驗證"))
        );
      },
      { timeout: 45000 },
    );
    await submitCathayLoginForm(page);
    try {
      await loginResult;
    } catch (error) {
      await logCathayLoginTimeout(page, error);
      throw error;
    }

    if (page.url().includes("/OnlineBanking/")) {
      console.log("[cathaybk] login succeeded");
      return;
    }

    const requiresAdditionalVerification = await page.evaluate(() => {
      const controlsText = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a, button, input[type="button"], input[type="submit"], [role="button"]',
        ),
      )
        .map((element) =>
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("value"),
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
      const normalizedText =
        `${document.body?.innerText ?? ""} ${controlsText}`.replace(/\s+/g, "");
      return (
        document.querySelector(
          ".js-otp-view, #js-otp-send, #js-otp-email-send",
        ) !== null ||
        (normalizedText.includes("Email驗證") &&
          normalizedText.includes("簡訊驗證"))
      );
    });
    if (requiresAdditionalVerification) {
      throw new CathayVerificationRequiredError(
        "國泰世華要求 Email 或簡訊額外驗證，請先完成人工驗證。",
      );
    }

    const bodyText = await page
      .evaluate(() =>
        document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 300),
      )
      .catch(() => "");

    if (bodyText.includes("未完成正常的登出程序")) {
      console.log(
        `[cathaybk] interstitial after login (attempt ${attempt}/3), retrying`,
      );
      continue;
    }

    throw new Error("Cathay United Bank login failed.");
  }

  throw new Error(
    "Cathay United Bank login failed after 3 attempts — persistent dirty session interstitial",
  );
}

// ---- Deposit accounts ----

interface DomAccount {
  acctNo: string;
  accountTypeName: string;
  balance: number;
  availableBalance: number;
  currency: string;
}

// Actual API response structure from B_ACCT_Q_TransferDetail
interface TransferDetail {
  txnDateTime?: string | null;
  accountDate?: string | null;
  description?: string | null;
  expendAmt?: number | null;
  incomeAmt?: number | null;
  balance?: number | null;
  specialMemo?: string | null;
  memo?: string | null;
  [key: string]: unknown;
}

interface TransferDetailResponse {
  content?: {
    datas?: Array<{
      accountNumber?: string;
      details?: TransferDetail[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

async function scrapeDomAccounts(page: Page): Promise<DomAccount[]> {
  return page.evaluate(() => {
    const results: Array<{
      acctNo: string;
      accountTypeName: string;
      balance: number;
      availableBalance: number;
      currency: string;
    }> = [];
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    );
    for (const btn of buttons) {
      const text = btn.textContent?.trim() ?? "";
      if (!/^\d{10,}$/.test(text)) continue;
      let el: Element | null = btn;
      for (let i = 0; i < 10; i++) {
        el = el?.parentElement ?? null;
        if (!el) break;
        const rowText = (el as HTMLElement).innerText?.trim() ?? "";
        if (rowText.includes("$") && rowText.length < 200) {
          const amounts = rowText.match(/\$([\d,]+)/g) ?? [];
          const parseAmt = (s: string) =>
            parseInt(s.replace(/[$,]/g, ""), 10) || 0;
          results.push({
            acctNo: text,
            accountTypeName:
              rowText
                .split(text)[0]
                ?.replace(/[●\s]+/g, " ")
                .trim() || "臺幣存款",
            balance: amounts[0] ? parseAmt(amounts[0]) : 0,
            availableBalance: amounts[1] ? parseAmt(amounts[1]) : 0,
            currency: "TWD",
          });
          break;
        }
      }
    }
    return results;
  });
}

// Maps lookbackDays to the period dropdown label in the bank UI
function periodLabel(days: number): string {
  if (days <= 30) return "近 30 天";
  if (days <= 90) return "近 90 天";
  return "近 1 年";
}

async function selectTransactionPeriod(
  page: Page,
  days: number,
): Promise<void> {
  const label = periodLabel(days);
  if (label === "近 30 天") return; // default, no action needed

  // Open the period dropdown (find the one showing days/天)
  const opened = await page.evaluate(() => {
    const dropdowns = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[role='combobox'], button[aria-haspopup]",
      ),
    ).filter(
      (el) =>
        (el as HTMLElement).innerText?.includes("天") ||
        (el as HTMLElement).innerText?.includes("月"),
    );
    if (!dropdowns[0]) return false;
    dropdowns[0].click();
    return true;
  });

  if (!opened) {
    console.log("[cathaybk] could not open period dropdown, using default");
    return;
  }

  await new Promise((r) => setTimeout(r, 500));

  const clicked = await page.evaluate((targetLabel: string) => {
    const opts = Array.from(
      document.querySelectorAll<HTMLElement>("[role='option'], li"),
    ).filter((el) => el.textContent?.trim() === targetLabel);
    if (!opts[0]) return false;
    opts[0].click();
    return true;
  }, label);

  if (!clicked) {
    console.log(`[cathaybk] period option "${label}" not found, using default`);
    return;
  }

  await new Promise((r) => setTimeout(r, 300));
  console.log(`[cathaybk] set period to "${label}"`);
}

async function scrapeDeposits(
  page: Page,
  lookbackDays: number,
): Promise<Scraped> {
  const bankAccounts: Scraped["bankAccounts"] = [];
  const bankBalanceSnapshots: Scraped["bankBalanceSnapshots"] = [];
  const bankTransactions: Scraped["bankTransactions"] = [];
  const asOfAt = new Date().toISOString();

  await page.goto(DEPOSIT_OVERVIEW_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  console.log("[cathaybk] deposit page opened");
  if (page.url().includes("/logout/")) {
    throw new Error("Cathay Bank forced logout on deposit page.");
  }

  // Wait for account number buttons to render
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some((b) =>
          /^\d{10,}$/.test(b.textContent?.trim() ?? ""),
        ),
      { timeout: 15000 },
    )
    .catch(() => null);

  const accounts = await scrapeDomAccounts(page);
  console.log(`[cathaybk] found ${accounts.length} deposit accounts`);

  for (const acct of accounts) {
    const sourceId = `bank:cathaybk:${acct.acctNo}`;

    bankAccounts.push({
      sourceId,
      institutionName: "國泰世華銀行",
      accountName: acct.accountTypeName || "國泰臺幣帳戶",
      accountType: "savings",
      currency: acct.currency,
      raw: acct,
    });

    bankBalanceSnapshots.push({
      accountId: sourceId,
      sourceId: `${sourceId}:${asOfAt}`,
      balance: acct.balance,
      availableBalance: acct.availableBalance || undefined,
      currency: acct.currency,
      asOfAt,
      raw: acct,
    });

    // Click account button → navigates to B0103 (transaction detail page)
    const initialTxPromise = page
      .waitForResponse(
        (r) => r.url().includes(API_DEPOSIT_TX) && r.status() === 200,
        { timeout: 30000 },
      )
      .catch(() => null);

    const clicked = await page.evaluate((acctNo: string) => {
      const btn = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent?.trim() === acctNo);
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, acct.acctNo);

    if (!clicked) {
      console.log(
        `[cathaybk] no button found for account ${maskAccountNumber(acct.acctNo)}`,
      );
      continue;
    }

    await page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => null);

    let txRsp = null;

    if (lookbackDays > 30) {
      // Initial page load triggered API with default 30-day period; re-query with desired period
      const reTxPromise = page
        .waitForResponse(
          (r) => r.url().includes(API_DEPOSIT_TX) && r.status() === 200,
          { timeout: 30000 },
        )
        .catch(() => null);

      await selectTransactionPeriod(page, lookbackDays);

      await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button"),
        ).find((b) => b.textContent?.trim() === "查詢");
        btn?.click();
      });

      txRsp = await reTxPromise;
    } else {
      txRsp = await initialTxPromise;
    }

    const txData: TransferDetailResponse = txRsp
      ? ((await txRsp.json().catch(() => ({}))) as TransferDetailResponse)
      : {};

    const datas = txData.content?.datas ?? [];
    const details: TransferDetail[] = datas.flatMap((d) => d.details ?? []);
    console.log(
      `[cathaybk] account ${maskAccountNumber(acct.acctNo)}: ${details.length} tx (period=${periodLabel(lookbackDays)})`,
    );

    appendDepositTransactions(
      bankTransactions,
      details,
      sourceId,
      acct.currency,
    );

    // Return to deposit overview for next account
    await page.goto(DEPOSIT_OVERVIEW_URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll("button")).some((b) =>
            /^\d{10,}$/.test(b.textContent?.trim() ?? ""),
          ),
        { timeout: 10000 },
      )
      .catch(() => null);
  }

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
    creditCardBills: [],
  };
}

function appendDepositTransactions(
  target: Scraped["bankTransactions"],
  details: TransferDetail[],
  accountId: string,
  currency: string,
) {
  const seen = new Map<string, number>();
  for (const d of details) {
    const date = normalizeDateStr(d.txnDateTime ?? d.accountDate);
    // incomeAmt = money in (positive), expendAmt = money out (positive value = debit)
    const income = typeof d.incomeAmt === "number" ? d.incomeAmt : 0;
    const expend = typeof d.expendAmt === "number" ? d.expendAmt : 0;
    const amount = income > 0 ? income : expend > 0 ? -expend : 0;
    const desc =
      [d.description, d.memo].filter(Boolean).join(" ").trim() ||
      "國泰世華交易";
    const key = [date, accountId, amount, desc].join(":");
    const occ = (seen.get(key) ?? 0) + 1;
    seen.set(key, occ);
    target.push({
      accountId,
      sourceId: `${key}:${occ}`,
      postedDate: date,
      amount,
      currency,
      description: desc,
      raw: { ...d, duplicateOccurrence: occ },
    });
  }
}

// ---- Credit cards ----

interface HistoryBillItem {
  billDate: string;
  twdAmount: number | null;
  usdAmount: number | null;
  billStatus: string;
}

interface TradeItem {
  consumeDate: string | null;
  transDesc: string;
  amount: number;
  currency: string;
}

interface BillDetailSection {
  detailType: string;
  tradeData: TradeItem[] | null;
}

interface MonthDetail {
  billDate: string;
  twdAmount: number | null;
  sections: BillDetailSection[];
}

export async function scrapeCreditCards(page: Page): Promise<Scraped> {
  const bankAccounts: Scraped["bankAccounts"] = [];
  const bankBalanceSnapshots: Scraped["bankBalanceSnapshots"] = [];
  const bankTransactions: Scraped["bankTransactions"] = [];
  const creditCardBills: Scraped["creditCardBills"] = [];
  const asOfAt = new Date().toISOString();

  // ── C0101: card overview (DOM) ─────────────────────────────────────────
  await page.goto(CREDIT_CARD_OVERVIEW_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  console.log("[cathaybk] credit card overview opened");
  await new Promise((r) => setTimeout(r, 2000));

  const cardOverview = await page.evaluate(() => {
    const text = document.body.innerText;
    const parseAmt = (s: string | undefined) =>
      parseInt((s ?? "").replace(/[^\d]/g, ""), 10) || 0;
    const last4Match = text.match(/卡片末四碼[：:]\s*(\d{4})/);
    const cardNameMatch = text.match(
      /([^\n]+?(?:MasterCard|VISA|JCB|銀聯)[^\n]*)/,
    );
    const limitMatch = text.match(/永久信用額度\s*(?:TWD\s*)?([\d,]+)/);
    const availMatch = text.match(
      /剩餘可用額度[\s\S]{0,20}?(?:TWD\s*)?([\d,]+)/,
    );
    const dueDateMatch = text.match(
      /繳款截止日[\s\S]{0,10}?(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,
    );
    const noPaymentNeeded = text.includes("無需繳費");
    const unpaidMatch = !noPaymentNeeded
      ? text.match(
          /(?:應繳|未繳)(?:金額|餘額)?[\s\S]{0,20}?(?:TWD\s*)?([\d,]+)/,
        )
      : null;
    return {
      cardDetected: Boolean(last4Match),
      last4: last4Match?.[1] ?? "",
      cardName: last4Match
        ? `國泰信用卡 末四碼 ${last4Match[1]}`
        : (cardNameMatch?.[1]?.trim() ?? "國泰信用卡"),
      creditLimit: parseAmt(limitMatch?.[1]),
      availableCredit: parseAmt(availMatch?.[1]),
      unpaidAmount: noPaymentNeeded ? 0 : parseAmt(unpaidMatch?.[1]),
      paymentDueDate: dueDateMatch?.[1]?.replace(/\//g, "-") ?? null,
      noPaymentNeeded,
    };
  });

  console.log(
    JSON.stringify({
      event: "cathaybk_card_overview_parsed",
      cardDetected: cardOverview.cardDetected,
      paymentDueDateAvailable: Boolean(cardOverview.paymentDueDate),
      noPaymentNeeded: cardOverview.noPaymentNeeded,
    }),
  );

  if (!cardOverview.cardDetected) {
    console.log(
      "[cathaybk] no credit card detected; skipping card account and bills",
    );
    return {
      bankAccounts,
      bankBalanceSnapshots,
      bankTransactions,
      creditCardBills,
    };
  }

  // ponytail: always use main — CathayBK pools limit across all cards
  const sourceId = "credit:cathaybk:main";

  bankAccounts.push({
    sourceId,
    institutionName: "國泰世華銀行",
    accountName: cardOverview.cardName,
    accountType: "credit",
    currency: "TWD",
    creditLimit: cardOverview.creditLimit || undefined,
    raw: cardOverview,
  });

  bankBalanceSnapshots.push({
    accountId: sourceId,
    sourceId: `${sourceId}:${asOfAt}`,
    balance: -cardOverview.unpaidAmount,
    availableBalance: cardOverview.availableCredit || undefined,
    paymentDueDate: cardOverview.paymentDueDate ?? undefined,
    noPaymentNeeded: cardOverview.noPaymentNeeded,
    currency: "TWD",
    asOfAt,
    raw: cardOverview,
  });

  // ── C0102: bill history + transactions via OnlineBankingApi ───────────
  await page.goto(CREDIT_CARD_BILL_URL, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await new Promise((r) => setTimeout(r, 2000));

  const apiResult = (await page.evaluate(async (maxMonths: number) => {
    // Get JWT + customerId
    const jwtData = await new Promise<{ token: string; customerId: string }>(
      (resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/MyBank/Customized/GetJWT");
        xhr.withCredentials = true;
        xhr.onload = () => {
          try {
            const d = JSON.parse(xhr.responseText).Data;
            resolve({ token: d.JwtToken, customerId: d.CustomerId });
          } catch {
            resolve({ token: "", customerId: "" });
          }
        };
        xhr.onerror = () => resolve({ token: "", customerId: "" });
        xhr.send();
      },
    );

    if (!jwtData.token) return null;

    const { token: jwt, customerId } = jwtData;

    // ponytail: functionSeqNo format observed from browser: YYYYMMDDHHmmss + UUID
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const functionSeqNo = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${crypto.randomUUID()}`;

    function xhrPost(
      endpoint: string,
      extra: Record<string, unknown> = {},
    ): Promise<unknown> {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          "POST",
          `/OnlineBankingApi/ClientCard/Api/ClientCard/${endpoint}`,
        );
        xhr.withCredentials = true;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", `Bearer ${jwt}`);
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve(null);
          }
        };
        xhr.onerror = () => resolve(null);
        xhr.send(
          JSON.stringify({ functionSeqNo, content: { customerId, ...extra } }),
        );
      });
    }

    // 1. Get list of available historical months (bank provides up to 12)
    const historyResp = (await xhrPost("C_BILL_Q_HistoryBillList")) as {
      content?: { historyBillInfoList?: unknown[] };
    } | null;
    const allBills = (historyResp?.content?.historyBillInfoList ??
      []) as Array<{
      billDate: string;
      twdAmount: number | null;
      usdAmount: number | null;
      billStatus: string;
    }>;

    const targetBills = allBills.slice(0, maxMonths);

    // 2. Get transaction details for each month
    const monthDetails: Array<{
      billDate: string;
      twdAmount: number | null;
      sections: unknown[];
    }> = [];
    for (const bill of targetBills) {
      const detail = (await xhrPost("C_BILL_Q_RecentBillDetail", {
        billDate: bill.billDate,
      })) as {
        content?: { twdBillDetailInfo?: unknown[] };
      } | null;
      monthDetails.push({
        billDate: bill.billDate,
        twdAmount: bill.twdAmount,
        sections: detail?.content?.twdBillDetailInfo ?? [],
      });
    }

    return { allBills: targetBills, monthDetails };
  }, BANK_SYNC_MONTHS)) as {
    allBills: HistoryBillItem[];
    monthDetails: MonthDetail[];
  } | null;

  if (!apiResult) {
    console.log("[cathaybk] credit card API failed — no bill data");
    return {
      bankAccounts,
      bankBalanceSnapshots,
      bankTransactions,
      creditCardBills,
    };
  }

  console.log(
    `[cathaybk] fetched ${apiResult.allBills.length} historical bills`,
  );

  // Build creditCardBills from history list
  const latestBillDate = apiResult.allBills[0]?.billDate;
  for (const bill of apiResult.allBills) {
    const period = bill.billDate.slice(0, 7); // "YYYY-MM"
    const isLatest = bill.billDate === latestBillDate;
    creditCardBills.push({
      accountId: sourceId,
      sourceId: `${sourceId}:bill:${period}`,
      billingPeriod: period,
      statementAmount: bill.twdAmount ?? undefined,
      statementClosingDate: bill.billDate.slice(0, 10),
      paymentDueDate: isLatest
        ? (cardOverview.paymentDueDate ?? undefined)
        : undefined,
      isPaid: isLatest ? cardOverview.noPaymentNeeded : true,
      currency: "TWD",
      raw: bill,
    });
  }

  console.log(`[cathaybk] credit card bills: ${creditCardBills.length}`);

  // Build bankTransactions from bill details (skip carry-forward summary rows)
  const seen = new Map<string, number>();
  for (const month of apiResult.monthDetails) {
    for (const section of month.sections as BillDetailSection[]) {
      if (section.detailType === "LastBillAmount") continue;
      for (const trade of section.tradeData ?? []) {
        if (!trade.amount) continue;
        const date = normalizeDateStr(trade.consumeDate ?? month.billDate);
        const desc = trade.transDesc || "國泰信用卡消費";
        const key = [date, sourceId, trade.amount, desc].join(":");
        const occ = (seen.get(key) ?? 0) + 1;
        seen.set(key, occ);
        bankTransactions.push({
          accountId: sourceId,
          sourceId: `${key}:${occ}`,
          postedDate: date,
          amount: trade.amount < 0 ? trade.amount : -trade.amount,
          currency: "TWD",
          description: desc,
          raw: {
            ...trade,
            billDate: month.billDate,
            detailType: section.detailType,
            duplicateOccurrence: occ,
          },
        });
      }
    }
  }

  console.log(
    `[cathaybk] credit card transactions: ${bankTransactions.length}`,
  );

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
    creditCardBills,
  };
}

// ---- Utilities ----

function normalizeDateStr(value: unknown): string {
  if (typeof value !== "string") return new Date().toISOString();
  const s = value.trim().replace(/\//g, "-");
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  return s || new Date().toISOString();
}
