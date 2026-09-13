import { sqliteTable, text, real, primaryKey } from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    currency: text("currency").notNull(),
    rateToTwd: real("rate_to_twd").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.currency] })],
);
