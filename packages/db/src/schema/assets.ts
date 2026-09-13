import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const manualAssets = sqliteTable(
  "manual_assets",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull(),
    currency: text("currency")
      .notNull()
      .default(sql`'TWD'`),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const netWorthHistory = sqliteTable(
  "net_worth_history",
  {
    id: text("id").notNull(),
    date: text("date").notNull(),
    netWorth: integer("net_worth").notNull(),
    assetType: text("asset_type")
      .notNull()
      .default(sql`'total'`),
    source: text("source").notNull(),
    snapshottedAt: text("snapshotted_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_net_worth_history_page").on(
      sql`date DESC`,
      sql`source ASC`,
      sql`asset_type ASC`,
      sql`id ASC`,
    ),
    index("idx_net_worth_history_date").on(table.date),
    unique().on(table.source, table.assetType, table.date),
  ],
);
