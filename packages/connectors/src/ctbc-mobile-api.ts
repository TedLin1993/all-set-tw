import type { SyncResult } from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { parseCtbcData, type CtbcConfig, type CtbcPayloads } from "./ctbc";

const CTBC_IMP_ORIGIN = "https://eb.ctbcbank.com/IMP";
const CTBC_APPLICATION = "EBMW_Adapter";
const CTBC_RESOURCE_ENDPOINT = `${CTBC_IMP_ORIGIN}/api/adapters/${CTBC_APPLICATION}/resource/ebmwResource`;
const CTBC_APP_VERSION = "5.2.25";
const CTBC_WEB_VERSION = "20260722182433427";
// MobileFirst client-credential value shipped in the public Android package.
const CTBC_PUBLIC_CLIENT_TOKEN = "2ae74c0ad7a14739a2aab7340616d70e";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_PAGES = 20;

const CTBC_PIN_RSA_EXPONENT = "9719";
const CTBC_PIN_RSA_MODULUS =
  "DF63FFC2F35068BA9A964D234C3400E6394148BC69DF0DD8257340747AD73BF8514C76254F5BEA223BFF76B63840034518E0FA0A1E1905129EC69203A0873A63E5238FFE538DBEFBB64F9318C0BEEF75595DE991E004213B7FE9DA62229BDA1722B45ABAF906F26CF6D88B5BE8F18C26FCA630C6813B0D370E64E1C8D80A790F936C064A5620BFA2C6EE4B5BB962F7703A258028D53923866E43C98C36758262D6DE9D02DECFD74B211E3233924D499B864E1CA86DF012EAFFC9933A0CD2E011843B772E53C6435F78A60437E82D1677664221D01F59797D28771B2AE207EAB00E8500AA2A4FB61FF330B59FC5B699A241D9A44139CF876A74F0DE180107D7DF";

const LOGIN_RESOURCE = "/twrbm-general/ot001/010";
const LOGOUT_RESOURCE = "/twrbm-general/ot002/010";
const DEPOSIT_OVERVIEW_RESOURCE = "/twrbm-deposit/qu001/010";
const DEPOSIT_TRANSACTIONS_INIT_RESOURCE = "/twrbm-deposit/qu002/010";
const DEPOSIT_TRANSACTIONS_RESOURCE = "/twrbm-deposit/qu002/011";
const CREDIT_CARD_BILLS_RESOURCE = "/twrbm-card/qu002/010";
const UNBILLED_INIT_RESOURCE = "/twrbm-card/qu006/010";
const UNBILLED_RESOURCE = "/twrbm-card/qu006/011";
const UNBILLED_PAGE_RESOURCE = "/twrbm-card/qu006/015";
const REALTIME_RESOURCE = "/twrbm-card/qu041/010";
const REALTIME_PAGE_RESOURCE = "/twrbm-card/qu041/015";
const CREDIT_CARD_SUMMARY_RESOURCE = "/twrbm-card/qu046/010";

type JsonRecord = Record<string, unknown>;
type CtbcCredentials = Required<
  Pick<CtbcConfig, "userId" | "account" | "password">
>;
export type CtbcFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class CtbcVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbcVerificationRequiredError";
  }
}

export class CtbcConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CtbcConnectionError";
  }
}

export function requireCtbcCredentials(
  config: Pick<CtbcConfig, "userId" | "account" | "password">,
): CtbcCredentials {
  if (
    !isNonEmptyString(config.userId) ||
    !isNonEmptyString(config.account) ||
    !isNonEmptyString(config.password)
  ) {
    throw new CtbcVerificationRequiredError(
      "請先儲存中國信託身分證字號、使用者代號與網銀密碼。",
    );
  }
  return {
    userId: config.userId,
    account: config.account,
    password: config.password,
  };
}

/**
 * Reproduces the App 5.2.25 `makeEncryptPINClear` format. Plaintext exists only
 * for the duration of this call and is never returned or included in errors.
 */
