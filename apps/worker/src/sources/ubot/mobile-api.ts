import type { SourceSyncError, SourceSyncErrorSource } from "../sync-error";
import type { SyncResult } from "../types";
import { reportSyncProgress } from "../sync-progress";
import { BANK_SYNC_MONTHS } from "../sync-window";
import {
  deriveUbotDeviceUuid,
  encryptUbotPassword,
  encryptUbotRequest,
  formatUbotSid,
  hasUbotCreditCard,
  normalizeHalfWidth,
  parseUbotCreditCardData,
  parseUbotDepositData,
  parseUbotLoanData,
  UbotProtocolError,
  type UbotConfig,
  type UbotFxTransactionPayload,
  type UbotStatementPayload,
} from "./protocol";

const UBOT_ORIGIN = "https://newnewbank.ubot.com.tw";
const UBOT_REFERER = "https://newnewbank.ubot.com.tw/nnbank/";
const SVC_PREFIX = "/NNBank/svc/";

const RSA_KEY_API = "NNBCM000007";
const REQEC_KEY_API = "NNBCM000011";
const LOGIN_API = "NNBI010101";
const LOGOUT_API = "NNBI010103";

const TWD_SUMMARY_API = "NNBN020101";
const TWD_TX_API = "NNBN010201";
const TWD_TIME_DEPOSIT_API = "NNBN030101";

const FX_SUMMARY_API = "NNBF010201";
const FX_TX_API = "NNBF050201";
const FX_TIME_DEPOSIT_API = "NNBF020301";

const CARD_LIST_API = "NNBC010105";
const CARD_SUMMARY_API = "NNBC010101";
const CARD_UNBILLED_API = "NNBC010102";
const CARD_STATEMENT_HEADERS_API = "NNBC080201";
const CARD_STATEMENT_DETAIL_API = "NNBC010104";
const CARD_REALTIME_AUTH_API = "NNBC080101";
const CARD_AUTOPAY_API = "NNBC030101";

const LOAN_SUMMARY_API = "NNBL010401";

const UBOT_APP_VERSION = "4.6.0";
const UBOT_DEVICE_MODEL = "google-husky";
const UBOT_DEVICE_OS_VER = "Android15";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TX_SPLIT_DEPTH = 8;

const LOGIN_ACCEPT_CODES = new Set(["0000", "NS161", "NS164"]);
const CREDENTIAL_ERROR_CODES = new Set(["NS169", "NS168", "NM92"]);
const SESSION_EXPIRED_CODES = new Set(["NS888", "NS02", "NS03"]);

type JsonRecord = Record<string, unknown>;

export type UbotCredentials = {
  userId: string;
  account: string;
  password: string;
};

export type UbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class UbotVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UbotVerificationRequiredError";
  }
}

export class UbotConnectionError
  extends Error
  implements SourceSyncErrorSource
{
  constructor(message = "聯邦 New New Bank 資料同步暫時無法完成。") {
    super(message);
    this.name = "UbotConnectionError";
  }

  toSyncError(): SourceSyncError {
    return { status: 502, code: "UBOT_CONNECTION_FAILED" };
  }
}

export function requireUbotCredentials(
  config: Pick<UbotConfig, "userId" | "account" | "password">,
): UbotCredentials {
  const userId = normalizeHalfWidth(config.userId ?? "").toUpperCase();
  const account = normalizeHalfWidth(config.account ?? "");
  const password = normalizeHalfWidth(config.password ?? "");

  if (
    !/^[A-Z][A-Z0-9]{7,10}$/.test(userId) ||
    !/^[A-Za-z0-9]{6,12}$/.test(account) ||
    !/^[A-Za-z0-9]{6,12}$/.test(password)
  ) {
    throw new UbotVerificationRequiredError(
      "請先儲存聯邦 New New Bank 身分證字號、使用者代號與使用者密碼（代號與密碼須為 6 至 12 碼英數字）。",
    );
  }
  return { userId, account, password };
}

