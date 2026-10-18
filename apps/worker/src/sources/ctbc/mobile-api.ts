import { CtbcVerificationRequiredError } from "./errors";
export { CtbcVerificationRequiredError } from "./errors";
import { fetchCtbcForeignDeposits } from "./foreign-deposits";
import type { SyncResult } from "../types";
import { reportSyncProgress } from "../sync-progress";

import forge from "node-forge";
import { fetchCtbcCardStatements, fetchCtbcPagedCardItems } from "./card-data";
import {
  parseCtbcData,
  type CtbcConfig,
  type CtbcPayloads,
  type CtbcPendingSession,
} from "./protocol";
import { BANK_SYNC_MONTHS } from "../sync-window";
import { isNoCreditCardMessage } from "../credit-card-status";

const CTBC_IMP_ORIGIN = "https://eb.ctbcbank.com/IMP";
const CTBC_APPLICATION = "EBMW_Adapter";
const CTBC_RESOURCE_ENDPOINT = `${CTBC_IMP_ORIGIN}/api/adapters/${CTBC_APPLICATION}/resource/ebmwResource`;
// Google Play Taiwan latest version, verified on 2026-10-10.
const CTBC_APP_VERSION = "5.2.26";
// UtilsService.getWebVersion() in the public Android 5.2.26 package.
const CTBC_WEB_VERSION = "(0812)";
const CTBC_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36";
// MobileFirst client-credential value shipped in the public Android package.
const CTBC_PUBLIC_CLIENT_TOKEN = "2ae74c0ad7a14739a2aab7340616d70e";
const REQUEST_TIMEOUT_MS = 45_000;
const PASSWORD_CHANGE_MESSAGE =
  "中國信託要求變更密碼，自動同步已暫停。請至官方 App 完成變更，再更新這裡的密碼並手動同步。";

const CTBC_PIN_RSA_EXPONENT = "9719";
const CTBC_PIN_RSA_MODULUS =
  "DF63FFC2F35068BA9A964D234C3400E6394148BC69DF0DD8257340747AD73BF8514C76254F5BEA223BFF76B63840034518E0FA0A1E1905129EC69203A0873A63E5238FFE538DBEFBB64F9318C0BEEF75595DE991E004213B7FE9DA62229BDA1722B45ABAF906F26CF6D88B5BE8F18C26FCA630C6813B0D370E64E1C8D80A790F936C064A5620BFA2C6EE4B5BB962F7703A258028D53923866E43C98C36758262D6DE9D02DECFD74B211E3233924D499B864E1CA86DF012EAFFC9933A0CD2E011843B772E53C6435F78A60437E82D1677664221D01F59797D28771B2AE207EAB00E8500AA2A4FB61FF330B59FC5B699A241D9A44139CF876A74F0DE180107D7DF";

const LOGIN_RESOURCE = "/twrbm-general/ot001/010";
const TWO_STAGE_STATUS_RESOURCE = "/twrbm-general/ot001/002";
const TWO_STAGE_EMAIL_RESOURCE = "/twrbm-general/ot001/003";
const TWO_STAGE_EMAIL_VERIFY_RESOURCE = "/twrbm-general/ot001/004";
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

export class CtbcTwoStageRequiredError extends CtbcVerificationRequiredError {
  constructor(readonly method: "app" | "email") {
    super(
      method === "app"
        ? "請在已綁定的中國信託 App 確認這次登入，再按「我已確認，繼續同步」；也可改用 Email 驗證。"
        : "請輸入中國信託寄送的 Email 驗證碼，接續完成這次登入。",
    );
    this.name = "CtbcTwoStageRequiredError";
  }
}

export class CtbcVerificationExpiredError extends CtbcVerificationRequiredError {
  constructor() {
    super("中國信託登入驗證已過期或未獲核准，請重新開始驗證。");
    this.name = "CtbcVerificationExpiredError";
  }
}

export type CtbcSyncOverrides = {
  verification?: "check" | "email" | "restart";
  otp?: string;
};

