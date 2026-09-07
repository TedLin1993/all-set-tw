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
    | "fallback";
  classificationRuleId?: string;
  transactionId?: string;
  excludedFromCalculation?: boolean;
  invoiceId?: string;
  invoiceAmount?: number;
  status: string;
}
