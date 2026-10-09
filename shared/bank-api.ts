import type { BankTransactionStatus } from "./financial-types";

/** JSON returned by the bank API; nullable fields preserve the existing wire format. */
export interface BankAccountResponse {
  id: string;
  connectorId: string;
  sourceId: string;
  institutionName?: string | null;
  accountName?: string | null;
  accountType?: string | null;
  loanCategory?: "housing" | "other" | null;
  loanInterestRate?: number | null;
  currency: string;
  bankCode?: string | null;
  accountLast4?: string | null;
  balance?: number | null;
  availableBalance?: number | null;
  paymentDueDate?: string | null;
  statementClosingDate?: string | null;
  asOfAt?: string | null;
  openedDate?: string | null;
  maturityDate?: string | null;
  loanPaymentAmount?: number | null;
  loanPaymentStatus?: "scheduled" | "collection_incomplete" | null;
  loanInstallmentsPaid?: number | null;
  loanInstallmentsTotal?: number | null;
}

export interface BankTransactionResponse {
  id: string;
  connectorId: string;
  accountId: string;
  accountSourceId?: string | null;
  accountName?: string | null;
  institutionName?: string | null;
  accountType?: string | null;
  bankCode?: string | null;
  accountLast4?: string | null;
  sourceId: string;
  transferPeerId?: string | null;
  postedDate?: string | null;
  authorizedAt?: string | null;
  amount: number;
  currency: string;
  description?: string | null;
  counterparty?: string | null;
  status: BankTransactionStatus;
  calculationPreference?: number | null;
  excludedFromCalculation: boolean;
  classification?: {
    categoryId: string;
    label: string;
    source:
      | "override"
      | "user_rule"
      | "system_rule"
      | "auto_transfer"
      | "auto_offset"
      | "fallback";
    ruleId?: string;
    excludedFromCalculation?: boolean;
  };
}

export interface CreditCardBillResponse {
  id: string;
  connectorId: string;
  accountId: string;
  accountSourceId?: string | null;
  sourceId: string;
  billingPeriod: string;
  statementAmount?: number | null;
  minimumPayment?: number | null;
  paidAmount?: number | null;
  isPaid?: number | null;
  paymentDueDate?: string | null;
  statementClosingDate?: string | null;
  currency: string;
}

export interface BankDataResponse {
  accounts: BankAccountResponse[];
  transactions: BankTransactionResponse[];
}
