import type { SyncResult } from "@taiwan-fin-hub/core";
import forge from "node-forge";
import {
  getSkbankAccountQueries,
  parseSkbankData,
  SkbankProtocolError,
  type SkbankConfig,
  type SkbankTransactionPayload,
} from "./skbank";
import { BANK_SYNC_MONTHS } from "./sync-window";
import {
  hasSkbankCreditCard,
  parseSkbankCreditCardData,
} from "./skbank-credit-card";

const SKBANK_ORIGIN = "https://mbanking.skbank.com.tw";
const APP_CONFIG_PATH = "/api/v1/Common/GetAppConfig";
const LOGIN_PATH = "/api/v2/Authentication/Login";
const USER_INFORMATION_PATH = "/api/v1/Foundation/GetUserInformation";
const MEGA_MENU_PATH = "/api/v1/Common/GetMegaMenuStatus";
const ACCOUNT_SUMMARY_PATH = "/api/v1/Account/GetAccountSummary";
const FOREIGN_ACCOUNT_SUMMARY_PATH =
  "/api/v1/Account/GetForeignCurrencyAccountSummary";
const ASSETS_OVERVIEW_PATH = "/api/v1/Account/GetAssetsOverview";
const CREDIT_CARD_SUMMARY_PATH = "/api/v1/CreditCard/GetSummary";
const CREDIT_CARD_INFORMATION_PATH =
  "/api/v1/CreditCard/GetMyCreditCardsInformation";
const CREDIT_CARD_BILLING_HISTORY_PATH = "/api/v1/CreditCard/GetBillingHistory";
const CREDIT_CARD_REMAINING_DUE_PATH = "/api/v1/CreditCard/GetRemainingDue";
const TRANSACTION_DETAILS_PATH = "/api/v1/Account/FetchTransactionDetails";
const FOREIGN_TRANSACTION_DETAILS_PATH =
  "/api/v1/Account/FetchForeignCurrencyTransactionDetails";
const LOGOUT_PATH = "/api/v1/Authentication/Logout";
const SKBANK_APP_VERSION = "5.8.5";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TRANSACTION_PAGE_SIZE = 100;
const MAX_TRANSACTION_PAGES = 100;
const SAFE_ENDPOINT_NAMES = new Map<string, string>([
  [APP_CONFIG_PATH, "Common.GetAppConfig"],
  [LOGIN_PATH, "Authentication.Login"],
  [USER_INFORMATION_PATH, "Foundation.GetUserInformation"],
  [MEGA_MENU_PATH, "Common.GetMegaMenuStatus"],
  [ACCOUNT_SUMMARY_PATH, "Account.GetAccountSummary"],
  [FOREIGN_ACCOUNT_SUMMARY_PATH, "Account.GetForeignCurrencyAccountSummary"],
  [ASSETS_OVERVIEW_PATH, "Account.GetAssetsOverview"],
  [TRANSACTION_DETAILS_PATH, "Account.FetchTransactionDetails"],
  [
    FOREIGN_TRANSACTION_DETAILS_PATH,
    "Account.FetchForeignCurrencyTransactionDetails",
  ],
  [CREDIT_CARD_SUMMARY_PATH, "CreditCard.GetSummary"],
  [CREDIT_CARD_INFORMATION_PATH, "CreditCard.GetMyCreditCardsInformation"],
  [CREDIT_CARD_BILLING_HISTORY_PATH, "CreditCard.GetBillingHistory"],
  [CREDIT_CARD_REMAINING_DUE_PATH, "CreditCard.GetRemainingDue"],
  [LOGOUT_PATH, "Authentication.Logout"],
]);

type JsonRecord = Record<string, unknown>;
type SkbankCredentials = Required<
  Pick<SkbankConfig, "nationalId" | "alias" | "password">
>;
export type SkbankFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class SkbankVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkbankVerificationRequiredError";
  }
}

export class SkbankConnectionError extends Error {
  constructor(message = "新光銀行資料同步暫時無法完成。") {
    super(message);
    this.name = "SkbankConnectionError";
  }
}

export function requireSkbankCredentials(
  config: Pick<SkbankConfig, "nationalId" | "alias" | "password">,
): SkbankCredentials {
  if (
    !validCredential(config.nationalId, 32, true) ||
    !validCredential(config.alias, 128) ||
    !validCredential(config.password, 128)
  ) {
    throw new SkbankVerificationRequiredError(
      "請先儲存新光銀行身分證字號、使用者代號與網銀密碼。",
    );
  }
  return {
    nationalId: config.nationalId,
    alias: config.alias,
    password: config.password,
  };
}