type CtbcConnectorOptions = {
  allowInteractiveVerification?: boolean;
  onDeviceSeed?: (seed: string) => Promise<void>;
  onPendingSession?: (session: CtbcPendingSession | undefined) => Promise<void>;
};

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
 * Reproduces the App 5.2.26 `makeEncryptPINClear` format. Plaintext exists only
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
  options: CtbcConnectorOptions = {},
) {
  // Keep login, interactive approval, resume and logout in one lifecycle.
  async function withSession<T>(
    config: CtbcConfig,
    overrides: CtbcSyncOverrides,
    read: (session: CtbcMobileSession) => Promise<T>,
  ): Promise<T> {
    const credentials = requireCtbcCredentials(config);
    const session = new CtbcMobileSession(
      fetcher,
      config.deviceCode ?? crypto.randomUUID(),
      config.deviceSeed ?? config.pendingSession?.seed,
      options,
    );
    try {
      if (overrides.verification === "restart") {
        if (!options.allowInteractiveVerification)
          throw new CtbcVerificationRequiredError("請手動重新開始中信驗證。");
        await options.onPendingSession?.(undefined);
      } else if (config.pendingSession) {
        await session.resumeLogin(config.pendingSession, overrides);
      } else if (overrides.verification || overrides.otp) {
        throw new CtbcVerificationExpiredError();
      }
      if (!session.isLoggedIn) {
        await session.bootstrap();
        await session.login(credentials);
      }
      return await read(session);
    } catch (error) {
      throw classifyCtbcError(error);
    } finally {
      await session.logout();
    }
  }

  return {
    id: "ctbc" as const,
    name: "中國信託商業銀行",

    async sync(
      config: CtbcConfig,
      _cursor?: string,
      overrides: CtbcSyncOverrides = {},
    ): Promise<SyncResult<never>> {
      return withSession(config, overrides, async (session) => {
        reportSyncProgress("fetching");

        const depositOverview = await session.resource(
          DEPOSIT_OVERVIEW_RESOURCE,
          {},
        );
        const depositTransactions = await fetchDepositTransactions(
          session,
          depositOverview,
        );
        let creditCards = await session.resource(
          CREDIT_CARD_BILLS_RESOURCE,
          {},
        );
        const noCreditCard = hasNoCtbcCreditCard(creditCards);
        if (!noCreditCard)
          creditCards = await fetchCtbcCardStatements(
            (resource, data) => session.resource(resource, data),
            creditCards,
          );
        // The summary call refreshes the same session data used by the official
        // App (available credit and billed/unbilled totals). Its raw response is
        // intentionally not persisted until those fields have a stable mapping.
        if (!noCreditCard)
          await session.resource(CREDIT_CARD_SUMMARY_RESOURCE, {});
        const unbilled = noCreditCard
          ? undefined
          : await fetchUnbilledTransactions(session);
        const realtime = noCreditCard
          ? undefined
          : await fetchPagedCardItems(
              session,
              REALTIME_RESOURCE,
              REALTIME_PAGE_RESOURCE,
              {},
            );
        const payloads: CtbcPayloads = {
          depositOverview,
          depositTransactions,
          creditCards: noCreditCard ? undefined : creditCards,
          unbilled,
          realtime,
        };
        const now = new Date();
        const parsed = parseCtbcData(payloads, now);
        try {
          const foreign = await fetchCtbcForeignDeposits(
            (resource, data) => session.resource(resource, data),
            depositOverview,
            now,
          );
          // Publish the FX block only after every account/month has succeeded.
          parsed.bankAccounts.push(...foreign.bankAccounts);
          parsed.bankBalanceSnapshots.push(...foreign.bankBalanceSnapshots);
          parsed.bankTransactions.push(...foreign.bankTransactions);
        } catch (error) {
          if (error instanceof CtbcVerificationRequiredError) throw error;
          // An unknown failure is not a confirmed empty account. Omit all new
          // FX records; persistence upserts leave the previous FX data intact.
          // Never log provider errors, account identifiers or wire payloads.
          console.warn(
            "[ctbc] foreign_deposits_skipped: foreign deposit sync incomplete; previous foreign data retained",
          );
        }
        return {
          records: [],
          ...parsed,
          cursor: JSON.stringify({ syncedAt: new Date().toISOString() }),
        };
      });
    },
  };
}

class CtbcMobileSession {
  private readonly deviceIxd: string;
  private clientNo = Date.now().toString();
  private accessToken = "";
  private xAuthToken = "";
  private transactionToken = "mfpInit";
  private seed = "";
  private loggedIn = false;
  private httpStatus: number | null = null;
  private loginAttempt = 0;
  private loginConfirmationType: "initial" | "duplicate" = "initial";

  constructor(
    private readonly fetcher: CtbcFetch,
    private readonly deviceCode: string,
    deviceSeed: string | undefined,
    private readonly options: CtbcConnectorOptions,
  ) {
    this.deviceIxd = deviceCode.replace(/-/g, "");
    this.seed = deviceSeed ?? "";
  }

