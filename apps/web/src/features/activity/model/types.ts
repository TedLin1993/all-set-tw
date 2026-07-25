export interface ActivityItem {
  id: string;
  source: "bank" | "card" | "investment" | "invoice";
  date: string;
  title: string;
  subtitle: string;
  amount?: number;
  currency: string;
  category: string;
  categoryId?: string;
  classificationPattern?: string;
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