export function encryptCtbcPin(
  value: string,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
) {
  if (!value) {
    throw new CtbcVerificationRequiredError("中國信託登入欄位不可為空白。");
  }

  const xorKey = randomDigits(value.length, randomBytes);
  let xorText = "";
  for (let index = 0; index < value.length; index += 1) {
    xorText += String.fromCharCode(
      value.charCodeAt(index) ^ xorKey.charCodeAt(index),
    );
  }
  const clearText = `${String(value.length).padStart(2, "0")}${xorKey}${xorText}`;
  const password = randomDigits(10, randomBytes);
  const salt = bytesToBinary(randomBytes(16));
  const aesKey = forge.pkcs5.pbkdf2(
    password,
    salt,
    1,
    32,
    forge.md.sha1.create(),
  );
  const cipher = forge.cipher.createCipher("AES-CBC", aesKey);
  cipher.start({ iv: "\0".repeat(16) });
  cipher.update(forge.util.createBuffer(clearText, "utf8"));
  if (!cipher.finish()) {
    throw new CtbcConnectionError("中國信託登入資料加密失敗。");
  }

  const publicKey = forge.pki.setRsaPublicKey(
    new forge.jsbn.BigInteger(CTBC_PIN_RSA_MODULUS, 16),
    new forge.jsbn.BigInteger(CTBC_PIN_RSA_EXPONENT, 16),
  );
  const encryptedKey = publicKey.encrypt(aesKey, "RSAES-PKCS1-V1_5");
  return `${cipher.output.toHex()}|${forge.util.bytesToHex(encryptedKey).padStart(512, "0")}`;
}

export function classifyCtbcError(
  error: unknown,
): CtbcVerificationRequiredError | CtbcConnectionError {
  if (
    error instanceof CtbcVerificationRequiredError ||
    error instanceof CtbcConnectionError
  ) {
    return error;
  }
  return new CtbcConnectionError("中國信託資料同步暫時無法完成。");
}

export function createCtbcConnector(
  fetcher: CtbcFetch = globalThis.fetch.bind(globalThis),
) {
  return {
    id: "ctbc" as const,
    name: "中國信託商業銀行",

    async sync(
      config: CtbcConfig,
      _cursor?: string,
    ): Promise<SyncResult<never>> {
      const credentials = requireCtbcCredentials(config);
      const lookbackMonths = config.lookbackMonths ?? 3;
      const session = new CtbcMobileSession(fetcher);
      let loggedIn = false;
      try {
        await session.bootstrap();
        await session.login(credentials);
        loggedIn = true;

        const depositOverview = await session.resource(
          DEPOSIT_OVERVIEW_RESOURCE,
          {},
        );
        const depositTransactions = await fetchDepositTransactions(
          session,
          depositOverview,
          lookbackMonths,
        );
        const creditCards = await session.resource(
          CREDIT_CARD_BILLS_RESOURCE,
          {},
        );
        // The summary call refreshes the same session data used by the official
        // App (available credit and billed/unbilled totals). Its raw response is
        // intentionally not persisted until those fields have a stable mapping.
        await session.resource(CREDIT_CARD_SUMMARY_RESOURCE, {});
        const unbilled = await fetchUnbilledTransactions(session);
        const realtime = await fetchPagedCardItems(
          session,
          REALTIME_RESOURCE,
          REALTIME_PAGE_RESOURCE,
          {},
        );
        const payloads: CtbcPayloads = {
          depositOverview,
          depositTransactions,
          creditCards,
          unbilled,
          realtime,
        };
        const parsed = parseCtbcData(payloads, lookbackMonths, new Date());
        return {
          records: [],
          ...parsed,
          cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
        };
      } catch (error) {
        throw classifyCtbcError(error);
      } finally {
        if (loggedIn) await session.logout();
      }
    },
  };
}

class CtbcMobileSession {
  private readonly deviceCode = crypto.randomUUID();
  private readonly deviceIxd = this.deviceCode.replace(/-/g, "");
  private readonly clientNo = Date.now().toString();
  private accessToken = "";
  private xAuthToken = "";
  private transactionToken = "mfpInit";
  private seed = "";
  private loggedIn = false;

  constructor(private readonly fetcher: CtbcFetch) {}

