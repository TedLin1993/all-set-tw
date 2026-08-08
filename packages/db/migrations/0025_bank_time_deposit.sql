PRAGMA defer_foreign_keys = ON;

CREATE TABLE bank_accounts_new (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  institution_name TEXT,
  account_name TEXT,
  account_type TEXT CHECK (
    account_type IS NULL
    OR account_type IN ('checking', 'savings', 'credit', 'loan', 'settlement_cash', 'time_deposit', 'stored_value', 'unknown')
  ),
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bank_code TEXT,
  account_last4 TEXT,
  canonical_account_id TEXT REFERENCES bank_accounts_new (id),
  credit_limit INTEGER,
  UNIQUE (connector_id, source_id)
);

CREATE TABLE bank_balance_snapshots_new (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES bank_accounts_new (id),
  source_id TEXT NOT NULL,
  balance INTEGER NOT NULL,
  available_balance INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_at TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  statement_balance INTEGER,
  payment_due_date TEXT,
  no_payment_needed INTEGER,
  statement_closing_date TEXT,
  UNIQUE (connector_id, account_id, source_id)
);

CREATE TABLE bank_transactions_new (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES bank_accounts_new (id),
  source_id TEXT NOT NULL,
  posted_date TEXT,
  authorized_at TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  description TEXT,
  counterparty TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_date TEXT AS (COALESCE(posted_date, authorized_at, '')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted')),
  UNIQUE (connector_id, account_id, source_id)
);

CREATE TABLE credit_card_bills_new (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES bank_accounts_new (id),
  source_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  statement_amount INTEGER,
  minimum_payment INTEGER,
  paid_amount INTEGER,
  is_paid INTEGER,
  payment_due_date TEXT,
  statement_closing_date TEXT,
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, account_id, billing_period)
);

INSERT INTO bank_accounts_new (
  id, connector_id, source_id, institution_name, account_name, account_type,
  currency, raw_payload, created_at, updated_at, bank_code, account_last4,
  canonical_account_id, credit_limit
)
SELECT
  id, connector_id, source_id, institution_name, account_name, account_type,
  currency, raw_payload, created_at, updated_at, bank_code, account_last4,
  canonical_account_id, credit_limit
FROM bank_accounts;

INSERT INTO bank_balance_snapshots_new (
  id, connector_id, account_id, source_id, balance, available_balance,
  currency, as_of_at, raw_payload, created_at, updated_at, statement_balance,
  payment_due_date, no_payment_needed, statement_closing_date
)
SELECT
  id, connector_id, account_id, source_id, balance, available_balance,
  currency, as_of_at, raw_payload, created_at, updated_at, statement_balance,
  payment_due_date, no_payment_needed, statement_closing_date
FROM bank_balance_snapshots;

INSERT INTO bank_transactions_new (
  id, connector_id, account_id, source_id, posted_date, authorized_at, amount,
  currency, description, counterparty, raw_payload, created_at, updated_at, status
)
SELECT
  id, connector_id, account_id, source_id, posted_date, authorized_at, amount,
  currency, description, counterparty, raw_payload, created_at, updated_at, status
FROM bank_transactions;

INSERT INTO credit_card_bills_new (
  id, connector_id, account_id, source_id, billing_period, statement_amount,
  minimum_payment, paid_amount, is_paid, payment_due_date,
  statement_closing_date, currency, raw_payload, created_at, updated_at
)
SELECT
  id, connector_id, account_id, source_id, billing_period, statement_amount,
  minimum_payment, paid_amount, is_paid, payment_due_date,
  statement_closing_date, currency, raw_payload, created_at, updated_at
FROM credit_card_bills;

DROP TABLE bank_balance_snapshots;
DROP TABLE bank_transactions;
DROP TABLE credit_card_bills;
DROP TABLE bank_accounts;
ALTER TABLE bank_accounts_new RENAME TO bank_accounts;
ALTER TABLE bank_balance_snapshots_new RENAME TO bank_balance_snapshots;
ALTER TABLE bank_transactions_new RENAME TO bank_transactions;
ALTER TABLE credit_card_bills_new RENAME TO credit_card_bills;

CREATE INDEX idx_bank_accounts_match
  ON bank_accounts (bank_code, account_last4, currency);

CREATE INDEX idx_bank_balance_snapshots_account_as_of
  ON bank_balance_snapshots (account_id, as_of_at);

CREATE INDEX idx_bank_balance_snapshots_as_of
  ON bank_balance_snapshots (as_of_at);

CREATE INDEX idx_bank_transactions_account_posted_date
  ON bank_transactions (account_id, posted_date);

CREATE INDEX idx_bank_transactions_posted_date
  ON bank_transactions (posted_date);

CREATE INDEX idx_bank_transactions_effective_updated
  ON bank_transactions (effective_date DESC, updated_at DESC, id DESC);

CREATE INDEX idx_bank_transactions_status
  ON bank_transactions (connector_id, account_id, status);

CREATE INDEX idx_credit_card_bills_account_period
  ON credit_card_bills (account_id, billing_period);

CREATE INDEX idx_credit_card_bills_page
  ON credit_card_bills (billing_period DESC, account_id ASC, id ASC);
