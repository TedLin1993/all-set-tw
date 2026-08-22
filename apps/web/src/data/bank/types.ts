import type { ConnectorId } from "@taiwan-fin-hub/core";

export interface BankAccountRow {
  id: string;
  connectorId: ConnectorId;
  sourceId: string;
  institutionName?: string;
  accountName?: string;
  accountType?: string;
  currency: string;
  bankCode?: string;
  accountLast4?: string;
  balance?: number;
  availableBalance?: number;
  paymentDueDate?: string;
  statementClosingDate?: string;
  asOfAt?: string;
}

export interface BankTransactionRow {
  id: string;
  connectorId: ConnectorId;
  accountId: string;
  accountSourceId?: string;
  accountName?: string;
  institutionName?: string;
  accountType?: string;
  bankCode?: string;
  accountLast4?: string;
  sourceId: string;
  postedDate?: string;
  authorizedAt?: string;
  amount: number;
  currency: string;
  description?: string;
  counterparty?: string;
  status: "pending" | "posted";
  excludedFromCalculation: boolean;
  classification?: {
    categoryId: string;
    label: string;
    source:
      "override" | "user_rule" | "system_rule" | "auto_transfer" | "fallback";
    ruleId?: string;
    excludedFromCalculation?: boolean;
  };
}

export interface CreditCardBillRow {
  id: string;
  connectorId: ConnectorId;
  accountId: string;
  accountSourceId?: string;
  sourceId: string;
  billingPeriod: string;
  statementAmount?: number;
  minimumPayment?: number;
  paidAmount?: number;
  isPaid?: number;
  paymentDueDate?: string;
  statementClosingDate?: string;
  currency: string;
}

export interface BankData {
  accounts: BankAccountRow[];
  transactions: BankTransactionRow[];
}
