import type { SyncResult } from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { parseObankData, type ObankConfig, type ObankPayloads } from "./obank";
import { BANK_SYNC_MONTHS } from "./sync-window";

const OBANK_ORIGIN = "https://www.o-bank.com";
const OBANK_API_ROOT = `${OBANK_ORIGIN}/ebank/ixtein`;
const OBANK_ADAPTER_ROOT = `${OBANK_API_ROOT}/v2/adapters/ebank`;
const OBANK_AUTH_ROOT = `${OBANK_ADAPTER_ROOT}/AuthenticationAdapter`;
const OBANK_TOKEN_URL = `${OBANK_API_ROOT}/oauth/token`;
const OBANK_CHANNEL_URL = `${OBANK_ADAPTER_ROOT}/ChannelAdapter/getChannel`;
const OBANK_WEB_REFERER = `${OBANK_ORIGIN}/ebank/apps/services/www/ibmb/desktopbrowser/default/index.html`;
const REQUEST_TIMEOUT_MS = 45_000;
const PENDING_SESSION_TTL_MS = 2 * 60_000;
const MAX_DEMAND_ACCOUNTS = 50;

const BOOTSTRAP_RESOURCE = "common/CMN01003/010";
const CAPTCHA_RESOURCE = "common/CMN01001/010";
const LOGIN_PAGE_RESOURCE = "fco/FCO02001/012";
const LOGIN_PAGE_AUDIT_RESOURCE = "common/CMN01004/010";
const E2E_TIME_RESOURCE = "common/EndToEnd/020";
const DEMAND_DEPOSIT_RESOURCE = "fao/FAO01012/010";
const TIME_DEPOSIT_RESOURCE = "fao/FAO01022/020";

type JsonRecord = Record<string, unknown>;
type ObankCredentials = Required<
  Pick<ObankConfig, "userId" | "account" | "password">
>;
type ObankFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ObankSessionState = {
  version: 1;
  accessToken: string;
  cookies: Record<string, string>;
  transactionToken: string;
  clientNo: string;
  transactionId: string;
  rsaPem: string;
};

export type ObankCaptchaChallenge = {
  captchaImage: string;
  contentType: string;
  imageBytes: ArrayBuffer;
  pendingSession: string;
  pendingSessionExpiresAt: string;
};

export type ObankSyncOptions = {
  forceLogin?: boolean;
};

export class ObankVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObankVerificationRequiredError";
  }
}

export class ObankCaptchaRejectedError extends ObankVerificationRequiredError {
  constructor(message = "王道銀行圖形驗證碼錯誤，請重新取得驗證碼。") {
    super(message);
    this.name = "ObankCaptchaRejectedError";
  }
}

export class ObankCredentialRejectedError extends ObankVerificationRequiredError {
  constructor(message = "王道銀行登入資料驗證失敗，請確認設定後重試。") {
    super(message);
    this.name = "ObankCredentialRejectedError";
  }
}

export class ObankMultipleLoginError extends ObankVerificationRequiredError {
  constructor(
    message = "王道銀行偵測到其他登入中的裝置；為避免中斷使用中的工作階段，請先在官方 App 登出後再同步。",
  ) {
    super(message);
    this.name = "ObankMultipleLoginError";
  }
}

export class ObankConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObankConnectionError";
  }
}

export class ObankProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObankProtocolError";
  }
}

export function requireObankCredentials(
  config: Pick<ObankConfig, "userId" | "account" | "password">,
): ObankCredentials {
  if (
    !isNonEmptyString(config.userId) ||
    !isNonEmptyString(config.account) ||
    !isNonEmptyString(config.password)
  ) {
    throw new ObankVerificationRequiredError(
      "請先儲存王道銀行身分證字號、使用者代號與網銀密碼。",
    );
  }
  return {
    userId: config.userId,
    account: config.account,
    password: config.password,
  };
}

export function classifyObankError(error: unknown) {
  if (
    error instanceof ObankVerificationRequiredError ||
    error instanceof ObankConnectionError ||
    error instanceof ObankProtocolError
  ) {
    return error;
  }
  return new ObankConnectionError("王道銀行資料同步暫時無法完成。");
}

