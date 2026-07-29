import puppeteer, {
  type Browser,
  type Frame,
  type Page,
} from "@cloudflare/puppeteer";
import {
  parseTaishinCreditCardData,
  type TaishinConfig,
} from "@taiwan-fin-hub/connectors";
import type { SyncResult } from "@taiwan-fin-hub/core";

const RWD_URL = "https://my.taishinbank.com.tw/TIBNetBank/svc/rwd/index.html";
const API_ROOT = "/TIBNetBank/svc";
const SESSION_CHECK_PATH = `${API_ROOT}/web/common/sessioncheck`;
const SUMMARY_PATH = `${API_ROOT}/web4/rb0708rwd/doXTPA`;
const BILL_PATH = `${API_ROOT}/web4/rb0708rwd/init`;
const REALTIME_PATH = `${API_ROOT}/web4/rb0708rwd/qryRealTime`;
export const TAISHIN_AUTO_LOGIN_ATTEMPTS = 3;
const CAPTCHA_KEEP_ALIVE_MS = 150_000;
const CAPTCHA_VALIDITY_MS = 120_000;
const CAPTCHA_IMAGE_TIMEOUT_MS = 10_000;
const CAPTCHA_PAGE_RETRY_ATTEMPTS = 1;
const LOGIN_RESULT_ATTEMPTS = 10;
const LOGIN_RESULT_POLL_MS = 500;
const REQUIRED_API_TIMEOUT_MS = 8_000;
const OPTIONAL_API_TIMEOUT_MS = 4_000;
const REALTIME_RETRY_ATTEMPTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231105.003) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

type JsonRecord = Record<string, unknown>;
type BrowserPage = Page | Frame;

export class TaishinVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaishinVerificationRequiredError";
  }
}

export class TaishinCredentialRejectedError extends TaishinVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "TaishinCredentialRejectedError";
  }
}

export class TaishinCaptchaRejectedError extends TaishinVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "TaishinCaptchaRejectedError";
  }
}

class TaishinLoginOutcomeUnknownError extends TaishinVerificationRequiredError {
  constructor(message: string) {
    super(message);
    this.name = "TaishinLoginOutcomeUnknownError";
  }
}

export class TaishinConnectionError extends Error {
  constructor(
    message: string,
    readonly sessionCookies?: string,
    readonly sessionCreatedAt?: string,
  ) {
    super(message);
    this.name = "TaishinConnectionError";
  }
}

class TaishinCaptchaUnavailableError extends TaishinConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "TaishinCaptchaUnavailableError";
  }
}

class TaishinTransientConnectionError extends TaishinConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "TaishinTransientConnectionError";
  }
}

export class TaishinBrowserCapacityError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds = 20,
  ) {
    super(message);
    this.name = "TaishinBrowserCapacityError";
  }
}