  async bootstrap() {
    const tokenUrl = new URL(`${CTBC_IMP_ORIGIN}/oauth/token`);
    tokenUrl.searchParams.set("grant_type", "client_credentials");
    tokenUrl.searchParams.set("scope", "PUBLIC");
    tokenUrl.searchParams.set("client_id", CTBC_APPLICATION);
    tokenUrl.searchParams.set("client_secret", CTBC_PUBLIC_CLIENT_TOKEN);
    const tokenResponse = await this.post(tokenUrl, "", {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    this.accessToken = stringValue(tokenResponse.access_token);
    if (!this.accessToken) {
      throw new CtbcConnectionError("中國信託行動銀行服務初始化失敗。");
    }

    const initResponse = await this.post(
      `${CTBC_IMP_ORIGIN}/main/init`,
      JSON.stringify({
        application: CTBC_APPLICATION,
        deviceCode: this.deviceCode,
        deviceManufacturer: "Google",
        deviceModel: "Pixel 8",
        devicePlatform: "Android",
        deviceVersion: "15",
        pclientTime: Date.now(),
        randomNumber: "",
        clientPubk: "",
      }),
      this.baseHeaders(),
    );
    if (stringValue(initResponse.statusCode) !== "0000") {
      throw new CtbcConnectionError("中國信託行動銀行服務初始化失敗。");
    }

    const handshakeBody = this.envelope({});
    const handshake = await this.postResource(handshakeBody, {
      "X-Request-Type": "handshakewb",
    });
    if (handshake.success !== true) {
      throw new CtbcConnectionError("中國信託行動銀行安全連線失敗。");
    }
    this.updateSession(handshake);
  }

  async login(credentials: CtbcCredentials) {
    const loginRequest: JsonRecord = {
      loginType: "PW",
      custId: credentials.userId,
      uniNo: "",
      bankIdNo: "",
      cardIdNo: "",
      isMvpApp: false,
      isCoverApp: false,
      custSeqFIDO: "",
      deviceBindBlackList: "Y",
      userId: encryptCtbcPin(credentials.account),
      pin: encryptCtbcPin(credentials.password),
    };
    let response = await this.resource(LOGIN_RESOURCE, loginRequest);

    // The official App presents these as confirmation dialogs, then resends
    // the identical encrypted login body with the server timestamp. Scheduled
    // sync opts into the same confirmation so an abandoned prior session or a
    // fresh ephemeral Worker device does not permanently block automation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const data = responseData(response);
      const deviceTimestamp = stringValue(
        data.deviceBindBlackListCheckTimestamp,
      ).trim();
      const duplicateTimestamp = stringValue(
        data.dupLoginCheckTimestamp,
      ).trim();
      if (deviceTimestamp) {
        loginRequest.deviceBindBlackListCheckTimestamp = deviceTimestamp;
      } else if (duplicateTimestamp) {
        loginRequest.dupLoginCheckTimestamp = duplicateTimestamp;
      } else {
        break;
      }
      response = await this.resource(LOGIN_RESOURCE, loginRequest);
    }

    const data = responseData(response);
    if (
      data.needBindDevice === true ||
      hasText(data.dupLoginCheckTimestamp) ||
      hasText(data.deviceBindBlackListCheckTimestamp) ||
      containsVerificationFlag(data)
    ) {
      console.warn(
        JSON.stringify({
          event: "ctbc_login_verification_required",
          flags: verificationFlagNames(data),
        }),
      );
      throw new CtbcVerificationRequiredError(
        "中國信託要求裝置、重複登入或一次性密碼確認，請先至官方 App 完成驗證。",
      );
    }
    this.loggedIn = true;
  }

  async logout() {
    if (!this.loggedIn) return;
    try {
      await this.resource(LOGOUT_RESOURCE, {});
    } catch {
      // A failed best-effort logout must not replace an otherwise valid sync.
    } finally {
      this.loggedIn = false;
    }
  }

  async resource(resource: string, rqData: JsonRecord) {
    const body = this.envelope(rqData, resource);
    const headers: Record<string, string> = {};
    if (this.transactionToken === "mfpInit") {
      headers["X-Requested-With"] = "MFPInit";
    }
    if (!this.loggedIn) headers["X-Request-Type"] = "preLogin";
    if (this.xAuthToken) headers["x-auth-token"] = this.xAuthToken;
    const response = await this.postResource(body, headers);
    this.updateSession(response);
    this.assertResourceSuccess(response, resource);
    return response;
  }

  private envelope(rqData: JsonRecord, resource?: string): JsonRecord {
    const result: JsonRecord = {
      deviceIxd: this.deviceIxd,
      trackingIxd: crypto.randomUUID(),
      txnIxd: "",
      model: "Google Pixel 8",
      platform: "Android",
      version: "15",
      network: "wifi",
      appVer: CTBC_APP_VERSION,
      clientNo: this.clientNo,
      clientTime: Date.now().toString(),
      locale: "zh_TW",
      fromSys: "0",
      seed: this.seed,
      deviceToken: "",
      buildDisplay: "AP3A.241005.015",
      rqData,
      webVer: CTBC_WEB_VERSION,
    };
    if (resource) result.resource = resource;
    if (this.transactionToken !== "mfpInit") {
      result.token = this.transactionToken;
    }
    return result;
  }

  private async postResource(
    body: JsonRecord,
    headers: Record<string, string>,
  ) {
    const serialized = JSON.stringify(body);
    return this.post(CTBC_RESOURCE_ENDPOINT, serialized, {
      ...this.baseHeaders(),
      checksum: sha256Hex(serialized),
      deviceCode: this.deviceCode,
      ...headers,
    });
  }

  private baseHeaders() {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private async post(
    url: string | URL,
    body: string,
    headers: Record<string, string>,
  ) {
    const endpoint = safeEndpoint(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn(
          JSON.stringify({
            event: "ctbc_mobile_http_failed",
            endpoint,
            status: response.status,
          }),
        );
        throw new CtbcConnectionError("中國信託行動銀行服務暫時無法連線。");
      }
      const text = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new CtbcConnectionError("中國信託行動銀行回應格式已變更。");
      }
      if (!isRecord(data)) {
        throw new CtbcConnectionError("中國信託行動銀行回應格式已變更。");
      }
      const nextAuthToken = response.headers.get("x-auth-token");
      if (nextAuthToken) this.xAuthToken = nextAuthToken;
      return data;
    } catch (error) {
      if (error instanceof CtbcConnectionError) throw error;
      console.warn(
        JSON.stringify({
          event: "ctbc_mobile_transport_failed",
          endpoint,
          kind: error instanceof Error ? error.name : typeof error,
          detail: safeTransportDetail(error),
        }),
      );
      throw new CtbcConnectionError("中國信託行動銀行服務暫時無法連線。");
    } finally {
      clearTimeout(timeout);
    }
  }