export async function prepareObankCaptcha(
  config: ObankConfig,
  fetcher: ObankFetch = globalThis.fetch.bind(globalThis),
): Promise<ObankCaptchaChallenge> {
  requireObankCredentials(config);
  const session = new ObankMobileFirstSession(fetcher);
  await session.bootstrap();
  const captchaImage = await session.fetchCaptcha();
  const decoded = decodeDataUrl(captchaImage);
  return {
    captchaImage,
    contentType: decoded.contentType,
    imageBytes: decoded.bytes,
    pendingSession: session.serialize(),
    pendingSessionExpiresAt: new Date(
      Date.now() + PENDING_SESSION_TTL_MS,
    ).toISOString(),
  };
}

export function createObankConnector(
  fetcher: ObankFetch = globalThis.fetch.bind(globalThis),
  recognizeCaptcha?: (
    imageBytes: ArrayBuffer,
    contentType: string,
  ) => Promise<string>,
) {
  return {
    id: "obank" as const,
    name: "王道銀行",

    async sync(
      config: ObankConfig,
      _cursor?: string,
      options: ObankSyncOptions = {},
    ): Promise<SyncResult<never>> {
      const credentials = requireObankCredentials(config);
      let session: ObankMobileFirstSession;
      let captcha = config.captcha;

      try {
        if (hasPendingChallenge(config)) {
          session = ObankMobileFirstSession.deserialize(
            config.pendingSession!,
            fetcher,
          );
        } else {
          const prepared = await prepareObankCaptcha(config, fetcher);
          if (!recognizeCaptcha) {
            throw new ObankVerificationRequiredError(
              "王道銀行同步需要先完成圖形驗證。",
            );
          }
          captcha = await recognizeCaptcha(
            prepared.imageBytes,
            prepared.contentType,
          );
          session = ObankMobileFirstSession.deserialize(
            prepared.pendingSession,
            fetcher,
          );
        }

        if (!captcha || !/^[A-Za-z0-9]{4}$/.test(captcha)) {
          throw new ObankVerificationRequiredError(
            "請輸入王道銀行圖片中的四位英數驗證碼。",
          );
        }

        await session.login(credentials, captcha, options);
        const demandDeposits = await session.secureResource(
          DEMAND_DEPOSIT_RESOURCE,
          {
            masterAccountNo: "",
            queryType: "before7Days",
            initQuery: "Y",
          },
          "FAO01012",
        );
        const timeDeposits = await session.secureResource(
          TIME_DEPOSIT_RESOURCE,
          { page: "td", linkFromTxnId: "FAO01012_010" },
          "FAO01022",
        );
        const transactionResponses = await fetchDemandDepositTransactions(
          session,
          demandDeposits,
        );
        const payloads: ObankPayloads = {
          demandDeposits,
          timeDeposits,
          transactionResponses,
        };
        const parsed = parseObankData(payloads, new Date());
        if (
          parsed.bankAccounts.length === 0 ||
          parsed.bankBalanceSnapshots.length === 0
        ) {
          throw new ObankProtocolError(
            "王道銀行回應中沒有可辨識的存款帳戶或餘額。",
          );
        }
        await session.logout();
        return {
          records: [],
          ...parsed,
          cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
        };
      } catch (error) {
        throw classifyObankError(error);
      }
    },
  };
}

class ObankMobileFirstSession {
  private accessToken = "";
  private readonly cookies = new Map<string, string>();
  private transactionToken = "#";
  private readonly clientNo: string;
  private transactionId = "";
  private rsaPem = "";

  constructor(
    private readonly fetcher: ObankFetch,
    clientNo = Date.now().toString(),
  ) {
    this.clientNo = clientNo;
  }