export function buildSkbankLoginRequest(
  credentials: SkbankCredentials,
  publicKey: { modulus: string; exponent: string },
) {
  const payload = {
    Alias: encryptRsaHex(
      credentials.alias,
      publicKey.modulus,
      publicKey.exponent,
    ),
    Channel: "InternetBankingMember",
    FidoToken: "",
    FidoVerifyNumber: "",
    Method: "General",
    NationalIdNumber: credentials.nationalId,
    Password: encryptRsaHex(
      credentials.password,
      publicKey.modulus,
      publicKey.exponent,
    ),
  };
  const payloadText = JSON.stringify({ Payload: payload });
  const secret = sha256Hex(credentials.nationalId);
  const hmac = forge.hmac.create();
  hmac.start("sha256", secret);
  hmac.update(payloadText);
  const signature = forge.util.encode64(hmac.digest().getBytes());
  return {
    body: JSON.stringify({ Payload: payload, Signature: signature }),
    payloadText,
    signature,
  };
}

export function classifySkbankError(error: unknown) {
  if (
    error instanceof SkbankVerificationRequiredError ||
    error instanceof SkbankConnectionError ||
    error instanceof SkbankProtocolError
  ) {
    return error;
  }
  return new SkbankConnectionError();
}

export function buildSkbankApiDiagnostic(
  path: string,
  returnCode: unknown,
  returnMessage: unknown,
) {
  const message = safeProviderMessage(returnMessage);
  return {
    event: "skbank_api_rejected",
    endpoint: SAFE_ENDPOINT_NAMES.get(path) ?? "Unknown",
    returnCode: safeReturnCode(returnCode),
    ...(message ? { returnMessage: message } : {}),
  };
}

export function createSkbankConnector(
  fetcher: SkbankFetch = globalThis.fetch.bind(globalThis),
) {
  return {
    id: "skbank" as const,
    name: "新光銀行",

    async sync(
      config: SkbankConfig,
      cursor?: string,
    ): Promise<SyncResult<never>> {
      const credentials = requireSkbankCredentials(config);
      const deviceId =
        config.deviceId ?? deviceIdFromCursor(cursor) ?? crypto.randomUUID();
      const session = new SkbankMobileSession(fetcher, deviceId);
      try {
        const publicKey = await session.getPublicKey();
        await session.login(credentials, publicKey);
        await session.get(USER_INFORMATION_PATH);
        await session.get(MEGA_MENU_PATH);
        const accountSummary = await session.get(ACCOUNT_SUMMARY_PATH);
        const foreignCurrencySummary = await session.get(
          FOREIGN_ACCOUNT_SUMMARY_PATH,
        );
        const assetsOverview = await session.get(ASSETS_OVERVIEW_PATH);
        const accountQueries = getSkbankAccountQueries(
          accountSummary,
          foreignCurrencySummary,
        );
        const now = new Date();
        const range = transactionDateRange(now);
        const transactionPayloads: SkbankTransactionPayload[] = [];
        for (const account of accountQueries) {
          const pages = await session.fetchTransactionPages(
            account.accountNumber,
            account.currency,
            range,
          );
          transactionPayloads.push(
            ...pages.map((payload) => ({
              accountNumber: account.accountNumber,
              currency: account.currency,
              payload,
            })),
          );
        }
        const parsed = parseSkbankData(
          accountSummary,
          foreignCurrencySummary,
          transactionPayloads,
          now,
        );
        const creditCard = hasSkbankCreditCard(assetsOverview)
          ? parseSkbankCreditCardData(
              {
                assetsOverview,
                summary: await session.get(CREDIT_CARD_SUMMARY_PATH),
                cards: await session.get(CREDIT_CARD_INFORMATION_PATH),
                billingHistory: await session.get(
                  CREDIT_CARD_BILLING_HISTORY_PATH,
                ),
                remainingDue: await session.get(CREDIT_CARD_REMAINING_DUE_PATH),
              },
              now,
            )
          : parseSkbankCreditCardData({ assetsOverview }, now);
        return {
          records: [],
          bankAccounts: [...parsed.bankAccounts, ...creditCard.bankAccounts],
          bankBalanceSnapshots: [
            ...parsed.bankBalanceSnapshots,
            ...creditCard.bankBalanceSnapshots,
          ],
          bankTransactions: parsed.bankTransactions,
          creditCardBills: creditCard.creditCardBills,
          cursor: JSON.stringify({
            syncedAt: now.toISOString(),
            deviceId,
          }),
        };
      } catch (error) {
        throw classifySkbankError(error);
      } finally {
        await session.logout();
      }
    },
  };
}

