export type ConnectorConnectionMode =
  | "api_credentials"
  | "api_captcha_session"
  | "api_device_otp"
  | "browser_per_sync"
  | "browser_session"
  | "browser_captcha_session";

export type ConnectorCapability =
  | "invoice"
  | "invoice_line_item"
  | "bank_account"
  | "bank_balance_snapshot"
  | "bank_transaction"
  | "credit_card_bill"
  | "loan"
  | "investment_position"
  | "investment_transaction"
  | "net_worth_history";

/** 前端設定表單使用的帳密欄位；`key` 同時是 Worker 解析設定時的欄位名稱。 */
export interface ConnectorCredentialField {
  key: string;
  label: string;
  type: "text" | "password";
}

export interface ConnectorCatalogEntry {
  id: string;
  title: string;
  /**
   * 直接提供自家存款帳戶的銀行代碼：用於資產依銀行分組，以及集保交割帳戶等其他來源的帳戶連結。
   * 設定後 Worker 必須註冊該來源的存款 sourceId 解析；非銀行或未接入存款比對的來源為 `null`。
   */
  bankCode: string | null;
  connectionMode: ConnectorConnectionMode;
  scopes: readonly string[];
  /** 前端依此產生來源的支援範圍標籤（例如「存款・信用卡・貸款」），須與實際寫入的資料一致。 */
  capabilities: readonly ConnectorCapability[];
  publicFields: readonly string[];
  credentialFields: readonly ConnectorCredentialField[];
  secretStateFields: readonly string[];
  resetOnCredentialChangeFields: readonly string[];
}

/**
 * 宣告順序即前端顯示順序：依資料來源加入的時間排列，新增的 connector 一律加在最後。
 */
