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

export interface ConnectorCatalogEntry {
  id: string;
  title: string;
  description: string;
  connectionMode: ConnectorConnectionMode;
  scopes: readonly string[];
  capabilities: readonly ConnectorCapability[];
  publicFields: readonly string[];
  credentialFields: readonly string[];
  secretStateFields: readonly string[];
  resetOnCredentialChangeFields: readonly string[];
}

export const connectorCatalog = {
  einvoice: {
    id: "einvoice",
    title: "電子發票",
    description: "財政部載具與品項明細",
    connectionMode: "api_credentials",
    scopes: ["all"],
    capabilities: ["invoice", "invoice_line_item"],
    publicFields: [],
    credentialFields: ["mobile", "password"],
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
    credentialFields: ["userId", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
    secretStateFields: [],
    resetOnCredentialChangeFields: [],
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
    credentialFields: ["nationalId", "alias", "password"],
    secretStateFields: ["deviceId"],
    resetOnCredentialChangeFields: ["deviceId"],
  },
  nextbank: {
    id: "nextbank",
    title: "將來銀行",
    description: "存款、口袋餘額與交易明細（投資尚未接入）",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: ["userId", "account", "password"],
    secretStateFields: ["captchaUuid", "captchaExpiresAt"],
    resetOnCredentialChangeFields: ["captchaUuid", "captchaExpiresAt"],
  },
  obank: {
    id: "obank",
    title: "王道銀行",
    description: "活存、定存、餘額與交易明細",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
    credentialFields: ["userId", "account", "password"],
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
  rakuten: {
    id: "rakuten",
    title: "樂天國際銀行",
    description: "臺幣活存帳戶、每日餘額與交易明細",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: ["userId", "account", "password"],
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
  kgibank: {
    id: "kgibank",
    title: "凱基銀行",
    description: "臺幣活存帳戶、餘額與交易明細",
    connectionMode: "browser_captcha_session",
    scopes: ["all"],
    capabilities: ["bank_account", "bank_balance_snapshot", "bank_transaction"],
    publicFields: [],
    credentialFields: ["userId", "account", "password"],
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
    description: "存款帳戶、餘額與交易明細；信用卡帳單與消費",
    connectionMode: "api_captcha_session",
    scopes: ["all"],
    capabilities: [
      "bank_account",
      "bank_balance_snapshot",
      "bank_transaction",
      "credit_card_bill",
    ],
    publicFields: [],
    credentialFields: ["userId", "account", "password"],
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
} as const satisfies Record<string, ConnectorCatalogEntry>;

export type ConnectorId = keyof typeof connectorCatalog;

export type ConnectorFormFieldKey<TConnectorId extends ConnectorId> =
  | (typeof connectorCatalog)[TConnectorId]["credentialFields"][number]
  | (typeof connectorCatalog)[TConnectorId]["publicFields"][number];

export function isConnectorId(value: string): value is ConnectorId {
  return Object.hasOwn(connectorCatalog, value);
}