  static deserialize(serialized: string, fetcher: ObankFetch) {
    let state: ObankSessionState;
    try {
      state = JSON.parse(serialized) as ObankSessionState;
    } catch {
      throw new ObankVerificationRequiredError(
        "王道銀行驗證工作階段格式無效，請重新取得圖形驗證碼。",
      );
    }
    if (
      state.version !== 1 ||
      !isNonEmptyString(state.accessToken) ||
      !isRecord(state.cookies) ||
      !isNonEmptyString(state.clientNo) ||
      !isNonEmptyString(state.rsaPem)
    ) {
      throw new ObankVerificationRequiredError(
        "王道銀行驗證工作階段已失效，請重新取得圖形驗證碼。",
      );
    }
    const session = new ObankMobileFirstSession(fetcher, state.clientNo);
    session.accessToken = state.accessToken;
    session.transactionToken = state.transactionToken || "#";
    session.transactionId = state.transactionId || "";
    session.rsaPem = state.rsaPem;
    for (const [name, value] of Object.entries(state.cookies)) {
      if (name && typeof value === "string") session.cookies.set(name, value);
    }
    return session;
  }

  serialize() {
    const state: ObankSessionState = {
      version: 1,
      accessToken: this.accessToken,
      cookies: Object.fromEntries(this.cookies),
      transactionToken: this.transactionToken,
      clientNo: this.clientNo,
      transactionId: this.transactionId,
      rsaPem: this.rsaPem,
    };
    return JSON.stringify(state);
  }

  async bootstrap() {
    await this.requestJson(OBANK_CHANNEL_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: OBANK_WEB_REFERER,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "PUBLIC",
      client_id: "browser",
      client_secret: "browser",
    }).toString();
    const response = await this.requestJson(OBANK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    this.accessToken = stringValue(response.access_token);
    if (!this.accessToken) {
      throw new ObankConnectionError("王道銀行 MobileFirst 初始化失敗。");
    }

    const bootstrap = await this.noSecResource(BOOTSTRAP_RESOURCE, {});
    const params = recordAt(recordAt(bootstrap, "rsData"), "params");
    this.rsaPem = stringValue(params.e2e);
    if (!this.rsaPem) {
      throw new ObankProtocolError("王道銀行登入公鑰回應格式已變更。");
    }
    const challenge = await this.postAdapter("emptyLogin", [
      this.metadata({}, ""),
    ]);
    if (stringValue(challenge.authStatus) !== "required") {
      throw new ObankProtocolError("王道銀行登入 challenge 回應格式已變更。");
    }
    this.transactionToken = "#";
    this.transactionId = crypto.randomUUID();
    await this.noSecResource(LOGIN_PAGE_RESOURCE, {}, "FCO02001");
    await this.noSecResource(
      LOGIN_PAGE_AUDIT_RESOURCE,
      { type: "0", page: "FCO02001_010" },
      "FCO02001",
    );
  }

  async fetchCaptcha() {
    const response = await this.noSecResource(CAPTCHA_RESOURCE, {}, "FCO02001");
    const image = stringValue(recordAt(response, "rsData").img);
    if (!/^data:image\/[A-Za-z0-9.+-]+;base64,/.test(image)) {
      throw new ObankProtocolError("王道銀行圖形驗證碼回應格式已變更。");
    }
    return image;
  }

  async login(
    credentials: ObankCredentials,
    captcha: string,
    options: ObankSyncOptions = {},
  ) {
    const encryptedAccount = await this.encryptLoginValue(credentials.account);
    const encryptedPassword = await this.encryptLoginValue(
      credentials.password,
    );
    const loginData = {
      no: credentials.userId,
      uno: encryptedAccount,
      sec: encryptedPassword,
      captcha,
      type: "0",
      force: "0",
      link: "link",
    };
    let response = await this.submitLoginData(loginData);
    if (isMultipleLoginResponse(response) && options.forceLogin) {
      response = await this.submitLoginData({ ...loginData, force: "1" });
    }
    classifyLoginResponse(response);
  }

  private submitLoginData(loginData: JsonRecord) {
    return this.postAdapter("submitCredentials", [
      this.metadata(loginData, "FCO02001"),
    ]);
  }

  async secureResource(
    resource: string,
    data: JsonRecord,
    currentTxn?: string,
  ) {
    const response = await this.postAdapter("sendAndReceive", [
      resource,
      this.metadata(data, currentTxn),
    ]);
    assertSuccessfulResponse(response, resource);
    return response;
  }

  async logout() {
    try {
      await this.requestJson(
        `${OBANK_ADAPTER_ROOT}/BankingServicesAdapter/invalidateSession`,
        {
          method: "GET",
          headers: this.baseHeaders(),
        },
      );
    } catch {
      // Logout is best-effort after all read-only queries are complete.
    }
  }

