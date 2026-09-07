import type { ActivityItem } from "@taiwan-fin-hub/core";
export type { ActivityItem } from "@taiwan-fin-hub/core";

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
