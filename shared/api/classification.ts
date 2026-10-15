/** 使用者可建立的分類規則比對欄位。 */
export const CLASSIFICATION_RULE_FIELDS = [
  "any_text",
  "description",
  "counterparty",
  "source_id",
] as const;

export type ClassificationRuleField =
  (typeof CLASSIFICATION_RULE_FIELDS)[number];

/** 使用者可建立或修改的分類規則比對方式。 */
export const CLASSIFICATION_RULE_OPERATORS = [
  "contains",
  "equals",
  "starts_with",
  "regex",
] as const;

export type ClassificationRuleOperator =
  (typeof CLASSIFICATION_RULE_OPERATORS)[number];

/**
 * `GET /api/classification/rules` 的規則回應。資料庫以文字保存 field／operator，
 * 回應維持 string；寫入時才以上方清單驗證。
 */
export interface ClassificationRuleResponse {
  id: string;
  categoryId: string;
  targetType: string | null;
  field: string;
  operator: string;
  pattern: string;
  priority: number;
  enabled: boolean;
  isSystem: boolean;
  source: string;
  description: string | null;
  excludedFromCalculation: boolean;
}

export interface ClassificationCategoryResponse {
  id: string;
  label: string;
  sortOrder: number;
  isSystem: boolean;
}
