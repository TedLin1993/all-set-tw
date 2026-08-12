export interface NetWorthHistoryPoint {
  date: string; // YYYY-MM-DD
  netWorth: number;
  assetType?: "total" | "stock" | "fund";
}

export interface CreditCardBill {
  id: string;
  connectorId: string;
  accountId: string;
  sourceId: string;
  billingPeriod: string; // "2026-05"
  statementAmount?: number;
  minimumPayment?: number;
  paidAmount?: number;
  isPaid?: boolean;
  paymentDueDate?: string;
  statementClosingDate?: string;
  currency: string;
  raw?: unknown;
}

export interface SyncResult<TResult> {
  records: TResult[];
  cursor?: string;
  invoiceLineItems?: Array<
    Omit<InvoiceLineItem, "id" | "connectorId" | "invoiceId">
  >;
  bankAccounts?: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots?: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions?: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills?: Array<Omit<CreditCardBill, "id" | "connectorId">>;
  investmentTransactions?: Array<
    Omit<InvestmentTransaction, "id" | "connectorId">
  >;
  netWorthHistory?: NetWorthHistoryPoint[];
}

export interface Connector<TConfig, TResult> {
  id: ConnectorId;
  name: string;
  sync(config: TConfig, cursor?: string): Promise<SyncResult<TResult>>;
}

export interface Invoice {
  id: string;
  connectorId: string;
  sourceId: string;
  invoiceNumber?: string;
  invoiceDate: string;
  sellerName?: string;
  amount: number;
  raw?: unknown;
}

export interface InvoiceLineItem {
  id: string;
  connectorId: string;
  invoiceId: string;
  invoiceSourceId: string;
  sourceId: string;
  lineNumber: number;
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
  raw?: unknown;
}

export type AssetType = "stock" | "etf" | "fund";

export interface InvestmentPosition {
  id: string;
  connectorId: string;
  sourceId: string;
  assetType: AssetType;
  symbol?: string;
  name: string;
  quantity?: number;
  marketValue?: number;
  cashBalance?: number;
  currency: string;
  asOfDate: string;
  raw?: unknown;
}

export interface InvestmentTransaction {
  id: string;
  connectorId: string;
  accountId: string;
  sourceId: string;
  brokerNo?: string;
  brokerAccount?: string;
  brokerName?: string;
  symbol?: string;
  name?: string;
  assetType?: AssetType | "bond" | "unknown";
  tradeDate?: string;
  postedDate?: string;
  transactionCode?: string;
  transactionName?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  currency: string;
  raw?: unknown;
}

export type BankAccountType =
  | "checking"
  | "savings"
  | "credit"
  | "loan"
  | "settlement_cash"
  | "time_deposit"
  | "stored_value"
  | "unknown";

export interface BankAccount {
  id: string;
  connectorId: string;
  sourceId: string;
  institutionName?: string;
  accountName?: string;
  accountType?: BankAccountType;
  currency: string;
  creditLimit?: number;
  raw?: unknown;
}

export interface BankBalanceSnapshot {
  id: string;
  connectorId: string;
  accountId: string;
  sourceId: string;
  balance: number;
  availableBalance?: number;
  statementBalance?: number;
  paymentDueDate?: string;
  statementClosingDate?: string;
  noPaymentNeeded?: boolean;
  currency: string;
  asOfAt: string;
  raw?: unknown;
}

export type BankTransactionStatus = "pending" | "posted";

export interface BankTransaction {
  id: string;
  connectorId: string;
  accountId: string;
  sourceId: string;
  postedDate?: string;
  authorizedAt?: string;
  amount: number;
  currency: string;
  description?: string;
  counterparty?: string;
  status?: BankTransactionStatus;
  raw?: unknown;
}

export interface Summary {
  invoiceCount: number;
  investmentCount: number;
  totalInvestmentValue: number;
  bankAccountCount: number;
  totalBankBalance: number;
}

export interface ConnectorSettingsMetadata {
  connectorId: string;
  configured: boolean;
  updatedAt?: string;
  publicConfig?: Record<string, unknown> | null;
}

export interface SyncResponse {
  success: true;
  connectorId: ConnectorId;
  scope: string;
  records: number;
  newRecords: SyncNewRecordCounts;
  detailRecords?: number;
  cursorUpdated: boolean;
}

export type SyncNotificationStatus = "success" | "failed" | "needs_user_action";

export interface SyncNewRecordCounts {
  invoices: number;
  bankTransactions: number;
  investmentTransactions: number;
}

export interface ScheduledSyncSourceReport {
  connectorId: ConnectorId;
  status: SyncNotificationStatus;
  completedAt: string;
  newRecords: SyncNewRecordCounts;
}

export type SyncFinancialChangeUnavailableReason =
  "baseline" | "partial_sync" | "snapshot_unavailable";

export interface ScheduledSyncReport {
  id: string;
  startedAt: string;
  completedAt: string;
  status: SyncNotificationStatus;
  sources: ScheduledSyncSourceReport[];
  sourceSummary: {
    total: number;
    success: number;
    failed: number;
    needsUserAction: number;
  };
  newRecords: SyncNewRecordCounts;
  financialChange: {
    assets: number;
    creditCardDebt: number;
    netWorth: number;
  } | null;
  financialChangeUnavailableReason: SyncFinancialChangeUnavailableReason | null;
  missingCurrencies: string[];
}

export interface NotificationPreferences {
  success: boolean;
  failed: boolean;
  needsUserAction: boolean;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NotificationConfig {
  enabled: boolean;
  publicKey: string | null;
  subscribedDevices: number;
  preferences: NotificationPreferences;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export const supportedConnectorIds = [
  "einvoice",
  "tdcc",
  "esun",
  "cathaybk",
  "sinopac",
  "taishin",
  "ctbc",
  "obank",
] as const;
export type ConnectorId = (typeof supportedConnectorIds)[number];

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
  id: ConnectorId;
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
    publicFields: ["fetchDetails"],
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
    secretStateFields: ["sessionCookies", "sessionExpiresAt"],
    resetOnCredentialChangeFields: ["sessionCookies", "sessionExpiresAt"],
  },
  sinopac: {
    id: "sinopac",
    title: "永豐行動銀行",
    description: "信用卡帳務、近期帳單與消費",
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
    description: "信用卡額度、帳單與即時消費",
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
} as const satisfies Record<ConnectorId, ConnectorCatalogEntry>;

export type ConnectorFormFieldKey<TConnectorId extends ConnectorId> =
  | (typeof connectorCatalog)[TConnectorId]["credentialFields"][number]
  | (typeof connectorCatalog)[TConnectorId]["publicFields"][number];

export function isConnectorId(value: string): value is ConnectorId {
  return supportedConnectorIds.includes(value as ConnectorId);
}
