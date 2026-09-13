import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  unique,
  index,
  check,
} from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const investmentPositions = sqliteTable(
  "investment_positions",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id").notNull(),
    sourceId: text("source_id").notNull(),
    assetType: text("asset_type").notNull(),
    symbol: text("symbol"),
    name: text("name").notNull(),
    quantity: real("quantity"),
    marketValue: integer("market_value"),
    cashBalance: integer("cash_balance"),
    currency: text("currency")
      .notNull()
      .default(sql`'TWD'`),
    asOfDate: text("as_of_date").notNull(),
    rawPayload: text("raw_payload"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_investment_positions_page").on(
      sql`as_of_date DESC`,
      sql`asset_type ASC`,
      sql`name ASC`,
      sql`id ASC`,
    ),
    index("idx_investment_positions_latest_scope").on(
      table.connectorId,
      table.assetType,
      sql`as_of_date DESC`,
    ),
    index("idx_investment_positions_asset_type").on(table.assetType),
    index("idx_investment_positions_as_of_date").on(table.asOfDate),
    unique().on(table.connectorId, table.sourceId, table.asOfDate),
    check(
      "investment_positions_check_1",
      sql`asset_type IN ('stock', 'etf', 'fund')`,
    ),
  ],
);

export const investmentTransactions = sqliteTable(
  "investment_transactions",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id").notNull(),
    accountId: text("account_id").notNull(),
    sourceId: text("source_id").notNull(),
    brokerNo: text("broker_no"),
    brokerAccount: text("broker_account"),
    brokerName: text("broker_name"),
    symbol: text("symbol"),
    name: text("name"),
    assetType: text("asset_type"),
    tradeDate: text("trade_date"),
    postedDate: text("posted_date"),
    transactionCode: text("transaction_code"),
    transactionName: text("transaction_name"),
    quantity: real("quantity"),
    price: real("price"),
    amount: integer("amount"),
    currency: text("currency")
      .notNull()
      .default(sql`'TWD'`),
    rawPayload: text("raw_payload"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    effectiveDate: text("effective_date").generatedAlwaysAs(
      sql`COALESCE(trade_date, posted_date, '')`,
      { mode: "virtual" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_investment_transactions_effective_updated").on(
      sql`effective_date DESC`,
      sql`updated_at DESC`,
      sql`id DESC`,
    ),
    index("idx_investment_transactions_symbol").on(table.symbol),
    index("idx_investment_transactions_trade_date").on(table.tradeDate),
    unique().on(table.connectorId, table.accountId, table.sourceId),
    check(
      "investment_transactions_check_1",
      sql`asset_type IN ('stock', 'etf', 'fund', 'bond', 'unknown')`,
    ),
  ],
);
