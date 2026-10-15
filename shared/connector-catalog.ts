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
  description: string;
  connectionMode: ConnectorConnectionMode;
  scopes: readonly string[];
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
    description: "財政部載具與品項明細",
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
    description: "持倉、投資交易與銀行帳戶",
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
    description: "帳戶、信用卡與交易",
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
    description: "帳戶、信用卡與交易",
    connectionMode: "browser_per_sync",
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
    description: "臺外幣活存帳戶、餘額與交易；信用卡帳務、帳單與消費",
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
    description: "臺外幣活存、交易、信用卡帳單與即時消費",
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
    description: "存款帳戶、信用卡與交易",
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
    description: "活存、定存、餘額與交易明細",
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
    description: "存款帳戶與餘額；信用卡帳單與刷卡明細",
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
    description: "臺外幣帳戶、餘額、交易明細與信用卡帳單",
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
    description: "存款帳戶、餘額與交易明細；信用卡帳單與刷卡明細",
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
    description: "臺幣活存帳戶、餘額與交易明細",
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
    description: "存款帳戶、餘額與交易明細；信用卡帳單與消費；貸款餘額與條件",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
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
    description: "存款、口袋餘額與交易明細（投資尚未接入）",
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
    description: "臺幣活存帳戶、每日餘額、交易明細與貸款餘額／條件",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
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
    description: "臺外幣活存帳戶、餘額與臺幣交易明細；信用卡帳單與消費",
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