export function createTaishinConnector(
  browser?: Fetcher,
  recognizeCaptcha?: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  return {
    id: "taishin" as const,
    name: "台新銀行",

    async sync(
      config: TaishinConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      requireCredentials(config);
      if (!browser) throw new Error("台新銀行同步需要 BROWSER binding。");

      const browserInstance = await acquireBrowser(
        browser,
        config.browserSessionId,
      );
      const pages = await browserInstance.pages();
      const page = pages[0] ?? (await browserInstance.newPage());
      let authenticated = false;
      try {
        await configurePage(page);
        let loggedIn = false;

        let pageContext: BrowserPage = page;
        if (config.browserSessionId && config.captcha) {
          if (
            !config.browserSessionExpiresAt ||
            new Date(config.browserSessionExpiresAt) <= new Date()
          ) {
            throw new TaishinVerificationRequiredError(
              "台新圖形驗證碼已逾時，請重新取得驗證碼。",
            );
          }
          assertCaptcha(config.captcha, config.captchaDigitCount ?? 6);
          pageContext = await findLoginFrame(page);
          await submitLogin(pageContext, config.captcha);
          loggedIn = true;
        } else if (config.sessionCookies) {
          await importCookies(page, config.sessionCookies);
          await page.goto(RWD_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
          pageContext = await findLoginFrame(page);
          loggedIn = await hasValidSession(pageContext);
        }

        if (!loggedIn) {
          if (!recognizeCaptcha) {
            throw new TaishinVerificationRequiredError(
              "台新銀行 session 已失效，需要重新登入。",
            );
          }
          pageContext = await loginWithOcr(page, config, recognizeCaptcha);
        }
        authenticated = true;

        let payloads;
        try {
          payloads = await fetchCreditCardPayloads(
            pageContext,
            config.lookbackMonths,
          );
        } catch (error) {
          if (
            !(error instanceof TaishinVerificationRequiredError) ||
            !recognizeCaptcha
          ) {
            throw error;
          }
          pageContext = await loginWithOcr(page, config, recognizeCaptcha);
          authenticated = true;
          payloads = await fetchCreditCardPayloads(
            pageContext,
            config.lookbackMonths,
          );
        }
        let data;
        try {
          data = parseTaishinCreditCardData(payloads, config.lookbackMonths);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("台新信用卡 API")
          ) {
            throw new TaishinConnectionError(error.message);
          }
          throw error;
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
        if (authenticated && error instanceof TaishinConnectionError) {
          const sessionCookies = await page
            .cookies()
            .then((cookies) => JSON.stringify(cookies))
            .catch(() => undefined);
          if (sessionCookies) {
            throw new TaishinConnectionError(
              error.message,
              sessionCookies,
              new Date().toISOString(),
            );
          }
        }
        throw error;
      } finally {
        await browserInstance.close();
      }
    },
  };
}

export async function prepareTaishinCaptcha(
  browser: Fetcher | undefined,
  config: TaishinConfig,
) {
  requireCredentials(config);
  if (!browser) throw new Error("台新人工驗證需要 BROWSER binding。");

  const browserInstance = await acquireBrowser(
    browser,
    config.browserSessionId,
  );
  const pages = await browserInstance.pages();
  const page = pages[0] ?? (await browserInstance.newPage());
  let preserved = false;
  try {
    await configurePage(page);
    const { captcha } = await openLoginAndCaptureCaptcha(page, config);
    const sessionId = browserInstance.sessionId();
    await browserInstance.disconnect();
    preserved = true;
    return {
      browserSessionId: sessionId,
      browserSessionExpiresAt: new Date(
        Date.now() + CAPTCHA_VALIDITY_MS,
      ).toISOString(),
      captchaDigitCount: captcha.digitCount,
      captchaImage: `data:image/jpeg;base64,${bytesToBase64(captcha.bytes)}`,
    };
  } finally {
    if (!preserved) await browserInstance.close();
  }
}

async function loginWithOcr(
  page: Page,
  config: TaishinConfig,
  recognizeCaptcha: (
    imageBytes: ArrayBuffer,
    digitCount: number,
  ) => Promise<string>,
) {
  for (let attempt = 1; attempt <= TAISHIN_AUTO_LOGIN_ATTEMPTS; attempt += 1) {
    try {
      const { frame, captcha } = await openLoginAndCaptureCaptcha(page, config);
      const answer = await recognizeCaptcha(
        toArrayBuffer(captcha.bytes),
        captcha.digitCount,
      );
      assertCaptcha(answer, captcha.digitCount);
      await submitLogin(frame, answer);
      return frame;
    } catch (error) {
      if (error instanceof TaishinCredentialRejectedError) throw error;
      if (
        !(error instanceof TaishinCaptchaRejectedError) &&
        !(error instanceof TaishinLoginOutcomeUnknownError)
      ) {
        throw error;
      }
    }
  }
  throw new TaishinVerificationRequiredError(
    `台新自動驗證連續失敗 ${TAISHIN_AUTO_LOGIN_ATTEMPTS} 次，請改用人工驗證。`,
  );
}

async function fetchCreditCardPayloads(
  page: BrowserPage,
  lookbackMonths: number,
) {
  const realtime = await fetchRealtimeTransactions(page);
  let summary: unknown = { value: {}, error: null };
  try {
    summary = await postJson(page, SUMMARY_PATH, {}, OPTIONAL_API_TIMEOUT_MS);
    const billingContext = taishinBillingContext(summary);
    const months = recentMonths(
      Math.max(1, Math.min(6, lookbackMonths)),
      billingContext.anchor,
    );
    const fetchBill = ({ year, month }: (typeof months)[number]) =>
      postJson(
        page,
        BILL_PATH,
        {
          org: billingContext.org,
          byear: String(year),
          bmonth: String(month).padStart(2, "0"),
          cardHolderFlagSelected: "1",
          cardNo: "",
        },
        OPTIONAL_API_TIMEOUT_MS,
      );
    const currentBill = await fetchBill(months[0]!);
    if (!hasBillPayload(currentBill)) {
      return { summary, bills: [], realtime };
    }
    const historicalBills = (
      await Promise.all(
        months.slice(1).map((month) => fetchBill(month).catch(() => undefined)),
      )
    ).filter((bill) => bill !== undefined);
    return {
      summary,
      bills: [currentBill, ...historicalBills],
      realtime,
    };
  } catch (error) {
    if (error instanceof TaishinVerificationRequiredError) throw error;
    if (!(error instanceof TaishinConnectionError)) throw error;
    console.warn(`[taishin] optional bill sync skipped: ${error.message}`);
    return { summary, bills: [], realtime };
  }
}

async function fetchRealtimeTransactions(page: BrowserPage) {
  for (let attempt = 1; attempt <= REALTIME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await postJson(page, REALTIME_PATH, "", REQUIRED_API_TIMEOUT_MS);
    } catch (error) {
      const isBusy =
        error instanceof TaishinConnectionError &&
        /系統忙碌|無法取得資料/.test(error.message);
      const isTransient = error instanceof TaishinTransientConnectionError;
      if (!isBusy && !isTransient) throw error;
      if (attempt < REALTIME_RETRY_ATTEMPTS) {
        console.warn(
          `[taishin] realtime retry ${attempt}/${REALTIME_RETRY_ATTEMPTS}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      } else if (isBusy) {
        console.warn(
          `[taishin] realtime sync skipped after ${attempt} busy responses`,
        );
      } else {
        throw error;
      }
    }
  }
  return { value: { fmtRealTxListMap: [] }, error: null };
}

function hasBillPayload(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.value)) return false;
  return (
    typeof payload.value.showAccoutnYM === "string" &&
    payload.value.showAccoutnYM.trim().length > 0
  );
}

async function hasValidSession(page: BrowserPage) {
  try {
    const payload = await postJson(page, SESSION_CHECK_PATH, {});
    return (
      isRecord(payload) &&
      payload.RESULT !== "EXPIRED" &&
      typeof payload.DBSESSIONID === "string" &&
      payload.DBSESSIONID.length > 0
    );
  } catch {
    return false;
  }
}

async function postJson(
  page: BrowserPage,
  path: string,
  body?: JsonRecord | string,
  timeoutMs = REQUIRED_API_TIMEOUT_MS,
) {
  const response = await page.evaluate(
    async (input: {
      path: string;
      body?: JsonRecord | string;
      timeoutMs: number;
    }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.path, {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type":
              typeof input.body === "string"
                ? "application/x-www-form-urlencoded"
                : "application/json",
          },
          body:
            typeof input.body === "string"
              ? input.body
              : input.body
                ? JSON.stringify(input.body)
                : undefined,
          credentials: "same-origin",
          signal: controller.signal,
        });
        return {
          ok: response.ok,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "",
          text: await response.text(),
          timedOut: false,
          errorName: "",
          errorMessage: "",
        };
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          status: 0,
          contentType: "",
          text: "",
          timedOut: controller.signal.aborted || errorName === "AbortError",
          errorName,
          errorMessage,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    { path, body, timeoutMs },
  );
  const endpoint = path.split("/").at(-1) ?? path;
  if (response.timedOut) {
    throw new TaishinTransientConnectionError(
      `台新信用卡 API ${endpoint} 請求逾時。`,
    );
  }
  if (response.status === 0) {
    const detail = browserFetchErrorDetail(
      response.errorName,
      response.errorMessage,
    );
    throw new TaishinTransientConnectionError(
      `台新信用卡 API ${endpoint} 網路請求失敗${detail ? `（${detail}）` : ""}。`,
    );
  }
  if (!response.ok) {
    const ErrorClass =
      response.status >= 500
        ? TaishinTransientConnectionError
        : TaishinConnectionError;
    throw new ErrorClass(
      `台新信用卡 API ${endpoint} 回應 HTTP ${response.status}。`,
    );
  }
  if (!response.contentType.includes("application/json")) {
    if (/登入|login/i.test(response.text)) {
      throw new TaishinVerificationRequiredError(
        "台新銀行 session 已失效，需要重新登入。",
      );
    }
    throw new TaishinConnectionError("台新信用卡 API 回應不是 JSON。");
  }
  try {
    const payload = JSON.parse(response.text) as unknown;
    if (isRecord(payload) && Boolean(payload.error)) {
      const endpoint = path.split("/").at(-1) ?? path;
      const detail = summarizeApiError(payload.error);
      throw new TaishinConnectionError(
        `台新信用卡 API ${endpoint} 回傳錯誤${detail ? `：${detail}` : ""}。`,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof TaishinConnectionError) throw error;
    throw new TaishinConnectionError("台新信用卡 API 回應格式無效。");
  }
}

function browserFetchErrorDetail(name: string, message: string) {
  const safeName = sanitizeBrowserErrorPart(name, 40);
  const safeMessage = sanitizeBrowserErrorPart(message, 160);
  return [safeName, safeMessage].filter(Boolean).join(": ");
}

function sanitizeBrowserErrorPart(value: string, maxLength: number) {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function openLoginAndFill(page: Page, config: TaishinConfig) {
  await page.goto(RWD_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const frame = await findLoginFrame(page);
  if (await isLoggedIn(frame)) return frame;

  const selectors = await frame.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    );
    const renderedInputs = inputs.filter((input) => {
      const rect = input.getBoundingClientRect();
      return (
        !input.disabled &&
        input.type !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    const candidateInputs =
      renderedInputs.length >= 4
        ? renderedInputs
        : inputs.filter((input) => !input.disabled && input.type !== "hidden");
    const labelText = (input: HTMLInputElement) => {
      const explicit = input.id
        ? document.querySelector<HTMLLabelElement>(
            `label[for="${CSS.escape(input.id)}"]`,
          )?.innerText
        : "";
      const ancestorText = [
        input.parentElement?.innerText,
        input.parentElement?.parentElement?.innerText,
        input.parentElement?.parentElement?.parentElement?.innerText,
      ].find((text) => text && text.length <= 80);
      return [
        input.id,
        input.name,
        input.placeholder,
        input.getAttribute("aria-label"),
        explicit,
        ancestorText,
      ]
        .filter(Boolean)
        .join(" ");
    };
    const mark = (input: HTMLInputElement | undefined, field: string) => {
      if (!input) return "";
      input.dataset.taishinField = field;
      return `input[data-taishin-field="${field}"]`;
    };
    const find = (pattern: RegExp) =>
      candidateInputs.find((input) => pattern.test(labelText(input)));
    const password =
      find(/使用者密碼|password|passwd/i) ??
      candidateInputs.find((input) => input.type === "password");
    const captcha =
      find(/驗證碼|captcha|validate|check.?code/i) ??
      candidateInputs.find(
        (input) =>
          input !== password &&
          input.maxLength >= 4 &&
          input.maxLength <= 8 &&
          (input.inputMode === "numeric" || input.pattern.includes("\\d")),
      ) ??
      candidateInputs.at(-1);
    const identityInputs = candidateInputs.filter(
      (input) =>
        input !== password &&
        input !== captcha &&
        ["", "text", "tel"].includes(input.type),
    );
    const matchedUserId = find(/身分證|統一編號|cust(?:omer)?id/i);
    const userId =
      matchedUserId && matchedUserId !== password && matchedUserId !== captcha
        ? matchedUserId
        : identityInputs[0];
    const matchedAccount = find(
      /使用者代(?:號|碼)|登入代(?:號|碼)|user(?:id|code)/i,
    );
    const account =
      matchedAccount &&
      matchedAccount !== userId &&
      matchedAccount !== password &&
      matchedAccount !== captcha
        ? matchedAccount
        : identityInputs.find((input) => input !== userId);
    return {
      userId: mark(userId, "user-id"),
      account: mark(account, "account"),
      password: mark(password, "password"),
      captcha: mark(captcha, "captcha"),
    };
  });
  if (
    !selectors.userId ||
    !selectors.account ||
    !selectors.password ||
    !selectors.captcha
  ) {
    throw new TaishinConnectionError("台新登入頁欄位結構已變更。");
  }
  await typeInput(frame, selectors.userId, config.userId!);
  await typeInput(frame, selectors.account, config.account!);
  await typeInput(frame, selectors.password, config.password!);
  return frame;
}

async function openLoginAndCaptureCaptcha(page: Page, config: TaishinConfig) {
  for (let retry = 0; retry <= CAPTCHA_PAGE_RETRY_ATTEMPTS; retry += 1) {
    const frame = await openLoginAndFill(page, config);
    try {
      return { frame, captcha: await captureCaptcha(frame) };
    } catch (error) {
      if (
        !(error instanceof TaishinCaptchaUnavailableError) ||
        retry >= CAPTCHA_PAGE_RETRY_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
  throw new TaishinCaptchaUnavailableError(
    "台新登入頁沒有在期限內取得圖形驗證碼。",
  );
}

async function typeInput(page: BrowserPage, selector: string, value: string) {
  await page.type(selector, value);
}

async function captureCaptcha(page: BrowserPage) {
  try {
    await page.waitForFunction(
      () => {
        const captchaInput = document.querySelector<HTMLInputElement>(
          'input[data-taishin-field="captcha"]',
        );
        if (!captchaInput) return false;
        const images = Array.from(
          document.querySelectorAll<HTMLImageElement>("img"),
        );
        const isHinted = (image: HTMLImageElement) => {
          const hint = [image.id, image.className, image.alt, image.src].join(
            " ",
          );
          return /captcha|驗證|validate|check.?code|verify.?code|shuffle/i.test(
            hint,
          );
        };
        const hasHintedImage = images.some(isHinted);
        return images.some((image) => {
          if (!image.complete || image.naturalWidth <= 0) return false;
          const rect = image.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 20) return false;
          if (hasHintedImage && !isHinted(image)) return false;
          return true;
        });
      },
      { timeout: CAPTCHA_IMAGE_TIMEOUT_MS },
    );
  } catch {
    throw new TaishinCaptchaUnavailableError(
      "台新登入頁沒有在期限內取得圖形驗證碼。",
    );
  }
  const target = await page.evaluate(() => {
    const captchaInput = document.querySelector<HTMLInputElement>(
      'input[data-taishin-field="captcha"]',
    );
    if (!captchaInput) return undefined;
    const inputRect = captchaInput.getBoundingClientRect();
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>("img"),
    )
      .filter((image) => image.complete && image.naturalWidth > 0)
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const hint = [image.id, image.className, image.alt, image.src].join(
          " ",
        );
        return {
          image,
          score:
            (/captcha|驗證|validate|check.?code|verify.?code|shuffle/i.test(
              hint,
            )
              ? 1000
              : 0) -
            Math.abs(rect.top - inputRect.top) -
            Math.abs(rect.left - inputRect.right),
          width: rect.width,
          height: rect.height,
        };
      })
      .filter(({ width, height }) => width >= 50 && height >= 20)
      .sort((left, right) => right.score - left.score);
    const image = images[0]?.image;
    if (!image) return undefined;
    image.dataset.taishinCaptcha = "image";
    const declaredLength = captchaInput.maxLength;
    return {
      selector: 'img[data-taishin-captcha="image"]',
      digitCount:
        declaredLength >= 4 && declaredLength <= 8 ? declaredLength : 6,
    };
  });
  if (!target) {
    throw new TaishinCaptchaUnavailableError(
      "台新登入頁沒有在期限內取得圖形驗證碼。",
    );
  }
  const image = await page.$(target.selector);
  if (!image) throw new TaishinConnectionError("台新圖形驗證碼已失效。");
  const bytes = await image.screenshot({ type: "jpeg" });
  return { bytes, digitCount: target.digitCount };
}

async function submitLogin(page: BrowserPage, captcha: string) {
  const captchaInput =
    'input[data-taishin-field="captcha"], input[placeholder*="驗證碼"]';
  await typeInput(page, captchaInput, captcha);
  const loginButton = await page.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      value?.replace(/\s+/g, "").trim() ?? "";
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      const label =
        element.tagName === "INPUT"
          ? (element as HTMLInputElement).value
          : element.innerText;
      return (
        !element.hidden &&
        !("disabled" in element && Boolean(element.disabled)) &&
        element.getAttribute("aria-disabled") !== "true" &&
        rect.width > 0 &&
        rect.height > 0 &&
        [label, element.getAttribute("aria-label"), element.title].some(
          (value) => normalize(value) === "登入網銀",
        )
      );
    });
    const target =
      candidates.find((element) =>
        element.matches(
          'button, a, input[type="button"], input[type="submit"], [role="button"], [class*="btn"], [class*="button"]',
        ),
      ) ?? candidates.at(-1);
    if (!target) return false;
    target.dataset.taishinLogin = "submit";
    target.click();
    return true;
  });
  if (!loginButton) {
    throw new TaishinConnectionError("台新登入按鈕結構已變更。");
  }

  for (let attempt = 0; attempt < LOGIN_RESULT_ATTEMPTS; attempt += 1) {
    const detail = await readLoginDetail(page);
    if (isCaptchaRejected(detail)) {
      throw new TaishinCaptchaRejectedError("台新圖形驗證碼錯誤。");
    }
    if (isCredentialRejected(detail)) {
      throw new TaishinCredentialRejectedError(
        "台新登入資料遭銀行拒絕，請確認設定。",
      );
    }
    if (/USER\s*正在線上.*無法登入/i.test(detail)) {
      throw new TaishinVerificationRequiredError(
        "台新網銀已有使用中連線，請先登出後再試。",
      );
    }
    if (await hasValidSession(page)) return;
    if (attempt < LOGIN_RESULT_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, LOGIN_RESULT_POLL_MS));
    }
  }

  throw new TaishinLoginOutcomeUnknownError(
    "台新銀行登入失敗，請改用人工驗證。",
  );
}

async function readLoginDetail(page: BrowserPage) {
  return page
    .evaluate(() =>
      (document.body?.innerText ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1_000),
    )
    .catch(() => "");
}

function isCaptchaRejected(detail: string) {
  return (
    /驗證碼.{0,30}(?:錯誤|有誤|不正確|無效)/.test(detail) ||
    /(?:錯誤|有誤|不正確|無效).{0,30}驗證碼/.test(detail)
  );
}

function isCredentialRejected(detail: string) {
  const field = "(?:密碼|使用者代(?:號|碼)|身分證(?:字號)?|統一編號)";
  const failure = "(?:錯誤|有誤|不正確|無效)";
  return (
    new RegExp(`${field}.{0,30}${failure}`).test(detail) ||
    new RegExp(`${failure}.{0,30}${field}`).test(detail)
  );
}

async function isLoggedIn(page: BrowserPage) {
  return page
    .evaluate(
      () =>
        document.body.innerText.includes("帳戶總覽") &&
        !document.body.innerText.includes("身分證字號"),
    )
    .catch(() => false);
}

async function findLoginFrame(page: Page): Promise<BrowserPage> {
  if (!page.frames) return page;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const frames = page.frames();
    for (const frame of frames) {
      const state = await frame
        .evaluate(() => ({
          text: document.body?.innerText ?? "",
          inputCount: document.querySelectorAll("input").length,
        }))
        .catch(() => ({ text: "", inputCount: 0 }));
      if (state.text.includes("帳戶總覽") || state.inputCount >= 4) {
        return frame;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return page.mainFrame();
}

function recentMonths(count: number, anchor = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - index, 1),
    );
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  });
}

function taishinBillingContext(summary: unknown) {
  const value =
    isRecord(summary) && isRecord(summary.value) ? summary.value : undefined;
  const knownOrganizations = ["001", "055", "100"];
  const org =
    knownOrganizations.find((candidate) => isRecord(value?.[candidate])) ??
    "001";
  const account = isRecord(value?.[org]) ? value[org] : undefined;
  const statementDate =
    typeof account?.["OUT-DTE-LST-STMT"] === "string"
      ? account["OUT-DTE-LST-STMT"]
      : "";
  const match = /^(\d{4})(\d{2})\d{2}$/.exec(statementDate);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const anchor =
    year >= 2000 && month >= 1 && month <= 12
      ? new Date(Date.UTC(year, month - 1, 1))
      : new Date();
  return { org, anchor };
}

async function importCookies(page: Page, serialized: string) {
  let cookies: unknown;
  try {
    cookies = JSON.parse(serialized);
  } catch {
    throw new TaishinVerificationRequiredError(
      "台新銀行 session 格式無效，需要重新登入。",
    );
  }
  if (!Array.isArray(cookies)) {
    throw new TaishinVerificationRequiredError(
      "台新銀行 session 格式無效，需要重新登入。",
    );
  }
  const safeCookies = cookies.filter(isRecord).filter((cookie) => {
    const domain = String(cookie.domain ?? "")
      .replace(/^\./, "")
      .toLowerCase();
    return (
      !domain ||
      domain === "my.taishinbank.com.tw" ||
      domain.endsWith(".taishinbank.com.tw")
    );
  });
  if (safeCookies.length === 0) return;
  await page.setCookie(
    ...(safeCookies as unknown as Parameters<Page["setCookie"]>),
  );
}

async function acquireBrowser(browser: Fetcher, preferredSessionId?: string) {
  if (preferredSessionId) {
    const sessions = await puppeteer.sessions(browser).catch(() => []);
    const preferred = sessions.find(
      (session) => session.sessionId === preferredSessionId,
    );
    if (preferred?.connectionId) {
      throw new TaishinBrowserCapacityError(
        "台新驗證碼正在使用中，請稍候再試。",
        3,
      );
    }
    if (preferred) {
      try {
        return await puppeteer.connect(browser, preferred.sessionId);
      } catch {
        throw new TaishinBrowserCapacityError(
          "前一個台新驗證工作階段尚未釋放，請稍候再試。",
          3,
        );
      }
    }
  }
  const limits = await puppeteer.limits(browser).catch(() => undefined);
  if (limits && limits.allowedBrowserAcquisitions < 1) {
    throw new TaishinBrowserCapacityError(
      "Cloudflare 瀏覽器啟動頻率已達上限，請稍後再試。",
      Math.max(
        1,
        Math.ceil(limits.timeUntilNextAllowedBrowserAcquisition / 1000),
      ),
    );
  }
  return launchBrowser(browser, { keep_alive: CAPTCHA_KEEP_ALIVE_MS });
}

async function launchBrowser(
  browser: Fetcher,
  options?: { keep_alive?: number },
): Promise<Browser> {
  try {
    return await puppeteer.launch(browser, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Browser time limit exceeded for today/i.test(message)) {
      throw new TaishinBrowserCapacityError(
        "Cloudflare 瀏覽器今日使用額度已用完。",
        60,
      );
    }
    if (/code:\s*429|rate limit exceeded/i.test(message)) {
      throw new TaishinBrowserCapacityError(
        "Cloudflare 瀏覽器暫時達到使用上限。",
        20,
      );
    }
    throw error;
  }
}

async function configurePage(page: Page) {
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.setUserAgent(USER_AGENT);
}

function requireCredentials(config: TaishinConfig) {
  if (!config.userId || !config.account || !config.password) {
    throw new TaishinVerificationRequiredError(
      "請先儲存台新身分證字號、使用者代號與使用者密碼。",
    );
  }
}

function assertCaptcha(value: string, digitCount: number) {
  if (!new RegExp(`^\\d{${digitCount}}$`).test(value)) {
    throw new TaishinCaptchaRejectedError(
      `台新驗證碼必須是 ${digitCount} 位數字。`,
    );
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
  for (let index = 0; index < binary.length; index += 1)
    decoded[index] = binary.charCodeAt(index);
  return decoded.buffer;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeApiError(value: unknown) {
  const serialized =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();
  return serialized
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！]+$/, "")
    .slice(0, 300);
}