  private async encryptLoginValue(value: string) {
    const response = await this.noSecResource(E2E_TIME_RESOURCE, {});
    const timeFactor = stringValue(recordAt(response, "rsData").timeFactor);
    if (!timeFactor) {
      throw new ObankProtocolError("王道銀行登入加密時間因子回應格式已變更。");
    }
    try {
      const publicKey = forge.pki.publicKeyFromPem(this.rsaPem);
      return forge.util.encode64(
        publicKey.encrypt(`${value}${timeFactor}`, "RSAES-PKCS1-V1_5"),
      );
    } catch {
      throw new ObankConnectionError("王道銀行登入資料加密失敗。");
    }
  }

  private noSecResource(
    resource: string,
    data: JsonRecord,
    currentTxn?: string,
  ) {
    return this.postAdapter("sendAndReceiveNoSec", [
      resource,
      this.metadata(data, currentTxn),
    ]).then((response) => {
      assertSuccessfulResponse(response, resource);
      return response;
    });
  }

  private metadata(rqData: JsonRecord, currentTxn?: string): JsonRecord {
    const metadata: JsonRecord = {
      trackingPk: `${crypto.randomUUID().replace(/-/g, "")}${Date.now()
        .toString()
        .slice(-4)}`,
      txnPk: this.transactionId,
      pk: "none",
      model: "Chrome",
      platform: "MacIntel",
      version: "151",
      network: "0",
      appVersion: "1.0",
      clientTime: Date.now().toString(),
      locale: "zh_TW",
      fromSysPk: "IB",
      token: this.transactionToken || "#",
      clientNo: this.clientNo,
      xDId: "",
      rqData,
    };
    if (currentTxn) metadata.currentTxn = currentTxn;
    return metadata;
  }

  private async postAdapter(procedure: string, payload: unknown[]) {
    const body = JSON.stringify(payload);
    const response = await this.requestJson(`${OBANK_AUTH_ROOT}/${procedure}`, {
      method: "POST",
      headers: {
        ...this.baseHeaders(),
        checksum: md5(body),
        "x-transaction-id": this.transactionId,
      },
      body,
    });
    const nextToken = stringValue(response.token);
    if (nextToken) this.transactionToken = nextToken;
    return response;
  }

  private baseHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      Origin: OBANK_ORIGIN,
      Referer: OBANK_WEB_REFERER,
      "X-Requested-With": "XMLHttpRequest",
    };
  }

  private async requestJson(url: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader();
    if (cookie) headers.set("Cookie", cookie);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ObankConnectionError("王道銀行服務連線逾時。");
      }
      throw new ObankConnectionError("王道銀行服務暫時無法連線。");
    } finally {
      clearTimeout(timeout);
    }
    this.captureCookies(response.headers);
    if (!response.ok) {
      throw new ObankConnectionError(
        `王道銀行服務回應 HTTP ${response.status}。`,
      );
    }
    try {
      const value = (await response.json()) as unknown;
      if (!isRecord(value)) throw new Error("not an object");
      return value;
    } catch {
      throw new ObankProtocolError("王道銀行服務回應不是有效的 JSON。");
    }
  }

  private captureCookies(headers: Headers) {
    const values = getSetCookieValues(headers);
    for (const value of values) {
      const firstPart = value.split(";", 1)[0]?.trim();
      const separator = firstPart?.indexOf("=") ?? -1;
      if (!firstPart || separator <= 0) continue;
      const name = firstPart.slice(0, separator).trim();
      const cookieValue = firstPart.slice(separator + 1).trim();
      if (!name) continue;
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }

  private cookieHeader() {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join(
      "; ",
    );
  }
}

async function fetchDemandDepositTransactions(
  session: ObankMobileFirstSession,
  demandDepositResponse: JsonRecord,
) {
  const queries = demandAccountQueries(demandDepositResponse).slice(
    0,
    MAX_DEMAND_ACCOUNTS,
  );
  if (queries.length === 0) return [demandDepositResponse];
  const today = new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - BANK_SYNC_MONTHS);
  return Promise.all(
    queries.map(({ subAccountItemNo, currency }) =>
      session.secureResource(
        DEMAND_DEPOSIT_RESOURCE,
        {
          queryType: "customDisplay",
          startDate: formatDate(start),
          endDate: formatDate(today),
          subAccountItemNo,
          curry: currency,
          initQuery: "N",
        },
        "FAO01012",
      ),
    ),
  );
}

