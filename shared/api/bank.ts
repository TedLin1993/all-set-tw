export type BankTransactionStatus = "pending" | "posted";

/** JSON returned by the bank API; nullable fields preserve the existing wire format. */
export interface BankAccountResponse {
  id: string;
  connectorId: string;
  sourceId: string;
  institutionName?: string | null;
  accountName?: string | null;
  accountType?: string | null;
  loanCategory?: "housing" | "personal" | "other" | null;
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
  /** 信用卡／貸款的扣款帳戶 ID；手動設定優先，其次為銀行提供且能唯一對應的存款帳戶。 */
  paymentAccountId?: string | null;
  /**
   * 扣款帳戶的來源；未設定時為 null。inferred 表示銀行未提供，
   * 依同銀行唯一的同幣別存款帳戶推測。
   */
  paymentAccountSource?: "manual" | "bank" | "inferred" | null;
  /**
   * 銀行頁面揭露的自動扣繳狀態；來源未提供時為 null。enabled 時附末四碼，
   * 以及唯一對應到的存款帳戶 ID（對不到時為 null，需手動指定）。
   */
  bankAutopay?: {
    status: "enabled" | "none";
    last4: string | null;
    accountId: string | null;
  } | null;
  /**
   * 信用卡帳戶近期交易出現過的實體卡，依最近使用排序；只供顯示，
   * 不代表完整的卡片清單（沒刷過的卡與不提供卡號的銀行不會出現）。
   */
  recentCards?: { last4: string; name: string | null }[];
}

/** `PUT /api/bank/accounts/:id/payment-account`；null 表示明確不指定扣款帳戶。 */
export interface PaymentAccountInput {
  paymentAccountId: string | null;
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
      | "auto_refund"
      | "ai"
      | "fallback";
    ruleId?: string;
    excludedFromCalculation?: boolean;
    /** A merchant refund that reduces its category's expense instead of counting as income. */
    refund?: boolean;
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