class SkbankMobileSession {
  private accessToken = "";
  private loggedIn = false;

  constructor(
    private readonly fetcher: SkbankFetch,
    private readonly deviceId: string,
  ) {}

  async getPublicKey() {
    const data = await this.get(APP_CONFIG_PATH, false);
    const publicKey = isRecord(data.PublicKey) ? data.PublicKey : {};
    const modulus = stringValue(publicKey.Module).trim();
    const exponent = stringValue(publicKey.Exponent).trim();
    if (!/^[0-9a-f]+$/i.test(modulus) || !/^[0-9a-f]+$/i.test(exponent)) {
      throw new SkbankProtocolError(
        "新光銀行登入公鑰格式已變更，暫時無法同步。",
      );
    }
    return { modulus, exponent };
  }

  async login(
    credentials: SkbankCredentials,
    publicKey: { modulus: string; exponent: string },
  ) {
    const request = buildSkbankLoginRequest(credentials, publicKey);
    const envelope = await this.request(LOGIN_PATH, {
      method: "POST",
      headers: this.headers(),
      body: request.body,
    });
    if (envelope.returnCode !== "0000") {
      console.warn(
        JSON.stringify(
          buildSkbankApiDiagnostic(
            LOGIN_PATH,
            envelope.returnCode,
            envelope.returnMessage,
          ),
        ),
      );
      if (envelope.returnCode === "MB433") {
        throw new SkbankProtocolError(
          "新光銀行要求更新 App 版本，連接器需要更新後才能同步。",
        );
      }
      throw new SkbankVerificationRequiredError(
        "新光銀行登入失敗，請確認身分證字號、使用者代號與網銀密碼。",
      );
    }
    const accessToken = stringValue(envelope.data.AccessToken).trim();
    if (!accessToken) {
      throw new SkbankProtocolError(
        "新光銀行登入成功回應缺少 AccessToken，暫時無法同步。",
      );
    }
    this.accessToken = accessToken;
    this.loggedIn = true;
  }

  async get(
    path: string,
    queryOrRequireLogin: Record<string, string> | boolean = true,
  ) {
    const requireLogin =
      typeof queryOrRequireLogin === "boolean" ? queryOrRequireLogin : true;
    const query =
      typeof queryOrRequireLogin === "boolean"
        ? undefined
        : queryOrRequireLogin;
    if (requireLogin && !this.accessToken) {
      throw new SkbankVerificationRequiredError(
        "新光銀行登入狀態已失效，請重新同步。",
      );
    }
    const envelope = await this.request(
      path,
      {
        method: "GET",
        headers: this.headers(),
      },
      query,
    );
    if (envelope.returnCode !== "0000") {
      if (isEmptyTransactionResponse(path, envelope.returnMessage)) {
        return {
          Details: [],
          Paging: {
            Page: query?.Page ?? "1",
            PageSize: query?.PageSize ?? String(TRANSACTION_PAGE_SIZE),
            TotalCount: 0,
          },
          Summary: { Deposit: "0", Withdrawal: "0" },
        };
      }
      console.warn(
        JSON.stringify(
          buildSkbankApiDiagnostic(
            path,
            envelope.returnCode,
            envelope.returnMessage,
          ),
        ),
      );
      throw new SkbankConnectionError();
    }
    return envelope.data;
  }

