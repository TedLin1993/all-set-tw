export interface ActivityItem {
  id: string;
  source: "bank" | "card" | "investment" | "invoice";
  date: string;
  title: string;
  subtitle: string;
  institutionName?: string;
  accountName?: string;
  amount?: number;
  currency: string;
  category: string;
  categoryId?: string;
  classificationPattern?: string;
  classificationSource?:
    "override" | "user_rule" | "system_rule" | "auto_transfer" | "fallback";
  classificationRuleId?: string;
  transactionId?: string;
  excludedFromCalculation?: boolean;
  invoiceId?: string;
  invoiceAmount?: number;
  status: string;
}

export interface PendingCategoryUpdate {
  item: ActivityItem;
  categoryId: string;
  addRule: boolean;
  pattern: string;
  operator: "contains" | "equals";
}

export interface CategoryUpdateInput {
  transactionId: string;
  categoryId: string;
  addRule: boolean;
  pattern: string;
  operator: "contains" | "equals";
}

export interface PendingCalculationUpdate {
  item: ActivityItem;
  categoryId: string;
  applyRule: boolean;
  pattern: string;
  operator: "contains" | "equals";
}

export interface CalculationUpdateInput {
  transactionId: string;
  categoryId: string;
  originalCategoryId: string;
  applyRule: boolean;
  ruleId?: string;
  pattern: string;
  operator: "contains" | "equals";
}
