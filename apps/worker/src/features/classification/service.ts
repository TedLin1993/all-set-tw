export type ClassificationResult = {
  categoryId: string;
  label: string;
  source:
    "override" | "user_rule" | "system_rule" | "auto_transfer" | "fallback";
  ruleId?: string;
  excludedFromCalculation?: boolean;
};

export type ClassifiedTransaction = {
  id: string;
  description?: string | null;
  counterparty?: string | null;
  sourceId: string;
};

export function matchesClassificationRule(
  rule: { field: string; operator: string; pattern: string },
  transaction: ClassifiedTransaction,
) {
  const anyText = [
    transaction.description,
    transaction.counterparty,
    transaction.sourceId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const text =
    rule.field === "description"
      ? (transaction.description ?? "").toLowerCase()
      : rule.field === "counterparty"
        ? (transaction.counterparty ?? "").toLowerCase()
        : rule.field === "source_id"
          ? transaction.sourceId.toLowerCase()
          : anyText;

  if (rule.operator === "contains")
    return text.includes(rule.pattern.toLowerCase());
  if (rule.operator === "equals") return text === rule.pattern.toLowerCase();
  if (rule.operator === "starts_with")
    return text.startsWith(rule.pattern.toLowerCase());
  if (rule.operator === "regex") {
    try {
      return new RegExp(rule.pattern, "i").test(text);
    } catch {
      return false;
    }
  }
  return false;
}

export async function resolveClassifications(
  db: D1Database,
  transactions: ClassifiedTransaction[],
): Promise<Map<string, ClassificationResult>> {
  if (transactions.length === 0) return new Map();

  // URL paths normalize backslashes, so compare override ids in their normalized form.
  const normalizeId = (id: string) => id.replace(/\\/g, "/");
  const transactionIds = [
    ...new Set(
      transactions.flatMap((transaction) => [
        transaction.id,
        normalizeId(transaction.id),
      ]),
    ),
  ];
  const [overrides, rules] = await Promise.all([
    listClassificationOverrides(db, transactionIds),
    listEnabledClassificationRules(db),
  ]);

  const overrideMap = new Map(
    overrides.map((override) => [normalizeId(override.target_id), override]),
  );
  const result = new Map<string, ClassificationResult>();

  for (const transaction of transactions) {
    const override = overrideMap.get(normalizeId(transaction.id));
    if (override) {
      result.set(transaction.id, {
        categoryId: override.category_id,
        label: override.label,
        source: "override",
      });
      continue;
    }

    let matched: ClassificationResult | undefined;
    for (const rule of rules) {
      if (rule.target_type && rule.target_type !== "bank_transaction") continue;
      if (!matchesClassificationRule(rule, transaction)) continue;
      matched = {
        categoryId: rule.category_id,
        label: rule.label,
        source: rule.is_system ? "system_rule" : "user_rule",
        ruleId: rule.id,
        excludedFromCalculation: rule.excluded_from_calculation === 1,
      };
      break;
    }
    result.set(
      transaction.id,
      matched ?? { categoryId: "other", label: "未分類", source: "fallback" },
    );
  }

  return result;
}

export class ClassificationCategoryExistsError extends Error {}
export class ClassificationCategoryNotFoundError extends Error {}
export class ClassificationRuleNotFoundError extends Error {}
export class ClassificationRuleOrderError extends Error {}

export async function getClassificationCategories(db: D1Database) {
  const rows = await listClassificationCategories(db);
  return rows.map((row) => ({ ...row, isSystem: Boolean(row.isSystem) }));
}

export async function createClassificationCategory(
  db: D1Database,
  label: string,
) {
  if (await findCategoryByLabel(db, label))
    throw new ClassificationCategoryExistsError();
  const id = `user:${crypto.randomUUID()}`;
  const sortOrder = await nextCategorySortOrder(db);
  await insertClassificationCategory(db, {
    id,
    label,
    sortOrder,
    now: new Date().toISOString(),
  });
  return { id, label, sortOrder, isSystem: false };
}

export async function getClassificationRules(db: D1Database) {
  const rows = await listClassificationRules(db);
  return rows.map((row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    isSystem: Boolean(row.isSystem),
    excludedFromCalculation: Boolean(row.excludedFromCalculation),
  }));
}

export async function reorderClassificationRules(
  db: D1Database,
  ruleIds: string[],
) {
  const editableRuleIds = await listEditableClassificationRuleIds(db);
  const editableRuleIdSet = new Set(editableRuleIds);
  if (
    ruleIds.length !== editableRuleIds.length ||
    new Set(ruleIds).size !== ruleIds.length ||
    ruleIds.some((ruleId) => !editableRuleIdSet.has(ruleId))
  ) {
    throw new ClassificationRuleOrderError();
  }

  await updateClassificationRuleOrder(db, ruleIds, new Date().toISOString());
}

export function setClassificationOverride(
  db: D1Database,
  targetType: string,
  targetId: string,
  categoryId: string,
) {
  return upsertClassificationOverride(db, {
    targetType,
    targetId,
    categoryId,
    now: new Date().toISOString(),
  });
}

export function removeClassificationOverride(
  db: D1Database,
  targetType: string,
  targetId: string,
) {
  return deleteClassificationOverride(db, targetType, targetId);
}

export type CreateClassificationRuleInput = {
  categoryId: string;
  targetType?: string;
  field: string;
  operator: string;
  pattern: string;
  priority?: number;
  description?: string;
  excludedFromCalculation?: boolean;
};

export async function createClassificationRule(
  db: D1Database,
  input: CreateClassificationRuleInput,
) {
  if (!(await classificationCategoryExists(db, input.categoryId))) {
    throw new ClassificationCategoryNotFoundError();
  }
  const id = `user:${crypto.randomUUID()}`;
  await insertClassificationRule(db, {
    id,
    categoryId: input.categoryId,
    targetType: input.targetType ?? null,
    field: input.field,
    operator: input.operator,
    pattern: input.pattern,
    priority: input.priority ?? 200,
    description: input.description ?? null,
    excludedFromCalculation: input.excludedFromCalculation ?? false,
    now: new Date().toISOString(),
  });
  return id;
}

export async function editClassificationRule(
  db: D1Database,
  ruleId: string,
  input: Parameters<typeof updateClassificationRule>[2],
) {
  if (
    input.categoryId &&
    !(await classificationCategoryExists(db, input.categoryId))
  ) {
    throw new ClassificationCategoryNotFoundError();
  }
  if (
    !(await updateClassificationRule(
      db,
      ruleId,
      input,
      new Date().toISOString(),
    ))
  ) {
    throw new ClassificationRuleNotFoundError();
  }
}

export async function removeClassificationRule(db: D1Database, ruleId: string) {
  if (!(await deleteClassificationRule(db, ruleId))) {
    throw new ClassificationRuleNotFoundError();
  }
}
import {
  classificationCategoryExists,
  deleteClassificationOverride,
  deleteClassificationRule,
  findCategoryByLabel,
  insertClassificationCategory,
  insertClassificationRule,
  listClassificationCategories,
  listEditableClassificationRuleIds,
  listClassificationOverrides,
  listClassificationRules,
  listEnabledClassificationRules,
  nextCategorySortOrder,
  updateClassificationRule,
  updateClassificationRuleOrder,
  upsertClassificationOverride,
} from "./repository";