  private updateSession(response: JsonRecord) {
    const nextToken = stringValue(response.token);
    if (nextToken) this.transactionToken = nextToken;
    const nextSeed = stringValue(responseData(response).seed);
    if (nextSeed) this.seed = nextSeed;
  }

  private assertResourceSuccess(response: JsonRecord, resource: string) {
    const isLogin = resource === LOGIN_RESOURCE;
    const code = stringValue(response.code);
    const statusCode = stringValue(response.statusCode);
    const system = stringValue(response.sys || response.systemId);
    if (
      !isLogin &&
      (code === "8888" || (system === "ESB" && code === "9201"))
    ) {
      return;
    }
    const failed =
      (code && code !== "0000") ||
      (statusCode && statusCode !== "0000") ||
      response.success === false;
    if (!failed) return;
    console.warn(
      JSON.stringify({
        event: "ctbc_mobile_resource_failed",
        resource,
        system,
        code,
        statusCode,
      }),
    );
    if (isLogin || isVerificationResponse(response)) {
      throw new CtbcVerificationRequiredError(
        "中國信託登入需要重新驗證，請先至官方 App 完成驗證。",
      );
    }
    throw new CtbcConnectionError("中國信託資料同步暫時無法完成。");
  }
}

async function fetchDepositTransactions(
  session: CtbcMobileSession,
  depositOverview: JsonRecord,
  lookbackMonths: number,
) {
  const transactions: unknown[] = [];
  const accountIds = extractDepositAccountIds(depositOverview);
  for (const accountId of accountIds) {
    const initial = await session.resource(DEPOSIT_TRANSACTIONS_INIT_RESOURCE, {
      accountId,
    });
    const queryAccountId = selectTransactionAccountId(initial, accountId);
    for (const range of monthlyRanges(lookbackMonths)) {
      let response: JsonRecord;
      try {
        response = await session.resource(DEPOSIT_TRANSACTIONS_RESOURCE, {
          accountId: queryAccountId,
          startDate: range.startDate,
          endDate: range.endDate,
          keyWord: "",
          type: "custom",
        });
      } catch (error) {
        const initData = responseData(initial);
        const firstSelection = [
          ...arrayValue(initData.accountSelections),
          ...arrayValue(initData.accountInfoList),
        ].find(isRecord);
        console.warn(
          JSON.stringify({
            event: "ctbc_deposit_query_failed",
            initFields: Object.keys(initData).sort(),
            selectionFields: firstSelection
              ? Object.keys(firstSelection).sort()
              : [],
            requestedLast4: last4(accountId),
            queryLast4: last4(queryAccountId),
            requestedLength: accountId.length,
            queryLength: queryAccountId.length,
            queryChanged: queryAccountId !== accountId,
            requestedMasked: /\D/.test(accountId),
            queryMasked: /\D/.test(queryAccountId),
            startDate: range.startDate,
            endDate: range.endDate,
          }),
        );
        throw error;
      }
      for (const item of arrayValue(responseData(response).detailList)) {
        if (isRecord(item))
          transactions.push({ ...item, sourceAccountId: accountId });
      }
    }
  }
  return { rsData: { detailList: transactions } };
}

