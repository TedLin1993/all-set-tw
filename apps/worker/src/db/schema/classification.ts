import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const classificationCategories = sqliteTable(
  "classification_categories",
  {
    id: text("id").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order")
      .notNull()
      .default(sql`0`),
    isSystem: integer("is_system")
      .notNull()
      .default(sql`1`),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex("idx_classification_categories_label_nocase").on(
      sql`label COLLATE NOCASE`,
    ),
  ],
);

export const classificationOverrides = sqliteTable(
  "classification_overrides",
  {
    id: text("id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    categoryId: text("category_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_classification_overrides_category").on(table.categoryId),
    unique().on(table.targetType, table.targetId),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [classificationCategories.id],
    }),
  ],
);

export const classificationRules = sqliteTable(
  "classification_rules",
  {
    id: text("id").notNull(),
    categoryId: text("category_id").notNull(),
    targetType: text("target_type"),
    field: text("field").notNull(),
    operator: text("operator").notNull(),
    pattern: text("pattern").notNull(),
    priority: integer("priority")
      .notNull()
      .default(sql`100`),
    enabled: integer("enabled")
      .notNull()
      .default(sql`1`),
    isSystem: integer("is_system")
      .notNull()
      .default(sql`0`),
    source: text("source")
      .notNull()
      .default(sql`'user'`),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    excludedFromCalculation: integer("excluded_from_calculation")
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_classification_rules_category").on(table.categoryId),
    index("idx_classification_rules_enabled_priority").on(
      table.enabled,
      table.targetType,
      table.priority,
    ),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [classificationCategories.id],
    }),
    check(
      "classification_rules_check_1",
      sql`excluded_from_calculation IN (0, 1)`,
    ),
  ],
);

export const aiClassificationSettings = sqliteTable(
  "ai_classification_settings",
  {
    id: text("id").notNull(),
    enabled: integer("enabled")
      .notNull()
      .default(sql`0`),
    enabledAt: text("enabled_at"),
    scanMode: text("scan_mode").$type<"recent" | "backfill" | null>(),
    scanId: text("scan_id"),
    scanMonth: text("scan_month"),
    scanStopMonth: text("scan_stop_month"),
    scanWatermark: text("scan_watermark"),
    scannedWatermark: text("scanned_watermark"),
    backfillStatus: text("backfill_status")
      .$type<"idle" | "running" | "completed">()
      .notNull()
      .default(sql`'idle'`),
    backfillClassifiedCount: integer("backfill_classified_count")
      .notNull()
      .default(sql`0`),
    backfillUndeterminedCount: integer("backfill_undetermined_count")
      .notNull()
      .default(sql`0`),
    backfillStartedAt: text("backfill_started_at"),
    backfillCompletedAt: text("backfill_completed_at"),
    quotaDay: text("quota_day"),
    quotaUsed: integer("quota_used")
      .notNull()
      .default(sql`0`),
    pausedUntil: text("paused_until"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check("ai_classification_settings_check_1", sql`id = 'default'`),
  ],
);

export const aiClassifications = sqliteTable(
  "ai_classifications",
  {
    transactionId: text("transaction_id").notNull(),
    categoryId: text("category_id"),
    probability: real("probability").notNull(),
    inputHash: text("input_hash").notNull(),
    model: text("model").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.transactionId] }),
    index("idx_ai_classifications_category").on(table.categoryId),
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [classificationCategories.id],
    }),
  ],
);