export function classifyUbotError(error: unknown) {
  if (
    error instanceof UbotVerificationRequiredError ||
    error instanceof UbotConnectionError ||
    error instanceof UbotProtocolError
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new UbotConnectionError(
    message ? `聯邦 New New Bank 資料同步失敗：${message}` : undefined,
  );
}

export function buildUbotApiDiagnostic(
  apiName: string,
  rtnCode: unknown,
  rtnMsg: unknown,
) {
  const message = safeProviderMessage(rtnMsg);
  return {
    event: "ubot_api_rejected",
    endpoint: /^[A-Z0-9]{6,12}$/.test(apiName) ? apiName : "Unknown",
    returnCode: safeReturnCode(rtnCode),
    ...(message ? { returnMessage: message } : {}),
  };
}

export function createUbotConnector(
  fetcher: UbotFetch = globalThis.fetch.bind(globalThis),
) {
  return {
    id: "ubot" as const,
    name: "聯邦 New New Bank",

    async sync(
      config: UbotConfig,
      cursor?: string,
    ): Promise<SyncResult<never>> {
      const credentials = requireUbotCredentials(config);
      const deviceUuid =
        normalizeDeviceUuid(config.deviceUuid) ??
        deviceUuidFromCursor(cursor) ??
        deriveUbotDeviceUuid(credentials.userId);
      const session = new UbotMobileSession(fetcher);

      try {
        await session.login(credentials, deviceUuid);
        reportSyncProgress("fetching");

        const now = new Date();
        const range = transactionDateRange(now);

        // 1. 臺幣活存總覽與交易明細
        const twdSummary = await session.postRequired(TWD_SUMMARY_API, {});
        const twdTransactions = await session.fetchTwdTransactions(
          range.beginDate,
          range.endDate,
        );

        // 2. 臺幣定存總覽
        const twdTimeDeposit = await session.postOptional(
          TWD_TIME_DEPOSIT_API,
          {},
        );

        // 3. 外幣活存總覽、交易明細與外幣定存
        const fxSummary = await session.postOptional(FX_SUMMARY_API, {}, [
          "NS102",
        ]);
        const fxTransactions: UbotFxTransactionPayload[] = [];
        if (fxSummary) {
          const fxAccountNo = normalizeHalfWidth(
            stringValue(fxSummary.Account),
          ).replace(/\D/g, "");
          const ftList = Array.isArray(fxSummary.FTList)
            ? fxSummary.FTList
            : [];
          for (const item of ftList) {
            if (!isRecord(item)) continue;
            const currencyNum = stringValue(item.CurrencyNum).trim();
            const currency = stringValue(item.CurrencyEnglish)
              .trim()
              .toUpperCase();
            if (!fxAccountNo || !currencyNum || !/^[A-Z]{3}$/.test(currency)) {
              continue;
            }
            const fxTxPayload = await session.postOptional(
              FX_TX_API,
              {
                acctNo: fxAccountNo,
                beginDate: range.beginDate,
                endDate: range.endDate,
                currency: currencyNum,
              },
              undefined,
              true,
            );
            if (fxTxPayload) {
              fxTransactions.push({
                accountNumber: fxAccountNo,
                currency,
                payload: fxTxPayload,
              });
            }
          }
        }
        const fxTimeDeposit = await session.postOptional(
          FX_TIME_DEPOSIT_API,
          {},
          ["NS102"],
        );

        const depositData = parseUbotDepositData(
          {
            twdSummary,
            twdTransactions,
            twdTimeDeposit,
            fxSummary,
            fxTransactions,
            fxTimeDeposit,
          },
          now,
        );

        // 4. 信用卡帳務、未出帳消費、近期帳單與即時消費授權
        const cardList = await session.postRequired(CARD_LIST_API, {});
        let creditCardData = parseUbotCreditCardData({ cardList: {} }, now);
        if (hasUbotCreditCard(cardList)) {
          const [
            cardSummary,
            cardUnbilled,
            statementHeaders,
            realtimeAuth,
            autopay,
          ] = await Promise.all([
            session.postOptional(CARD_SUMMARY_API, {}),
            session.postRequired(CARD_UNBILLED_API, {}),
            session.postRequired(CARD_STATEMENT_HEADERS_API, {}),
            session.postOptional(CARD_REALTIME_AUTH_API, {}, ["0002"]),
            session.postOptional(CARD_AUTOPAY_API, {}),
          ]);

          // occurrence 依完整的已出帳與未出帳清單計算，缺資料時不能回傳部分結果。
          if (
            !Array.isArray(cardUnbilled.UnbillList) ||
            !Array.isArray(statementHeaders.HeaderInfo)
          ) {
            throw new UbotProtocolError();
          }
          const periods = statementHeaders.HeaderInfo.map((header) => {
            const period = isRecord(header)
              ? stringValue(header.Date).trim()
              : "";
            if (!/^\d{5,6}$/.test(period)) throw new UbotProtocolError();
            return period;
          }).slice(0, BANK_SYNC_MONTHS);
          const statements: UbotStatementPayload[] = [];
          for (const period of periods) {
            // 已列於帳單清單的期別必須取得明細，B060 也不可當作空帳單略過。
            const stmtPayload = await session.postRequired(
              CARD_STATEMENT_DETAIL_API,
              { date: period },
            );
            if (!Array.isArray(stmtPayload.BillList)) {
              throw new UbotProtocolError();
            }
            statements.push({ period, payload: stmtPayload });
          }

          creditCardData = parseUbotCreditCardData(
            {
              cardList,
              summary: cardSummary,
              unbilled: cardUnbilled,
              statementHeaders,
              statements,
              realtimeAuth,
              autopay,
            },
            now,
          );
        }

        // 5. 個人貸款總覽
        const loanSummary = await session.postOptional(
          LOAN_SUMMARY_API,
          {},
          ["NSLOND"],
          true,
        );
        const loanData = parseUbotLoanData(loanSummary ?? {}, now);

        return {
          records: [],
          bankAccounts: [
            ...depositData.bankAccounts,
            ...creditCardData.bankAccounts,
            ...loanData.bankAccounts,
          ],
          bankBalanceSnapshots: [
            ...depositData.bankBalanceSnapshots,
            ...creditCardData.bankBalanceSnapshots,
            ...loanData.bankBalanceSnapshots,
          ],
          bankTransactions: [
            ...depositData.bankTransactions,
            ...creditCardData.bankTransactions,
          ],
          creditCardBills: creditCardData.creditCardBills,
          cursor: JSON.stringify({
            syncedAt: now.toISOString(),
            deviceUuid,
          }),
        };
      } catch (error) {
        throw classifyUbotError(error);
      } finally {
        await session.logout();
      }
    },
  };
}

class UbotMobileSession {
  private ssid = "";
  private loggedIn = false;
  private readonly cookies = new Map<string, string>();

  constructor(private readonly fetcher: UbotFetch) {}

  async login(credentials: UbotCredentials, deviceUuid: string) {
    const rsaKeyRes = await this.rawPost(RSA_KEY_API, {});
    if (rsaKeyRes.rtnCode !== "0000") {
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(
            RSA_KEY_API,
            rsaKeyRes.rtnCode,
            rsaKeyRes.rtnMsg,
          ),
        ),
      );
      throw new UbotConnectionError(
        rsaKeyRes.rtnMsg
          ? `聯邦 New New Bank 連線失敗 (${RSA_KEY_API})：${rsaKeyRes.rtnMsg} (${rsaKeyRes.rtnCode})`
          : undefined,
      );
    }
    const publicKey = stringValue(rsaKeyRes.resBody.PublicKey).trim();

    const reqecKeyRes = await this.rawPost(REQEC_KEY_API, {});
    if (reqecKeyRes.rtnCode !== "0000") {
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(
            REQEC_KEY_API,
            reqecKeyRes.rtnCode,
            reqecKeyRes.rtnMsg,
          ),
        ),
      );
      throw new UbotConnectionError(
        reqecKeyRes.rtnMsg
          ? `聯邦 New New Bank 連線失敗 (${REQEC_KEY_API})：${reqecKeyRes.rtnMsg} (${reqecKeyRes.rtnCode})`
          : undefined,
      );
    }
    const k1 = stringValue(reqecKeyRes.resBody.k1).trim();
    const k2 = stringValue(reqecKeyRes.resBody.k2).trim();

    const miMa = encryptUbotPassword(credentials.password, publicKey);
    const sendData = {
      sid: formatUbotSid(credentials.userId),
      nickName: credentials.account,
      miMa,
      serial: "",
      deviceUuid,
      appVer: UBOT_APP_VERSION,
      deviceModel: UBOT_DEVICE_MODEL,
      deviceOSVer: UBOT_DEVICE_OS_VER,
    };
    const encryptedBody = encryptUbotRequest(sendData, k1, k2);
    const loginRes = await this.rawPost(LOGIN_API, encryptedBody, {
      allowHttpError: true,
    });

    // 帳密有誤時銀行可能以 HTTP 4xx 拒絕登入；停止排程交由使用者確認，
    // 避免以錯誤帳密反覆登入。
    if (loginRes.httpStatus >= 400) {
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(LOGIN_API, loginRes.rtnCode, loginRes.rtnMsg),
        ),
      );
      throw new UbotVerificationRequiredError(
        `聯邦 New New Bank 拒絕登入：${loginRes.rtnMsg || "未提供原因"} (${loginRes.rtnCode})。請確認身分證字號、使用者代號與使用者密碼後再同步。`,
      );
    }

    if (!LOGIN_ACCEPT_CODES.has(loginRes.rtnCode)) {
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(LOGIN_API, loginRes.rtnCode, loginRes.rtnMsg),
        ),
      );
      if (
        CREDENTIAL_ERROR_CODES.has(loginRes.rtnCode) ||
        loginRes.rtnMsg.includes("密碼") ||
        loginRes.rtnMsg.includes("代號") ||
        loginRes.rtnMsg.includes("使用者")
      ) {
        throw new UbotVerificationRequiredError(
          loginRes.rtnMsg
            ? `聯邦 New New Bank 登入失敗：${loginRes.rtnMsg} (${loginRes.rtnCode})`
            : "聯邦 New New Bank 登入失敗，請確認身分證字號、使用者代號與使用者密碼。",
        );
      }
      if (loginRes.rtnCode === "NS090") {
        throw new UbotVerificationRequiredError(
          "聯邦 New New Bank 要求先於官方 App 完成身分核驗後再同步。",
        );
      }
      throw new UbotConnectionError(
        loginRes.rtnMsg
          ? `聯邦 New New Bank 登入未完成：${loginRes.rtnMsg} (${loginRes.rtnCode})`
          : undefined,
      );
    }

    if (!this.ssid) {
      throw new UbotProtocolError(
        "聯邦 New New Bank 登入成功回應缺少 ssid，暫時無法同步。",
      );
    }
    this.loggedIn = true;

    const flagList = isRecord(loginRes.resBody.FlagList)
      ? loginRes.resBody.FlagList
      : {};
    if (
      stringValue(flagList.MissingUserFlag).trim() === "2" ||
      stringValue(flagList.KycFlag).trim().toUpperCase() === "Y"
    ) {
      throw new UbotVerificationRequiredError(
        "聯邦 New New Bank 要求先於官方 App 完成基本資料更新或 KYC 審查。",
      );
    }
  }

  async postRequired(
    apiName: string,
    body: Record<string, unknown>,
  ): Promise<JsonRecord> {
    if (!this.ssid) {
      throw new UbotVerificationRequiredError(
        "聯邦 New New Bank 登入狀態已失效，請重新同步。",
      );
    }
    const envelope = await this.rawPost(apiName, body);
    if (envelope.rtnCode !== "0000") {
      if (SESSION_EXPIRED_CODES.has(envelope.rtnCode)) {
        throw new UbotVerificationRequiredError(
          "聯邦 New New Bank 登入狀態已失效，請重新同步。",
        );
      }
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(apiName, envelope.rtnCode, envelope.rtnMsg),
        ),
      );
      throw new UbotConnectionError(
        envelope.rtnMsg
          ? `聯邦 New New Bank 查詢失敗 (${apiName})：${envelope.rtnMsg} (${envelope.rtnCode})`
          : undefined,
      );
    }
    return envelope.resBody;
  }

  async postOptional(
    apiName: string,
    body: Record<string, unknown>,
    emptyCodes: readonly string[] = [],
    suppressNonZeroCode = false,
  ): Promise<JsonRecord | undefined> {
    if (!this.ssid) return undefined;
    try {
      const envelope = await this.rawPost(apiName, body);
      if (envelope.rtnCode === "0000") {
        return envelope.resBody;
      }
      if (emptyCodes.includes(envelope.rtnCode) || suppressNonZeroCode) {
        return undefined;
      }
      if (SESSION_EXPIRED_CODES.has(envelope.rtnCode)) {
        throw new UbotVerificationRequiredError(
          "聯邦 New New Bank 登入狀態已失效，請重新同步。",
        );
      }
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(apiName, envelope.rtnCode, envelope.rtnMsg),
        ),
      );
      return undefined;
    } catch (error) {
      if (error instanceof UbotVerificationRequiredError) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          event: "ubot_optional_endpoint_failed",
          endpoint: apiName,
        }),
      );
      return undefined;
    }
  }

  async fetchTwdTransactions(
    beginDate: string,
    endDate: string,
    depth = 0,
  ): Promise<unknown[]> {
    const envelope = await this.rawPost(TWD_TX_API, { beginDate, endDate });
    if (envelope.rtnCode !== "0000") {
      if (SESSION_EXPIRED_CODES.has(envelope.rtnCode)) {
        throw new UbotVerificationRequiredError(
          "聯邦 New New Bank 登入狀態已失效，請重新同步。",
        );
      }
      if (envelope.rtnMsg.includes("查無")) {
        return [];
      }
      console.warn(
        JSON.stringify(
          buildUbotApiDiagnostic(TWD_TX_API, envelope.rtnCode, envelope.rtnMsg),
        ),
      );
      throw new UbotConnectionError();
    }

    const warnCode = stringValue(envelope.resBody.WarnCode).trim();
    if (
      warnCode === "MFOB" &&
      beginDate < endDate &&
      depth < MAX_TX_SPLIT_DEPTH
    ) {
      const split = splitCompactDateRange(beginDate, endDate);
      if (split) {
        const firstHalf = await this.fetchTwdTransactions(
          split.firstBegin,
          split.firstEnd,
          depth + 1,
        );
        const secondHalf = await this.fetchTwdTransactions(
          split.secondBegin,
          split.secondEnd,
          depth + 1,
        );
        return [...firstHalf, ...secondHalf];
      }
    }

    return Array.isArray(envelope.resBody.Details)
      ? envelope.resBody.Details
      : [];
  }

  async logout() {
    if (!this.loggedIn || !this.ssid) return;
    try {
      await this.rawPost(LOGOUT_API, {});
    } catch {
      // 登出失敗不覆蓋已完成的唯讀同步結果。
    } finally {
      this.ssid = "";
      this.loggedIn = false;
      this.cookies.clear();
    }
  }

  private async rawPost(
    apiName: string,
    body: Record<string, unknown>,
    options: { allowHttpError?: boolean } = {},
  ): Promise<{
    httpStatus: number;
    rtnCode: string;
    rtnMsg: string;
    resBody: JsonRecord;
  }> {
    const path = `${SVC_PREFIX}${apiName}`;
    const url = new URL(path, UBOT_ORIGIN);
    if (url.origin !== UBOT_ORIGIN || url.pathname !== path) {
      throw new UbotConnectionError();
    }

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 15; google-husky Build/AP3A.241005.015) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      Origin: UBOT_ORIGIN,
      Referer: UBOT_REFERER,
    };
    if (this.ssid) {
      headers.Authorization = this.ssid;
    }
    const cookieHeader = Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });

      this.captureResponseHeaders(response.headers);

      if (response.status >= 300 && response.status < 400) {
        throw new UbotConnectionError(
          `聯邦 New New Bank 回傳轉址 HTTP ${response.status}。`,
        );
      }
      const payload = await readLimitedJson(response);
      const envelope = isRecord(payload)
        ? readUbotEnvelope(payload)
        : undefined;
      if (!response.ok) {
        // 登入請求的含碼 4xx（含 401／403）交由登入流程顯示銀行代碼與確認帳密提示。
        if (
          options.allowHttpError &&
          response.status < 500 &&
          envelope?.rtnCode
        ) {
          return { httpStatus: response.status, ...envelope };
        }
        if (response.status === 401 || response.status === 403) {
          throw new UbotVerificationRequiredError(
            "聯邦 New New Bank 登入狀態已失效，請重新同步。",
          );
        }
        throw new UbotConnectionError(
          envelope?.rtnCode
            ? `聯邦 New New Bank 伺服器錯誤 HTTP ${response.status} (${apiName})：${envelope.rtnMsg} (${envelope.rtnCode})。`
            : `聯邦 New New Bank 伺服器錯誤 HTTP ${response.status} (${apiName})。`,
        );
      }
      if (!envelope) {
        throw new UbotProtocolError();
      }
      return { httpStatus: response.status, ...envelope };
    } catch (error) {
      if (
        error instanceof UbotVerificationRequiredError ||
        error instanceof UbotConnectionError ||
        error instanceof UbotProtocolError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new UbotConnectionError(
        `聯邦 New New Bank 連線失敗 (${apiName})：${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private captureResponseHeaders(headers: Headers) {
    const nextSsid = headers.get("ssid")?.trim();
    if (nextSsid) {
      this.ssid = nextSsid;
    }
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")!]
          : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0]?.trim();
      if (!pair) continue;
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (name) {
        this.cookies.set(name, value);
      }
    }
  }
}

function readUbotEnvelope(payload: JsonRecord) {
  const resCode = isRecord(payload.ResCode) ? payload.ResCode : {};
  return {
    rtnCode: (
      stringValue(resCode.RtnCode) || stringValue(payload.RtnCode)
    ).trim(),
    rtnMsg: (
      stringValue(resCode.RtnDesc) ||
      stringValue(resCode.RtnMsg) ||
      stringValue(payload.RtnMsg) ||
      stringValue(payload.RtnDesc)
    ).trim(),
    resBody: isRecord(payload.ResBody) ? payload.ResBody : {},
  };
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new UbotConnectionError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UbotConnectionError();
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
    throw new UbotProtocolError();
  } finally {
    bytes.fill(0);
  }
}

function transactionDateRange(now: Date) {
  const end = new Date(now);
  const start = new Date(now);
  start.setMonth(start.getMonth() - BANK_SYNC_MONTHS);
  return {
    beginDate: formatCompactDate(start),
    endDate: formatCompactDate(end),
  };
}

function formatCompactDate(value: Date): string {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("");
}

function parseCompactDate(value: string): Date | undefined {
  if (!/^\d{8}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

function formatUtcCompactDate(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function splitCompactDateRange(
  beginDate: string,
  endDate: string,
):
  | {
      firstBegin: string;
      firstEnd: string;
      secondBegin: string;
      secondEnd: string;
    }
  | undefined {
  const start = parseCompactDate(beginDate);
  const end = parseCompactDate(endDate);
  if (!start || !end) return undefined;
  const diffDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays < 1) return undefined;
  const midDays = Math.floor(diffDays / 2);
  const firstEnd = new Date(start.getTime() + midDays * 86_400_000);
  const secondBegin = new Date(firstEnd.getTime() + 86_400_000);
  return {
    firstBegin: beginDate,
    firstEnd: formatUtcCompactDate(firstEnd),
    secondBegin: formatUtcCompactDate(secondBegin),
    secondEnd: endDate,
  };
}

function normalizeDeviceUuid(value: unknown): string | undefined {
  const text = stringValue(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : undefined;
}

function deviceUuidFromCursor(cursor?: string): string | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (!isRecord(parsed)) return undefined;
    return normalizeDeviceUuid(parsed.deviceUuid);
  } catch {
    return undefined;
  }
}

function safeReturnCode(value: unknown): string {
  const code = stringValue(value).trim();
  return /^[A-Za-z0-9_-]{1,20}$/.test(code) ? code : "UNKNOWN";
}

function safeProviderMessage(value: unknown): string {
  return stringValue(value)
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(
      /\b(authorization|cookie|password|passwd|token|secret|ssid)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b[A-Z][12]\d{8}[A-Z]?\b/gi, "[redacted]")
    .replace(/\d(?:[\s-]*\d){4,}/g, (matched) => {
      const digits = matched.replace(/\D/g, "");
      return `••••${digits.slice(-4)}`;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
