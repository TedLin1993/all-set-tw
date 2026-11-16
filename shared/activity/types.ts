export interface ActivityItem {
  id: string;
  source: "bank" | "card" | "investment" | "invoice";
  date: string;
  /** Only true when the selected source value contains a reliable timestamp. */
  dateHasTime?: boolean;
  title: string;
  subtitle: string;
  searchText?: string;
  institutionName?: string;
  accountName?: string;
  amount?: number;
  currency: string;
  category: string;
  categoryId?: string;
  classificationPattern?: string;
  classificationSource?:
    | "override"
    | "user_rule"
    | "system_rule"
    | "auto_transfer"
    | "auto_offset"
    | "auto_refund"
    | "ai"
    | "fallback";
  classificationRuleId?: string;
  transactionId?: string;
  /** 手動記錄的現金收支，可由使用者刪除。 */
  manual?: boolean;
  /** 使用者為銀行／信用卡交易寫的備註。 */
  note?: string;
  excludedFromCalculation?: boolean;
  /** A merchant refund that reduces its category's expense. */
  refund?: boolean;
  invoiceId?: string;
  invoiceAmount?: number;
  status: string;
}