  async fetchTransactionPages(
    accountNumber: string,
    currency: string,
    range: { beginDate: string; endDate: string },
  ) {
    const isTwd = currency === "TWD";
    const path = isTwd
      ? TRANSACTION_DETAILS_PATH
      : FOREIGN_TRANSACTION_DETAILS_PATH;
    const pages: unknown[] = [];
    let page = 1;
    let previousResponsePage = 0;
    let collected = 0;

    for (let iteration = 0; iteration < MAX_TRANSACTION_PAGES; iteration += 1) {
      const query: Record<string, string> = {
        AccountNumber: accountNumber,
        BeginDate: range.beginDate,
        EndDate: range.endDate,
        IsOrderByAsc: "true",
        Page: String(page),
        PageSize: String(TRANSACTION_PAGE_SIZE),
      };
      if (!isTwd) query.CurrencyCode = currency;

      const data = await this.get(path, query);
      pages.push(data);
      if (
        !isRecord(data) ||
        !Array.isArray(data.Details) ||
        !isRecord(data.Paging)
      ) {
        throw new SkbankProtocolError();
      }
      const details = data.Details;
      collected += details.length;
      const paging = data.Paging;
      const totalCount = numberValue(paging.TotalCount);
      const responsePage = numberValue(paging.Page);
      const responsePageSize = numberValue(paging.PageSize);
      if (
        totalCount == null ||
        !Number.isInteger(totalCount) ||
        totalCount < 0 ||
        responsePage == null ||
        !Number.isInteger(responsePage) ||
        responsePageSize == null ||
        !Number.isInteger(responsePageSize) ||
        responsePageSize <= 0
      ) {
        throw new SkbankProtocolError();
      }

      if (totalCount <= collected) return pages;
      if (details.length === 0) throw new SkbankProtocolError();
      if (responsePage <= previousResponsePage || responsePage < page) {
        throw new SkbankProtocolError();
      }
      previousResponsePage = responsePage;
      const nextPage = responsePage + 1;
      if (nextPage <= page) throw new SkbankProtocolError();
      page = nextPage;
    }
    throw new SkbankProtocolError(
      "新光銀行交易明細分頁超過安全上限，暫時無法完整同步。",
    );
  }

  async logout() {
    if (!this.loggedIn) return;
    try {
      await this.request(LOGOUT_PATH, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      // Best-effort logout must not replace a completed read-only sync.
    } finally {
      this.accessToken = "";
      this.loggedIn = false;
    }
  }

  private headers() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "App-Version": SKBANK_APP_VERSION,
      "Device-Info": "Android;15;Google-Pixel 8",
      "Device-Id": this.deviceId,
      Authorization: `bearer ${this.accessToken}`,
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    query?: Record<string, string>,
  ) {
    const url = new URL(path, SKBANK_ORIGIN);
    if (url.origin !== SKBANK_ORIGIN || url.pathname !== path) {
      throw new SkbankConnectionError();
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new SkbankConnectionError();
      }
      const payload = await readLimitedJson(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new SkbankVerificationRequiredError(
            "新光銀行登入狀態已失效，請重新同步。",
          );
        }
        throw new SkbankConnectionError();
      }
      if (!isRecord(payload)) throw new SkbankProtocolError();
      return {
        returnCode: stringValue(payload.ReturnCode),
        returnMessage: stringValue(payload.ReturnMessage),
        data: isRecord(payload.Data) ? payload.Data : {},
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readLimitedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new SkbankConnectionError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SkbankConnectionError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new SkbankProtocolError();
  } finally {
    bytes.fill(0);
  }
}

function encryptRsaHex(value: string, modulus: string, exponent: string) {
  const publicKey = forge.pki.setRsaPublicKey(
    new forge.jsbn.BigInteger(modulus, 16),
    new forge.jsbn.BigInteger(exponent, 16),
  );
  return forge.util.bytesToHex(
    publicKey.encrypt(forge.util.encodeUtf8(value), "RSAES-PKCS1-V1_5"),
  );
}

function sha256Hex(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function validCredential(
  value: unknown,
  maxLength: number,
  jsonPlaintext = false,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  return !jsonPlaintext || !/["\\]/u.test(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function deviceIdFromCursor(cursor?: string) {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(cursor) as unknown;
    if (!isRecord(value)) return undefined;
    const deviceId = stringValue(value.deviceId).trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deviceId,
    )
      ? deviceId
      : undefined;
  } catch {
    return undefined;
  }
}

function safeReturnCode(value: unknown) {
  const code = stringValue(value).trim();
  return /^[A-Za-z0-9_-]{1,20}$/.test(code) ? code : "UNKNOWN";
}

function safeProviderMessage(value: unknown) {
  return stringValue(value)
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(
      /\b(authorization|cookie|password|passwd|token|secret|session(?:cookies?)?)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Z][12]\d{8}\b/gi, "[redacted]")
    .replace(/\d(?:[\s-]*\d){4,}/g, (matched) => {
      const digits = matched.replace(/\D/g, "");
      return `••••${digits.slice(-4)}`;
    })
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9+/_=-]{24,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function isEmptyTransactionResponse(path: string, returnMessage: string) {
  return (
    (path === TRANSACTION_DETAILS_PATH ||
      path === FOREIGN_TRANSACTION_DETAILS_PATH) &&
    returnMessage.trim() === "查無資料"
  );
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[,$\s]/g, "").trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function transactionDateRange(now: Date) {
  const end = new Date(now);
  const start = new Date(now);
  start.setMonth(start.getMonth() - BANK_SYNC_MONTHS);
  return {
    beginDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function formatDate(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("/");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