function selectTransactionAccountId(
  payload: JsonRecord,
  requestedAccountId: string,
) {
  const data = responseData(payload);
  const selected = stringValue(data.accountId).trim();
  const selections = [
    ...arrayValue(data.accountSelections),
    ...arrayValue(data.accountInfoList),
    ...arrayValue(data.selectList),
  ].flatMap((value) => {
    if (!isRecord(value)) return [];
    const accountId = stringValue(value.accountId ?? value.acctId).trim();
    return accountId ? [accountId] : [];
  });
  return (
    selections.find((value) => value === selected) ??
    selections.find((value) => value === requestedAccountId) ??
    selections[0] ??
    (selected || requestedAccountId)
  );
}

async function fetchUnbilledTransactions(session: CtbcMobileSession) {
  const initial = await session.resource(UNBILLED_INIT_RESOURCE, {});
  const currencies = extractCurrencyCodes(responseData(initial));
  const allItems: unknown[] = [];
  for (const currency of currencies.length ? currencies : ["TWD"]) {
    const response = await fetchPagedCardItems(
      session,
      UNBILLED_RESOURCE,
      UNBILLED_PAGE_RESOURCE,
      { curCode: currency },
    );
    for (const item of arrayValue(responseData(response).allItems)) {
      allItems.push(
        isRecord(item) ? { ...item, sourceCurrency: currency } : item,
      );
    }
  }
  return { rsData: { allItems } };
}

async function fetchPagedCardItems(
  session: CtbcMobileSession,
  initialResource: string,
  pageResource: string,
  rqData: JsonRecord,
) {
  const initial = await session.resource(initialResource, rqData);
  const data = responseData(initial);
  const allItems = [...arrayValue(data.allItems)];
  const pageCount = numberValue(data.pageCount) ?? 100;
  const totalRows = numberValue(data.totalRow) ?? allItems.length;
  const displayPaging =
    data.displayPaging === true || data.displayPaging === "Y";
  const totalPages = displayPaging
    ? Math.min(MAX_PAGES, Math.max(1, Math.ceil(totalRows / pageCount)))
    : 1;
  for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
    const page = await session.resource(pageResource, { pageNum });
    allItems.push(...arrayValue(responseData(page).allItems));
  }
  return { rsData: { ...data, allItems } };
}

