import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey, unique, uniqueIndex, index, foreignKey, check } from "drizzle-orm/sqlite-core";

// Table-level primary keys preserve SQLite's existing nullable TEXT primary keys.
// SQL migrations remain authoritative; do not add NOT NULL through ORM adoption.

export const bankAccounts = sqliteTable("bank_accounts", {
  id: text("id"),
  connectorId: text("connector_id").notNull(),
  sourceId: text("source_id").notNull(),
  institutionName: text("institution_name"),
  accountName: text("account_name"),
  accountType: text("account_type"),
  currency: text("currency").notNull().default(sql`'TWD'`),
  rawPayload: text("raw_payload"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  bankCode: text("bank_code"),
  accountLast4: text("account_last4"),
  canonicalAccountId: text("canonical_account_id"),
  creditLimit: integer("credit_limit"),
  openedDate: text("opened_date"),
  maturityDate: text("maturity_date"),
  inactiveAt: text("inactive_at"),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  index("idx_bank_accounts_match").on(table.bankCode, table.accountLast4, table.currency),
  unique().on(table.connectorId, table.sourceId),
  foreignKey({ columns: [table.canonicalAccountId], foreignColumns: [table.id] }),
  check("bank_accounts_check_1", sql`
    account_type IS NULL
    OR account_type IN ('checking', 'savings', 'credit', 'loan', 'settlement_cash', 'time_deposit', 'stored_value', 'unknown')
  `),
]);

export const bankBalanceSnapshots = sqliteTable("bank_balance_snapshots", {
  id: text("id"),
  connectorId: text("connector_id").notNull(),
  accountId: text("account_id").notNull(),
  sourceId: text("source_id").notNull(),
  balance: integer("balance").notNull(),
  availableBalance: integer("available_balance"),
  currency: text("currency").notNull().default(sql`'TWD'`),
  asOfAt: text("as_of_at").notNull(),
  rawPayload: text("raw_payload"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  statementBalance: integer("statement_balance"),
  paymentDueDate: text("payment_due_date"),
  noPaymentNeeded: integer("no_payment_needed"),
  statementClosingDate: text("statement_closing_date"),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  index("idx_bank_balance_snapshots_as_of").on(table.asOfAt),
  index("idx_bank_balance_snapshots_account_as_of").on(table.accountId, table.asOfAt),
  unique().on(table.connectorId, table.accountId, table.sourceId),
  foreignKey({ columns: [table.accountId], foreignColumns: [bankAccounts.id] }),
]);

export const bankTransactions = sqliteTable("bank_transactions", {
  id: text("id"),
  connectorId: text("connector_id").notNull(),
  accountId: text("account_id").notNull(),
  sourceId: text("source_id").notNull(),
  postedDate: text("posted_date"),
  authorizedAt: text("authorized_at"),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default(sql`'TWD'`),
  description: text("description"),
  counterparty: text("counterparty"),
  rawPayload: text("raw_payload"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  effectiveDate: text("effective_date").generatedAlwaysAs(sql`COALESCE(posted_date, authorized_at, '')`, { mode: "virtual" }),
  status: text("status").notNull().default(sql`'posted'`),
  transferPeerId: text("transfer_peer_id"),
  matchedTransactionId: text("matched_transaction_id"),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  uniqueIndex("idx_bank_transactions_matched_transaction").on(table.matchedTransactionId).where(sql`matched_transaction_id IS NOT NULL`),
  index("idx_bank_transactions_transaction_day").on(sql`
    CASE
      WHEN length(authorized_at) > 10
        THEN COALESCE(
          date(authorized_at, '+8 hours'),
          substr(authorized_at, 1, 10)
        )
      ELSE substr(COALESCE(authorized_at, posted_date), 1, 10)
    END
  `),
  index("idx_bank_transactions_status").on(table.connectorId, table.accountId, table.status),
  index("idx_bank_transactions_effective_updated").on(sql`effective_date DESC`, sql`updated_at DESC`, sql`id DESC`),
  index("idx_bank_transactions_posted_date").on(table.postedDate),
  index("idx_bank_transactions_account_posted_date").on(table.accountId, table.postedDate),
  unique().on(table.connectorId, table.accountId, table.sourceId),
  foreignKey({ columns: [table.accountId], foreignColumns: [bankAccounts.id] }),
  check("bank_transactions_check_1", sql`status IN ('pending', 'posted')`),
]);

export const bankTransactionPreferences = sqliteTable("bank_transaction_preferences", {
  transactionId: text("transaction_id"),
  excludedFromCalculation: integer("excluded_from_calculation").notNull().default(sql`0`),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.transactionId] }),
  index("idx_bank_transaction_preferences_excluded").on(table.excludedFromCalculation),
  check("bank_transaction_preferences_check_1", sql`excluded_from_calculation IN (0, 1)`),
]);

export const creditCardBills = sqliteTable("credit_card_bills", {
  id: text("id"),
  connectorId: text("connector_id").notNull(),
  accountId: text("account_id").notNull(),
  sourceId: text("source_id").notNull(),
  billingPeriod: text("billing_period").notNull(),
  statementAmount: integer("statement_amount"),
  minimumPayment: integer("minimum_payment"),
  paidAmount: integer("paid_amount"),
  isPaid: integer("is_paid"),
  paymentDueDate: text("payment_due_date"),
  statementClosingDate: text("statement_closing_date"),
  currency: text("currency").notNull().default(sql`'TWD'`),
  rawPayload: text("raw_payload"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  index("idx_credit_card_bills_page").on(sql`billing_period DESC`, table.accountId, table.id),
  index("idx_credit_card_bills_account_period").on(table.accountId, table.billingPeriod),
  unique().on(table.connectorId, table.accountId, table.billingPeriod),
  foreignKey({ columns: [table.accountId], foreignColumns: [bankAccounts.id] }),
]);
