import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey, unique, index } from "drizzle-orm/sqlite-core";

// Table-level primary keys preserve SQLite's existing nullable TEXT primary keys.
// SQL migrations remain authoritative; do not add NOT NULL through ORM adoption.

export const manualAssets = sqliteTable("manual_assets", {
  id: text("id"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  note: text("note"),
  createdAt: text("created_at").notNull(),
  currency: text("currency").notNull().default(sql`'TWD'`),
}, (table) => [
  primaryKey({ columns: [table.id] }),
]);

export const netWorthHistory = sqliteTable("net_worth_history", {
  id: text("id"),
  date: text("date").notNull(),
  netWorth: integer("net_worth").notNull(),
  assetType: text("asset_type").notNull().default(sql`'total'`),
  source: text("source").notNull(),
  snapshottedAt: text("snapshotted_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  index("idx_net_worth_history_page").on(sql`date DESC`, table.source, table.assetType, table.id),
  index("idx_net_worth_history_date").on(table.date),
  unique().on(table.source, table.assetType, table.date),
]);
