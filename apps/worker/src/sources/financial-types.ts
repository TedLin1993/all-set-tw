import type { BankTransactionStatus } from "@taiwan-fin-hub/shared";

/**
 * Connector 正規化後、寫入 D1 前的金融資料型別；僅供 Worker 與各來源使用。
 * 對前端公開的 response 契約另見 `shared/`。
 */
export interface NetWorthHistoryPoint {
  date: string; // YYYY-MM-DD
  netWorth: number;
  assetType?: "total" | "stock" | "fund" | "crypto";
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

export interface Invoice {
  id: string;
  connectorId: string;
  sourceId: string;
  invoiceNumber?: string;
  /** YYYY-MM-DD when time is unknown; otherwise an ISO timestamp with timezone. */
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

export type AssetType = "stock" | "etf" | "fund" | "crypto";

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
  assetType?: "stock" | "etf" | "fund" | "bond" | "unknown";
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
  loanCategory?: "housing" | "personal" | "other";
  loanInterestRate?: number;
  currency: string;
  openedDate?: string;
  maturityDate?: string;
  inactiveAt?: string;
  creditLimit?: number;
  /**
   * 銀行頁面揭露的自動扣繳帳戶（信用卡／貸款）。undefined 表示本次未取得，
   * 保留既有資料；null 表示銀行明確顯示未設定自動扣繳。
   */
  autopayAccount?: AutopayAccountHint | null;
  raw?: unknown;
}

/** 只保存銀行代碼、末四碼與可對應的存款 sourceId；不得放入完整帳號。 */
export interface AutopayAccountHint {
  bankCode?: string;
  last4?: string;
  /** 來源能以完整帳號算出自家存款帳戶 sourceId 時填入，用於精準對應。 */
  depositSourceId?: string;
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
  loanPaymentAmount?: number;
  loanPaymentStatus?: "scheduled" | "collection_incomplete";
  loanInstallmentsPaid?: number;
  loanInstallmentsTotal?: number;
  currency: string;
  asOfAt: string;
  raw?: unknown;
}

export interface BankTransaction {
  transferPeer?: { accountId: string; sourceId: string };
  id: string;
  connectorId: string;
  accountId: string;
  sourceId: string;
  postedDate?: string;
  /** Transaction/authorization date, with a timezone only when source time is known. */
  authorizedAt?: string;
  amount: number;
  currency: string;
  description?: string;
  counterparty?: string;
  status?: BankTransactionStatus;
  /** Physical card in a shared credit account; display only, never identity. */
  cardLast4?: string;
  /** Set only when the connector can map cardLast4 to exactly one named card. */
  cardName?: string;
  raw?: unknown;
}