function demandAccountQueries(payload: JsonRecord) {
  const rsData = recordAt(payload, "rsData");
  const userAccounts = arrayValue(rsData.userAccounts);
  const seen = new Set<string>();
  return userAccounts.flatMap((groupValue) => {
    if (!isRecord(groupValue)) return [];
    return arrayValue(groupValue.accountItems).flatMap((itemValue) => {
      if (!isRecord(itemValue)) return [];
      const subAccountItemNo = stringValue(itemValue.accountItemNo);
      const currency = stringValue(itemValue.curr).toUpperCase();
      const key = `${subAccountItemNo}:${currency}`;
      if (!subAccountItemNo || !/^[A-Z]{3}$/.test(currency) || seen.has(key))
        return [];
      seen.add(key);
      return [{ subAccountItemNo, currency }];
    });
  });
}

function classifyLoginResponse(response: JsonRecord) {
  const authStatus = stringValue(response.authStatus);
  if (authStatus && authStatus !== "required") return;
  const rsData = recordAt(response, "rsData");
  const resultType = stringValue(rsData.resultType);
  const statusDesc = stringValue(response.statusDesc);
  const validateError = recordAt(response, "validateError");
  const validationText = JSON.stringify(validateError);
  if (isMultipleLoginResponse(response)) throw new ObankMultipleLoginError();
  if (resultType === "2" || resultType === "10") {
    throw new ObankCredentialRejectedError();
  }
  if (/captcha|驗證碼|magicNumber/i.test(`${statusDesc} ${validationText}`)) {
    throw new ObankCaptchaRejectedError();
  }
  if (resultType === "1" || stringValue(rsData.lockDownFlag) === "Y") {
    throw new ObankCredentialRejectedError(
      "王道銀行網路銀行目前無法登入或已鎖定，請先使用官方管道處理。",
    );
  }
  if (authStatus === "required") {
    throw new ObankVerificationRequiredError(
      statusDesc || "王道銀行登入需要額外驗證。",
    );
  }
  assertSuccessfulResponse(response, "login");
}

function isMultipleLoginResponse(response: JsonRecord) {
  return stringValue(recordAt(response, "rsData").resultType) === "3";
}

function assertSuccessfulResponse(response: JsonRecord, resource: string) {
  const successful = response.isSuccessful;
  const statusCode = stringValue(response.statusCode);
  if (successful === false || (statusCode && statusCode !== "0000")) {
    const description = stringValue(response.statusDesc);
    if (/captcha|驗證碼/i.test(description)) {
      throw new ObankCaptchaRejectedError();
    }
    throw new ObankProtocolError(
      `王道銀行 ${resource} 回應失敗${description ? `：${description}` : ""}。`,
    );
  }
}

function hasPendingChallenge(config: ObankConfig) {
  return Boolean(
    config.pendingSession &&
    config.pendingSessionExpiresAt &&
    new Date(config.pendingSessionExpiresAt).getTime() > Date.now() &&
    config.captcha,
  );
}

function decodeDataUrl(value: string) {
  const match = value.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new ObankProtocolError("王道銀行驗證碼圖片格式無效。");
  try {
    const bytes = forge.util.decode64(match[2]);
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) {
      array[index] = bytes.charCodeAt(index);
    }
    return { contentType: match[1], bytes: array.buffer };
  } catch {
    throw new ObankProtocolError("王道銀行驗證碼圖片無法解碼。");
  }
}

function md5(value: string) {
  return forge.md.md5.create().update(value, "utf8").digest().toHex();
}

function getSetCookieValues(headers: Headers) {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const direct = withGetSetCookie.getSetCookie?.();
  if (direct?.length) return direct;
  const combined = headers.get("set-cookie");
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function formatDate(value: Date) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("/");
}

function recordAt(record: JsonRecord, key: string): JsonRecord {
  return isRecord(record[key]) ? record[key] : {};
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { ObankFetch };