export const connectorCatalog = {
  einvoice: {
    id: "einvoice",
    title: "電子發票",
    bankCode: null,
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: ["invoice", "invoice_line_item"],
    publicFields: [],
    credentialFields: [
      { key: "mobile", label: "手機號碼（電子發票帳號）", type: "text" },
      { key: "password", label: "電子發票 App 登入密碼", type: "password" },
    ],
    secretStateFields: [
      "userToken",
      "mobileBarcode",
      "sid",
      "token",
      "iv",
      "svrCode",
      "loginAppId",
      "loginLiat",
      "loginSsMe",
      "ltoken",
      "hkey",
      "serverTimeOffset",
    ],
    resetOnCredentialChangeFields: [
      "userToken",
      "mobileBarcode",
      "sid",
      "token",
      "iv",
      "svrCode",
      "loginAppId",
      "loginLiat",
      "loginSsMe",
      "ltoken",
      "hkey",
      "serverTimeOffset",
    ],
  },
  tdcc: {
    id: "tdcc",
    title: "集保 e 存摺",
    bankCode: null,
    connectionMode: "api_device_otp",
    scopes: ["all", "investments", "bank", "trades"],
    capabilities: [
      "investment_position",
      "investment_transaction",
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "net_worth_history",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "password", label: "集保 App 密碼", type: "password" },
    ],
    secretStateFields: ["deviceId", "devType", "devModel", "session"],
    resetOnCredentialChangeFields: [
      "deviceId",
      "devType",
      "devModel",
      "session",
      "otp",
      "otpChannel",
    ],
  },
  esun: {
    id: "esun",
    title: "玉山銀行",
    bankCode: "808",
    connectionMode: "browser_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "使用者名稱", type: "text" },
      { key: "password", label: "使用者密碼", type: "password" },
    ],
    secretStateFields: ["sessionCookies", "sessionExpiresAt"],
    resetOnCredentialChangeFields: ["sessionCookies", "sessionExpiresAt"],
  },
  cathaybk: {
    id: "cathaybk",
    title: "國泰世華銀行",
    bankCode: "013",
    connectionMode: "browser_per_sync",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
      "loan",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "用戶代號", type: "text" },
      { key: "password", label: "網銀密碼", type: "password" },
    ],
    secretStateFields: [
      "sessionCookies",
      "sessionExpiresAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "otpChannel",
    ],
    resetOnCredentialChangeFields: [
      "sessionCookies",
      "sessionExpiresAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "otp",
      "otpChannel",
    ],
  },
  sinopac: {
    id: "sinopac",
    title: "永豐行動銀行",
    bankCode: "807",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
      "loan",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "行動／網路銀行使用者代碼", type: "text" },
      { key: "password", label: "網路密碼", type: "password" },
    ],
    secretStateFields: ["sessionCookies", "browserSessionId", "captcha"],
    resetOnCredentialChangeFields: [
      "sessionCookies",
      "candidateSessionCookies",
      "candidateSessionCreatedAt",
      "sessionExpiresAt",
      "sessionKeepAliveFailures",
      "browserSessionId",
      "browserSessionExpiresAt",
      "captcha",
      "protocol",
    ],
  },
  taishin: {
    id: "taishin",
    title: "台新銀行",
    bankCode: "812",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "使用者密碼", type: "password" },
    ],
    secretStateFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "captcha",
    ],
    resetOnCredentialChangeFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
  },
  ctbc: {
    id: "ctbc",
    title: "中國信託銀行",
    bankCode: "822",
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "網路密碼", type: "password" },
    ],
    secretStateFields: ["deviceCode", "deviceSeed", "pendingSession"],
    // A password change ends the pending login, but keeps the same device.
    // Switching customer/account identity also resets deviceCode/deviceSeed.
    resetOnCredentialChangeFields: ["pendingSession"],
  },
  obank: {
    id: "obank",
    title: "王道銀行",
    bankCode: "048",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "網路銀行密碼", type: "password" },
    ],
    secretStateFields: ["pendingSession", "pendingSessionExpiresAt", "captcha"],
    resetOnCredentialChangeFields: [
      "pendingSession",
      "pendingSessionExpiresAt",
      "captcha",
    ],
  },
  hncb: {
    id: "hncb",
    title: "華南銀行",
    bankCode: "008",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "網路銀行密碼", type: "password" },
    ],
    secretStateFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "captcha",
    ],
    resetOnCredentialChangeFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
  },
  skbank: {
    id: "skbank",
    title: "新光銀行",
    bankCode: "103",
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "nationalId", label: "身分證字號／統編", type: "text" },
      { key: "alias", label: "網銀使用者代號", type: "text" },
      { key: "password", label: "網銀密碼", type: "password" },
    ],
    secretStateFields: ["deviceId"],
    resetOnCredentialChangeFields: ["deviceId"],
  },
  firstbank: {
    id: "firstbank",
    title: "第一銀行",
    bankCode: "007",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／統編", type: "text" },
      { key: "account", label: "登入代號", type: "text" },
      { key: "password", label: "網路銀行密碼", type: "password" },
    ],
    secretStateFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
    resetOnCredentialChangeFields: [
      "sessionCookies",
      "sessionCreatedAt",
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
  },
  kgibank: {
    id: "kgibank",
    title: "凱基銀行",
    bankCode: "809",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "網路銀行密碼", type: "password" },
    ],
    secretStateFields: ["browserSessionId", "captcha"],
    resetOnCredentialChangeFields: [
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
  },
  megabank: {
    id: "megabank",
    title: "兆豐銀行",
    bankCode: "017",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
      "loan",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號／居留證號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "行動銀行登入密碼", type: "password" },
    ],
    secretStateFields: [
      "pendingSession",
      "pendingSessionExpiresAt",
      "captcha",
      "otp",
      "deviceCode",
      "deviceUKey",
      "deviceSeed",
    ],
    resetOnCredentialChangeFields: [
      "pendingSession",
      "pendingSessionExpiresAt",
      "captcha",
      "otp",
      "deviceCode",
      "deviceUKey",
      "deviceSeed",
    ],
  },
  nextbank: {
    id: "nextbank",
    title: "將來銀行",
    bankCode: null,
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "使用者密碼", type: "password" },
    ],
    secretStateFields: ["captchaUuid", "captchaExpiresAt"],
    resetOnCredentialChangeFields: ["captchaUuid", "captchaExpiresAt"],
  },
  rakuten: {
    id: "rakuten",
    title: "樂天國際銀行",
    bankCode: "826",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "loan",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "登入密碼", type: "password" },
    ],
    secretStateFields: [
      "browserSessionId",
      "browserSessionExpiresAt",
      "captcha",
    ],
    resetOnCredentialChangeFields: [
      "browserSessionId",
      "browserSessionExpiresAt",
      "captcha",
    ],
  },
  fubon: {
    id: "fubon",
    title: "台北富邦銀行",
    bankCode: "012",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代碼", type: "text" },
      { key: "password", label: "使用者密碼", type: "password" },
    ],
    secretStateFields: [
      "browserSessionId",
      "captcha",
      "otpBrowserSessionId",
      "otp",
    ],
    resetOnCredentialChangeFields: [
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
      "otpBrowserSessionId",
      "otpExpiresAt",
      "otp",
    ],
  },
  feib: {
    id: "feib",
    title: "遠東商銀",
    bankCode: "805",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "密碼", type: "password" },
    ],
    secretStateFields: ["browserSessionId", "captcha"],
    resetOnCredentialChangeFields: [
      "browserSessionId",
      "browserSessionExpiresAt",
      "captchaDigitCount",
      "captcha",
    ],
  },
  ubot: {
    id: "ubot",
    title: "聯邦 New New Bank",
    bankCode: "803",
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
      "loan",
    ],
    publicFields: [],
    credentialFields: [
      { key: "userId", label: "身分證字號", type: "text" },
      { key: "account", label: "使用者代號", type: "text" },
      { key: "password", label: "使用者密碼", type: "password" },
    ],
    secretStateFields: ["deviceUuid"],
    resetOnCredentialChangeFields: ["deviceUuid"],
  },
  binance: {
    id: "binance",
    title: "Binance",
    bankCode: null,
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: ["investment_position", "net_worth_history"],
    publicFields: [],
    credentialFields: [
      {
        key: "apiKey",
        label: "API Key（僅開啟讀取權限）",
        type: "text",
      },
      { key: "apiSecret", label: "Secret Key", type: "password" },
    ],
    secretStateFields: [],
    resetOnCredentialChangeFields: [],
  },
  max: {
    id: "max",
    title: "MAX 交易所",
    bankCode: null,
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: ["investment_position", "net_worth_history"],
    publicFields: [],
    credentialFields: [
      {
        key: "accessKey",
        label: "Access Key（僅開啟讀取權限）",
        type: "text",
      },
      { key: "secretKey", label: "Secret Key", type: "password" },
    ],
    secretStateFields: [],
    resetOnCredentialChangeFields: [],
  },
} as const satisfies Record<string, ConnectorCatalogEntry>;

export type ConnectorId = keyof typeof connectorCatalog;

export type ConnectorFormFieldKey<TConnectorId extends ConnectorId> =
  | (typeof connectorCatalog)[TConnectorId]["credentialFields"][number]["key"]
  | (typeof connectorCatalog)[TConnectorId]["publicFields"][number];

/** 依 catalog 宣告順序排列的資料來源清單，供前端直接列出。 */
export const connectorList = Object.values(connectorCatalog);

const connectorOrder = new Map<string, number>(
  connectorList.map((connector, index) => [connector.id, index]),
);

/** 依 catalog 宣告順序比較兩個資料來源，用於排序 API 回傳的來源清單。 */
export function compareConnectorOrder(left: ConnectorId, right: ConnectorId) {
  return connectorOrder.get(left)! - connectorOrder.get(right)!;
}

export function isConnectorId(value: string): value is ConnectorId {
  return Object.hasOwn(connectorCatalog, value);
}

/** 資料來源的直接存款銀行代碼；未知來源或沒有宣告時回傳 `null`。 */
export function connectorBankCode(connectorId: string): string | null {
  return isConnectorId(connectorId)
    ? connectorCatalog[connectorId].bankCode
    : null;
}
