import {
  createDrizzle,
  classificationCategories as categories,
  classificationOverrides as overrides,
  classificationRules as rules,
} from "@taiwan-fin-hub/db";
import { and, desc, eq, sql } from "drizzle-orm";

export type ClassificationOverrideRow = Awaited<
  ReturnType<typeof listClassificationOverrides>
>[number];
export type ClassificationRuleMatchRow = Awaited<
  ReturnType<typeof listEnabledClassificationRules>
>[number];

export async function listClassificationOverrides(
  db: D1Database,
  transactionIds: string[],
) {
  return (
    createDrizzle(db)
      .select({
        target_id: overrides.targetId,
        category_id: overrides.categoryId,
        label: categories.label,
      })
      .from(overrides)
      .innerJoin(categories, eq(categories.id, overrides.categoryId))
      // Keep one bound JSON array, including for large transaction lists.
      .where(
        and(
          eq(overrides.targetType, "bank_transaction"),
          sql`${overrides.targetId} IN (SELECT value FROM json_each(${JSON.stringify(transactionIds)}))`,
        ),
      )
      .all()
  );
}

export async function listEnabledClassificationRules(db: D1Database) {
  return createDrizzle(db)
    .select({
      id: rules.id,
      category_id: rules.categoryId,
      label: categories.label,
      target_type: rules.targetType,
      field: rules.field,
      operator: rules.operator,
      pattern: rules.pattern,
      is_system: rules.isSystem,
      excluded_from_calculation: rules.excludedFromCalculation,
    })
    .from(rules)
    .innerJoin(categories, eq(categories.id, rules.categoryId))
    .where(eq(rules.enabled, 1))
    .orderBy(desc(rules.priority), desc(rules.updatedAt), rules.id)
    .all();
}

export async function listClassificationCategories(db: D1Database) {
  return createDrizzle(db)
    .select({
      id: categories.id,
      label: categories.label,
      sortOrder: categories.sortOrder,
      isSystem: categories.isSystem,
    })
    .from(categories)
    .orderBy(categories.sortOrder, categories.id)
    .all();
}

export async function findCategoryByLabel(db: D1Database, label: string) {
  return (
    (await createDrizzle(db)
      .select({ id: categories.id })
      .from(categories)
      .where(sql`${categories.label} = ${label} COLLATE NOCASE`)
      .limit(1)
      .get()) ?? null
  );
}

export async function nextCategorySortOrder(db: D1Database) {
  const row = await createDrizzle(db)
    .select({
      sortOrder: sql<number>`COALESCE(MAX(${categories.sortOrder}), 0) + 1`,
    })
    .from(categories)
    .get();
  return Number(row?.sortOrder ?? 1);
}

export async function insertClassificationCategory(
  db: D1Database,
  input: { id: string; label: string; sortOrder: number; now: string },
) {
  await createDrizzle(db)
    .insert(categories)
    .values({
      id: input.id,
      label: input.label,
      sortOrder: input.sortOrder,
      isSystem: 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
}

export async function listClassificationRules(db: D1Database) {
  return createDrizzle(db)
    .select({
      id: rules.id,
      categoryId: rules.categoryId,
      targetType: rules.targetType,
      field: rules.field,
      operator: rules.operator,
      pattern: rules.pattern,
      priority: rules.priority,
      enabled: rules.enabled,
      isSystem: rules.isSystem,
      source: rules.source,
      description: rules.description,
      excludedFromCalculation: rules.excludedFromCalculation,
    })
    .from(rules)
    .orderBy(desc(rules.priority), desc(rules.updatedAt), rules.id)
    .all();
}

export async function listEditableClassificationRuleIds(db: D1Database) {
  const rows = await createDrizzle(db)
    .select({ id: rules.id })
    .from(rules)
    .where(eq(rules.isSystem, 0))
    .orderBy(desc(rules.priority), desc(rules.updatedAt), rules.id)
    .all();
  return rows.map((row) => row.id);
}

export async function updateClassificationRuleOrder(
  db: D1Database,
  ruleIds: string[],
  now: string,
) {
  const database = createDrizzle(db);
  const topPriority = 1000 + ruleIds.length;
  const [first, ...rest] = ruleIds.map((ruleId, index) =>
    database
      .update(rules)
      .set({ priority: topPriority - index, updatedAt: now })
      .where(and(eq(rules.id, ruleId), eq(rules.isSystem, 0))),
  );
  if (first) await database.batch([first, ...rest]);
}

export async function upsertClassificationOverride(
  db: D1Database,
  input: {
    targetType: string;
    targetId: string;
    categoryId: string;
    now: string;
  },
) {
  await createDrizzle(db)
    .insert(overrides)
    .values({
      id: `override:${input.targetType}:${input.targetId}`,
      targetType: input.targetType,
      targetId: input.targetId,
      categoryId: input.categoryId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [overrides.targetType, overrides.targetId],
      set: { categoryId: input.categoryId, updatedAt: input.now },
    })
    .run();
}

export async function deleteClassificationOverride(
  db: D1Database,
  targetType: string,
  targetId: string,
) {
  await createDrizzle(db)
    .delete(overrides)
    .where(
      and(
        eq(overrides.targetType, targetType),
        eq(overrides.targetId, targetId),
      ),
    )
    .run();
}

export async function classificationCategoryExists(
  db: D1Database,
  categoryId: string,
) {
  return Boolean(
    await createDrizzle(db)
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .get(),
  );
}

export async function insertClassificationRule(
  db: D1Database,
  input: {
    id: string;
    categoryId: string;
    targetType: string | null;
    field: string;
    operator: string;
    pattern: string;
    priority: number;
    description: string | null;
    excludedFromCalculation: boolean;
    now: string;
  },
) {
  await createDrizzle(db)
    .insert(rules)
    .values({
      id: input.id,
      categoryId: input.categoryId,
      targetType: input.targetType,
      field: input.field,
      operator: input.operator,
      pattern: input.pattern,
      priority: input.priority,
      enabled: 1,
      isSystem: 0,
      source: "user",
      description: input.description,
      excludedFromCalculation: input.excludedFromCalculation ? 1 : 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
}

export async function updateClassificationRule(
  db: D1Database,
  ruleId: string,
  input: {
    categoryId?: string;
    operator?: string;
    pattern?: string;
    priority?: number;
    enabled?: boolean;
    description?: string | null;
    excludedFromCalculation?: boolean;
  },
  now: string,
) {
  const result = await createDrizzle(db)
    .update(rules)
    .set({
      categoryId: input.categoryId || undefined,
      operator: input.operator,
      pattern: input.pattern,
      priority: input.priority,
      enabled: input.enabled === undefined ? undefined : input.enabled ? 1 : 0,
      description: input.description,
      excludedFromCalculation:
        input.excludedFromCalculation === undefined
          ? undefined
          : input.excludedFromCalculation
            ? 1
            : 0,
      updatedAt: now,
    })
    .where(and(eq(rules.id, ruleId), eq(rules.isSystem, 0)))
    .run();
  return result.meta.changes === 1;
}

export async function deleteClassificationRule(db: D1Database, ruleId: string) {
  const result = await createDrizzle(db)
    .delete(rules)
    .where(and(eq(rules.id, ruleId), eq(rules.isSystem, 0)))
    .run();
  return result.meta.changes === 1;
}
