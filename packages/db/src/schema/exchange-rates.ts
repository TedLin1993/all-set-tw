import { sqliteTable, text, real, primaryKey } from "drizzle-orm/sqlite-core";

// Table-level primary keys preserve SQLite's existing nullable TEXT primary keys.
// SQL migrations remain authoritative; do not add NOT NULL through ORM adoption.

export const exchangeRates = sqliteTable("exchange_rates", {
  currency: text("currency"),
  rateToTwd: real("rate_to_twd").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.currency] }),
]);
