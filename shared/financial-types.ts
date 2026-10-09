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
  loanCategory?: "housing" | "other";
  loanInterestRate?: number;
  currency: string;
  openedDate?: string;
  maturityDate?: string;
  inactiveAt?: string;
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
  loanPaymentAmount?: number;
  loanPaymentStatus?: "scheduled" | "collection_incomplete";
  loanInstallmentsPaid?: number;
  loanInstallmentsTotal?: number;
  currency: string;
  asOfAt: string;
  raw?: unknown;
}

export type BankTransactionStatus = "pending" | "posted";

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
  raw?: unknown;
}