  get isLoggedIn() {
    return this.loggedIn;
  }

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
    // The official App restores seed before the handshake, and only saves the
    // returned seed when none was stored. Keeping the mobile identity does not
    // enroll this client as a bound phone or a trusted web browser.
    if (!this.seed) {
      this.seed = stringValue(responseData(handshake).seed);
      if (this.seed) await this.options.onDeviceSeed?.(this.seed);
    }
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
      // OT044's prepareLoginRq/doLogin declares support for the new login
      // protocol here; the envelope's appVer alone is not equivalent.
      version: CTBC_APP_VERSION,
      twoStageVerify: true,
      userAgent: CTBC_USER_AGENT,
      deviceBindBlackList: "Y",
      checkDeviceShare: "Y",
      userId: encryptCtbcPin(credentials.account),
      pin: encryptCtbcPin(credentials.password),
    };
    await this.finishLogin(
      await this.resource(LOGIN_RESOURCE, loginRequest),
      loginRequest,
    );
  }

  private async finishLogin(response: JsonRecord, loginRequest: JsonRecord) {
    // Both password login and TWO_STAGE_VERIFY may need duplicate-login
    // confirmation. Continue with the same login request and session.
    // Blacklisted/shared-device confirmations still require the official App.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (
        isVerificationResponse(response) ||
        responseData(response).forcePwdChange != null ||
        hasText(responseData(response).deviceBindBlackListCheckTimestamp)
      )
        break;
      const data = responseData(response);
      const duplicateTimestamp = stringValue(
        data.dupLoginCheckTimestamp,
      ).trim();
      if (duplicateTimestamp) {
        loginRequest.dupLoginCheckTimestamp = duplicateTimestamp;
        this.loginConfirmationType = "duplicate";
      } else {
        break;
      }
      response = await this.resource(LOGIN_RESOURCE, loginRequest);
    }

    const data = responseData(response);
    if (data.forcePwdChange != null) {
      // The bank has authenticated this session but requires a password change
      // before using it. Stop account queries and close it in finally.
      this.loggedIn = true;
      throw new CtbcVerificationRequiredError(PASSWORD_CHANGE_MESSAGE);
    }

    if (
      data.isTwoStageLogin === true &&
      !hasText(data.dupLoginCheckTimestamp) &&
      !hasText(data.deviceBindBlackListCheckTimestamp) &&
      !hasText(data.verifySharedDeviceTimestamp) &&
      !hasContactVerification(data) &&
      !containsVerificationFlag(data) &&
      (this.options.allowInteractiveVerification ||
        this.options.onPendingSession)
    ) {
      const method =
        hasText(data.twoStageVerifyEmail) &&
        hasText(data.twoStageVerifyEmailAuthId)
          ? "email"
          : "app";
      await this.savePendingLogin(
        loginRequest,
        method,
        verificationExpiresAt(data),
      );
      throw new CtbcTwoStageRequiredError(method);
    }

    if (
      data.needBindDevice === true ||
      hasText(data.dupLoginCheckTimestamp) ||
      hasText(data.deviceBindBlackListCheckTimestamp) ||
      isVerificationResponse(response)
    ) {
      console.warn(
        JSON.stringify({
          event: "ctbc_login_verification_required",
          ...this.loginDiagnostics(response),
        }),
      );
      throw new CtbcVerificationRequiredError(
        "中國信託要求裝置、兩階段登入或一次性密碼驗證，目前無法自動完成；請先使用官方 App。",
      );
    }
    this.loggedIn = true;
    await this.options.onPendingSession?.(undefined);
  }

  async resumeLogin(pending: CtbcPendingSession, overrides: CtbcSyncOverrides) {
    if (!this.options.allowInteractiveVerification) {
      throw new CtbcVerificationRequiredError(
        "中國信託需要手動完成登入驗證，自動同步已暫停。",
      );
    }
    if (Date.parse(pending.expiresAt) <= Date.now())
      throw new CtbcVerificationExpiredError();
    if (!overrides.verification && !overrides.otp)
      throw new CtbcTwoStageRequiredError(pending.method);

    this.clientNo = pending.clientNo;
    this.accessToken = pending.accessToken;
    this.xAuthToken = pending.xAuthToken;
    this.transactionToken = pending.transactionToken;
    this.seed = pending.seed;

    if (overrides.verification === "email") {
      if (pending.method === "email")
        throw new CtbcTwoStageRequiredError("email");
      const response = await this.resource(TWO_STAGE_EMAIL_RESOURCE, {
        genType: "2",
      });
      const data = responseData(response);
      if (
        !hasText(data.twoStageVerifyEmail) ||
        !hasText(data.twoStageVerifyEmailAuthId)
      )
        throw new CtbcVerificationExpiredError();
      await this.savePendingLogin(
        pending.loginRequest,
        "email",
        verificationExpiresAt(data),
      );
      throw new CtbcTwoStageRequiredError("email");
    }

    if (overrides.otp) {
      if (pending.method !== "email" || !/^\d{4}$/.test(overrides.otp))
        throw new CtbcVerificationRequiredError(
          "請輸入 Email 中的四位數字驗證碼。",
        );
      const response = await this.resource(TWO_STAGE_EMAIL_VERIFY_RESOURCE, {
        twoStageVerifyEmailAuthCode: overrides.otp,
      });
      if (
        stringValue(response.code) !== "0000" &&
        stringValue(response.statusCode) !== "0000" &&
        response.success !== true
      )
        throw new CtbcVerificationExpiredError();
    } else {
      if (pending.method !== "app" || overrides.verification !== "check")
        throw new CtbcTwoStageRequiredError(pending.method);
      const data = responseData(
        await this.resource(TWO_STAGE_STATUS_RESOURCE, {}),
      );
      if (data.keepListen === true) {
        await this.savePendingLogin(
          pending.loginRequest,
          "app",
          pending.expiresAt,
        );
        throw new CtbcTwoStageRequiredError("app");
      }
      if (data.keepListen !== false || data.twoStageVerifySuccess !== true)
        throw new CtbcVerificationExpiredError();
    }

    // OT044 continues with the original encrypted PINs and the same session.
    // An approval never causes another fresh password login.
    const loginRequest = {
      ...pending.loginRequest,
      loginType: "TWO_STAGE_VERIFY",
    };
    await this.finishLogin(
      await this.resource(LOGIN_RESOURCE, loginRequest),
      loginRequest,
    );
  }

  private async savePendingLogin(
    loginRequest: JsonRecord,
    method: CtbcPendingSession["method"],
    expiresAt: string,
  ) {
    await this.options.onPendingSession?.({
      clientNo: this.clientNo,
      accessToken: this.accessToken,
      xAuthToken: this.xAuthToken,
      transactionToken: this.transactionToken,
      seed: this.seed,
      loginRequest,
      method,
      expiresAt,
    });
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
    if (resource === LOGIN_RESOURCE) this.loginAttempt += 1;
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
      "User-Agent": CTBC_USER_AGENT,
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
      this.httpStatus = response.status;
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
  }

  private assertResourceSuccess(response: JsonRecord, resource: string) {
    const isLogin = resource === LOGIN_RESOURCE;
    const isTwoStage = [
      TWO_STAGE_STATUS_RESOURCE,
      TWO_STAGE_EMAIL_RESOURCE,
      TWO_STAGE_EMAIL_VERIFY_RESOURCE,
    ].includes(resource);
    const code = stringValue(response.code);
    const statusCode = stringValue(response.statusCode);
    const system = stringValue(response.sys || response.systemId);
    if (
      (resource === CREDIT_CARD_BILLS_RESOURCE ||
        resource.startsWith("/twrbm-fx/")) &&
      isVerificationResponse(response)
    ) {
      throw new CtbcVerificationRequiredError(
        "中國信託登入需要重新驗證，請先至官方 App 完成驗證。",
      );
    }
    if (
      resource === CREDIT_CARD_BILLS_RESOURCE &&
      isNoCreditCardMessage(response.message)
    )
      return;
    if (
      !isLogin &&
      !isTwoStage &&
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
        ...(isLogin ? this.loginDiagnostics(response) : {}),
      }),
    );
    if (isLogin && responseData(response).forcePwdChange != null) {
      throw new CtbcVerificationRequiredError(PASSWORD_CHANGE_MESSAGE);
    }
    if (isTwoStage) {
      throw new CtbcVerificationExpiredError();
    }
    if (isVerificationResponse(response)) {
      throw new CtbcVerificationRequiredError(
        "中國信託登入需要重新驗證，請先至官方 App 完成驗證。",
      );
    }
    throw new CtbcConnectionError("中國信託資料同步暫時無法完成。");
  }

  private loginDiagnostics(response: JsonRecord) {
    const data = responseData(response);
    const desc = typeof response.desc === "string" ? response.desc : "";
    return {
      httpStatus: this.httpStatus,
      loginAttempt: this.loginAttempt,
      confirmationType: this.loginConfirmationType,
      appVer: CTBC_APP_VERSION,
      webVer: CTBC_WEB_VERSION,
      statusCodeType:
        response.statusCode === undefined
          ? "missing"
          : response.statusCode === null
            ? "null"
            : typeof response.statusCode,
      descCategory: !hasText(desc)
        ? "missing"
        : /更新至最新版本/.test(desc)
          ? "app_update_prompt"
          : "other",
      hasRsData: isRecord(response.rsData),
      verificationFlags: {
        deviceConfirmation: hasText(data.deviceBindBlackListCheckTimestamp),
        duplicateLoginConfirmation: hasText(data.dupLoginCheckTimestamp),
        sharedDeviceConfirmation: hasText(data.verifySharedDeviceTimestamp),
        contactVerification: hasContactVerification(data),
        bindDevice: containsVerificationFlag(data, /binddevice/i),
        otp: containsVerificationFlag(data, /otp/i),
        twoStage:
          data.isTwoStageLogin === true ||
          containsVerificationFlag(data, /twostage/i),
        verificationRequired: isVerificationResponse(response),
      },
    };
  }
}

