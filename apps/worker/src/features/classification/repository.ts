export type ClassificationOverrideRow = {
  target_id: string;
  category_id: string;
  label: string;
};

export type ClassificationRuleMatchRow = {
  id: string;
  category_id: string;
  label: string;
  target_type: string | null;
  field: string;
  operator: string;
  pattern: string;
  is_system: number;
  excluded_from_calculation: number;
};

export async function listClassificationOverrides(
  db: D1Database,
  transactionIds: string[],
) {
  const rows = await db
    .prepare(
      `SELECT o.target_id, o.category_id, c.label
     FROM classification_overrides o
     JOIN classification_categories c ON c.id = o.category_id
     WHERE o.target_type = 'bank_transaction'
       AND o.target_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(transactionIds))
    .all<ClassificationOverrideRow>();
  return rows.results;
}

export async function listEnabledClassificationRules(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT r.id, r.category_id, c.label, r.target_type, r.field, r.operator, r.pattern,
            r.is_system, r.excluded_from_calculation
     FROM classification_rules r
     JOIN classification_categories c ON c.id = r.category_id
     WHERE r.enabled = 1
     ORDER BY r.priority DESC, r.updated_at DESC, r.id ASC`,
    )
    .all<ClassificationRuleMatchRow>();
  return rows.results;
}

export async function listClassificationCategories(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, label, sort_order AS sortOrder, is_system AS isSystem
     FROM classification_categories
     ORDER BY sort_order ASC, id ASC`,
    )
    .all<Record<string, unknown> & { isSystem: number }>();
  return rows.results;
}

export function findCategoryByLabel(db: D1Database, label: string) {
  return db
    .prepare(
      `SELECT id FROM classification_categories
     WHERE label = ? COLLATE NOCASE
     LIMIT 1`,
    )
    .bind(label)
    .first<{ id: string }>();
}

export async function nextCategorySortOrder(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(sort_order), 0) + 1 AS sortOrder FROM classification_categories",
    )
    .first<{ sortOrder: number }>();
  return Number(row?.sortOrder ?? 1);
}

export async function insertClassificationCategory(
  db: D1Database,
  input: { id: string; label: string; sortOrder: number; now: string },
) {
  await db
    .prepare(
      `INSERT INTO classification_categories
       (id, label, sort_order, is_system, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .bind(input.id, input.label, input.sortOrder, input.now, input.now)
    .run();
}

export async function listClassificationRules(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, category_id AS categoryId, target_type AS targetType, field, operator,
            pattern, priority, enabled, is_system AS isSystem, source, description,
            excluded_from_calculation AS excludedFromCalculation
     FROM classification_rules
     ORDER BY priority DESC, updated_at DESC, id ASC`,
    )
    .all<
      Record<string, unknown> & {
        enabled: number;
        isSystem: number;
        excludedFromCalculation: number;
      }
    >();
  return rows.results;
}

export async function listEditableClassificationRuleIds(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id
       FROM classification_rules
       WHERE is_system = 0
       ORDER BY priority DESC, updated_at DESC, id ASC`,
    )
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function updateClassificationRuleOrder(
  db: D1Database,
  ruleIds: string[],
  now: string,
) {
  if (ruleIds.length === 0) return;

  const topPriority = 1000 + ruleIds.length;
  await db.batch(
    ruleIds.map((ruleId, index) =>
      db
        .prepare(
          `UPDATE classification_rules
           SET priority = ?, updated_at = ?
           WHERE id = ? AND is_system = 0`,
        )
        .bind(topPriority - index, now, ruleId),
    ),
  );
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
  await db
    .prepare(
      `INSERT INTO classification_overrides
       (id, target_type, target_id, category_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_type, target_id) DO UPDATE SET
       category_id = excluded.category_id,
       updated_at = excluded.updated_at`,
    )
    .bind(
      `override:${input.targetType}:${input.targetId}`,
      input.targetType,
      input.targetId,
      input.categoryId,
      input.now,
      input.now,
    )
    .run();
}

export async function deleteClassificationOverride(
  db: D1Database,
  targetType: string,
  targetId: string,
) {
  await db
    .prepare(
      "DELETE FROM classification_overrides WHERE target_type = ? AND target_id = ?",
    )
    .bind(targetType, targetId)
    .run();
}

export async function classificationCategoryExists(
  db: D1Database,
  categoryId: string,
) {
  return Boolean(
    await db
      .prepare("SELECT id FROM classification_categories WHERE id = ?")
      .bind(categoryId)
      .first<{ id: string }>(),
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
  await db
    .prepare(
      `INSERT INTO classification_rules
       (id, category_id, target_type, field, operator, pattern, priority, enabled,
        is_system, source, description, excluded_from_calculation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'user', ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.categoryId,
      input.targetType,
      input.field,
      input.operator,
      input.pattern,
      input.priority,
      input.description,
      input.excludedFromCalculation ? 1 : 0,
      input.now,
      input.now,
    )
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
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.categoryId) {
    sets.push("category_id = ?");
    values.push(input.categoryId);
  }
  if (input.operator !== undefined) {
    sets.push("operator = ?");
    values.push(input.operator);
  }
  if (input.pattern !== undefined) {
    sets.push("pattern = ?");
    values.push(input.pattern);
  }
  if (input.priority !== undefined) {
    sets.push("priority = ?");
    values.push(input.priority);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    values.push(input.description);
  }
  if (input.excludedFromCalculation !== undefined) {
    sets.push("excluded_from_calculation = ?");
    values.push(input.excludedFromCalculation ? 1 : 0);
  }
  sets.push("updated_at = ?");
  values.push(now, ruleId);
  const result = await db
    .prepare(
      `UPDATE classification_rules SET ${sets.join(", ")} WHERE id = ? AND is_system = 0`,
    )
    .bind(...values)
    .run();
  return result.meta.changes === 1;
}

export async function deleteClassificationRule(db: D1Database, ruleId: string) {
  const result = await db
    .prepare("DELETE FROM classification_rules WHERE id = ? AND is_system = 0")
    .bind(ruleId)
    .run();
  return result.meta.changes === 1;
}