function extractDepositAccountIds(payload: JsonRecord) {
  const rsData = responseData(payload);
  const twd = recordValue(rsData.twdAcctSummaryResponse);
  const demand = recordValue(twd.demDepBalSummaryResponse);
  return arrayValue(demand.infoList).flatMap((value) => {
    if (!isRecord(value)) return [];
    const accountId = stringValue(value.accountId).trim();
    return accountId ? [accountId] : [];
  });
}

function extractCurrencyCodes(data: JsonRecord) {
  const values = [
    ...arrayValue(data.curOptions),
    ...arrayValue(data.curDataList),
  ];
  return Array.from(
    new Set(
      values.flatMap((value) => {
        if (!isRecord(value)) return [];
        const code = stringValue(value.curCode).trim().toUpperCase();
        return code ? [code === "NTD" ? "TWD" : code] : [];
      }),
    ),
  );
}

function monthlyRanges(months: number, now = new Date()) {
  const count = Math.max(1, Math.min(6, months));
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const ranges: Array<{ startDate: string; endDate: string }> = [];
  // Keep each request within one calendar month, matching the App's default
  // history tabs and avoiding backend date-span validation differences.
  for (let offset = 0; offset < count; offset += 1) {
    const oldestOffset = offset;
    const start = new Date(
      Date.UTC(
        taipeiNow.getUTCFullYear(),
        taipeiNow.getUTCMonth() - oldestOffset,
        1,
      ),
    );
    const end =
      offset === 0
        ? taipeiNow
        : new Date(
            Date.UTC(
              taipeiNow.getUTCFullYear(),
              taipeiNow.getUTCMonth() - offset + 1,
              0,
            ),
          );
    ranges.push({ startDate: compactDate(start), endDate: compactDate(end) });
  }
  return ranges;
}

function compactDate(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function sha256Hex(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function safeEndpoint(url: string | URL) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return "unknown";
  }
}

function safeTransportDetail(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return message
    .replace(/https?:\/\/[^\s?]+(?:\?[^\s]*)?/gi, "[url]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .slice(0, 160);
}

function randomDigits(
  length: number,
  randomBytes: (length: number) => Uint8Array,
) {
  const bytes = randomBytes(length);
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String((bytes[index] ?? 0) % 10);
  }
  return value;
}

function secureRandomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBinary(bytes: Uint8Array) {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return result;
}

function responseData(response: JsonRecord) {
  return recordValue(response.rsData);
}

function containsVerificationFlag(data: JsonRecord) {
  return Object.entries(data).some(
    ([key, value]) =>
      isVerificationFlagKey(key) &&
      (value === true ||
        value === 1 ||
        /^(?:y|yes|required|pending|true|1)$/i.test(stringValue(value).trim())),
  );
}

function verificationFlagNames(data: JsonRecord) {
  const known = [
    "needBindDevice",
    "dupLoginCheckTimestamp",
    "deviceBindBlackListCheckTimestamp",
  ].filter((key) => data[key] === true || hasText(data[key]));
  const dynamic = Object.entries(data).flatMap(([key, value]) =>
    isVerificationFlagKey(key) &&
    (value === true ||
      value === 1 ||
      /^(?:y|yes|required|pending|true|1)$/i.test(stringValue(value).trim()))
      ? [key]
      : [],
  );
  return Array.from(new Set([...known, ...dynamic])).sort();
}

function isVerificationFlagKey(key: string) {
  return (
    /^(?:need|require|required|pending|challenge).*(?:otp|verify|verification|binddevice|twostage)/i.test(
      key,
    ) ||
    /(?:otp|verify|verification|binddevice|twostage).*(?:required|pending|challenge)$/i.test(
      key,
    )
  );
}

function isVerificationResponse(response: JsonRecord) {
  const code = stringValue(response.code || response.statusCode);
  if (["0526", "2802", "2911", "4002", "4050", "9015", "9030"].includes(code)) {
    return true;
  }
  const description = stringValue(
    response.desc || response.message || response.statusMessage,
  );
  return /otp|verification|device|login|password|驗證|裝置|登入|密碼/i.test(
    description,
  );
}

function hasText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function numberValue(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const text = stringValue(value).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function last4(value: string) {
  return value.match(/(\d{4})\D*$/)?.[1] ?? "unknown";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