function hasNoCtbcCreditCard(response: JsonRecord) {
  if (isVerificationResponse(response)) return false;
  if (isNoCreditCardMessage(response.message)) return true;
  const data = responseData(response);
  return (
    Array.isArray(data.cardDataList) &&
    data.cardDataList.length === 0 &&
    isRecord(data.billData) &&
    Object.keys(data.billData).length === 0
  );
}

async function fetchDepositTransactions(
  session: CtbcMobileSession,
  depositOverview: JsonRecord,
) {
  const transactions: unknown[] = [];
  const accounts = extractDepositAccounts(depositOverview);
  for (const account of accounts) {
    const { accountId } = account;
    let initial: JsonRecord;
    try {
      initial = await session.resource(DEPOSIT_TRANSACTIONS_INIT_RESOURCE, {
        accountId,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "ctbc_deposit_init_failed",
          accountIndex: account.overviewIndex,
          accountCount: accounts.length,
          overviewFields: account.fields,
          requestedLast4: last4(accountId),
          requestedLength: accountId.length,
          requestedMasked: /[*Ｘx#•]/.test(accountId),
        }),
      );
      throw error;
    }
    const queryAccountId = selectTransactionAccountId(initial, accountId);
    for (const range of monthlyRanges(BANK_SYNC_MONTHS)) {
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
  return fetchCtbcPagedCardItems(
    (resource, data) => session.resource(resource, data),
    initialResource,
    pageResource,
    rqData,
    initialResource === REALTIME_RESOURCE ? "realtime" : "unbilled",
  );
}

function extractDepositAccounts(payload: JsonRecord) {
  const rsData = responseData(payload);
  const twd = recordValue(rsData.twdAcctSummaryResponse);
  const demand = recordValue(twd.demDepBalSummaryResponse);
  return arrayValue(demand.infoList).flatMap((value, overviewIndex) => {
    if (!isRecord(value)) return [];
    const accountId = stringValue(value.accountId).trim();
    return accountId
      ? [{ accountId, fields: Object.keys(value).sort(), overviewIndex }]
      : [];
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

function containsVerificationFlag(data: JsonRecord, namePattern?: RegExp) {
  return Object.entries(data).some(
    ([key, value]) =>
      isVerificationFlagKey(key) &&
      (!namePattern || namePattern.test(key)) &&
      (value === true ||
        value === 1 ||
        /^(?:y|yes|required|pending|true|1)$/i.test(stringValue(value).trim())),
  );
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
  // Login failures and descriptions mentioning login can also mean maintenance.
  // Require a verification signal before asking the user to verify in the App.
  const data = responseData(response);
  return (
    data.forcePwdChange != null ||
    data.isTwoStageLogin === true ||
    hasText(data.deviceBindBlackListCheckTimestamp) ||
    hasText(data.verifySharedDeviceTimestamp) ||
    hasContactVerification(data) ||
    containsVerificationFlag(data)
  );
}

function hasContactVerification(data: JsonRecord) {
  // OT044 interrupts login for EMAIL_VERIFY (11) and MOBILE_VERIFY (21).
  const verification = recordValue(data.verifyData).verify;
  return verification === "11" || verification === "21";
}

function verificationExpiresAt(data: JsonRecord) {
  const seconds = numberValue(data.twoStageCountDownSec) ?? 300;
  if (seconds <= 0) throw new CtbcVerificationExpiredError();
  return new Date(Date.now() + Math.min(seconds, 300) * 1000).toISOString();
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function last4(value: string) {
  return value.match(/(\d{4})\D*$/)?.[1] ?? "unknown";
}
