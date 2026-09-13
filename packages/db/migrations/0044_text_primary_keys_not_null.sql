PRAGMA defer_foreign_keys = ON;

CREATE TABLE _pk_migration_scheduled_sync_batch_results_backup AS
SELECT * FROM scheduled_sync_batch_results;
DROP TABLE scheduled_sync_batch_results;

CREATE TABLE bank_accounts_new (
  id TEXT NOT NULL PRIMARY KEY,
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
  credit_limit INTEGER, opened_date TEXT, maturity_date TEXT, inactive_at TEXT,
  UNIQUE (connector_id, source_id)
);

CREATE TABLE bank_balance_snapshots_new (
  id TEXT NOT NULL PRIMARY KEY,
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

CREATE TABLE bank_transaction_preferences_new (
  transaction_id TEXT NOT NULL PRIMARY KEY,
  excluded_from_calculation INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_calculation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bank_transactions_new (
  id TEXT NOT NULL PRIMARY KEY,
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
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted')), transfer_peer_id TEXT, matched_transaction_id TEXT,
  UNIQUE (connector_id, account_id, source_id)
);

CREATE TABLE classification_categories_new (
  id TEXT NOT NULL PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE classification_overrides_new (
  id TEXT NOT NULL PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES classification_categories_new (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_type, target_id)
);

CREATE TABLE classification_rules_new (
  id TEXT NOT NULL PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES classification_categories_new (id),
  target_type TEXT,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'user',
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, excluded_from_calculation INTEGER NOT NULL DEFAULT 0
CHECK (excluded_from_calculation IN (0, 1)));

CREATE TABLE connector_settings_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  encrypted_config TEXT NOT NULL,
  sync_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, public_config TEXT,
  UNIQUE (connector_id)
);

CREATE TABLE credit_card_bills_new (
  id TEXT NOT NULL PRIMARY KEY,
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

CREATE TABLE einvoice_sync_run_items_new (
  id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES einvoice_sync_runs_new (id) ON DELETE CASCADE,
  invoice_source_id TEXT NOT NULL,
  header_json TEXT NOT NULL,
  normalized_invoice_json TEXT NOT NULL,
  detail_key TEXT,
  detail_metadata_json TEXT,
  detail_items_json TEXT,
  line_item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, invoice_source_id)
);

CREATE TABLE einvoice_sync_runs_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'einvoice'
    CHECK (connector_id = 'einvoice'),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  sync_job_id TEXT REFERENCES sync_jobs_new (id) ON DELETE SET NULL,
  scheduled_batch_id TEXT REFERENCES scheduled_sync_batches_new (id) ON DELETE SET NULL,
  settings_version TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'initializing', 'processing', 'completed', 'failed', 'needs_user_action'
  )),
  total_item_count INTEGER NOT NULL DEFAULT 0,
  pending_item_count INTEGER NOT NULL DEFAULT 0,
  processing_item_count INTEGER NOT NULL DEFAULT 0,
  done_item_count INTEGER NOT NULL DEFAULT 0,
  line_item_count INTEGER NOT NULL DEFAULT 0,
  new_invoice_count INTEGER NOT NULL DEFAULT 0,
  session_refresh_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  chunk_lease_owner TEXT,
  chunk_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_at TEXT,
  completed_at TEXT
);

CREATE TABLE exchange_rates_new (
  currency TEXT NOT NULL PRIMARY KEY,
  rate_to_twd REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE investment_positions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund')),
  symbol TEXT,
  name TEXT NOT NULL,
  quantity REAL,
  market_value INTEGER,
  cash_balance INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_date TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id, as_of_date)
);

CREATE TABLE investment_transactions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  broker_no TEXT,
  broker_account TEXT,
  broker_name TEXT,
  symbol TEXT,
  name TEXT,
  asset_type TEXT CHECK (asset_type IN ('stock', 'etf', 'fund', 'bond', 'unknown')),
  trade_date TEXT,
  posted_date TEXT,
  transaction_code TEXT,
  transaction_name TEXT,
  quantity REAL,
  price REAL,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, effective_date TEXT AS (COALESCE(trade_date, posted_date, '')),
  UNIQUE (connector_id, account_id, source_id)
);

CREATE TABLE invoice_line_items_new (
  id TEXT NOT NULL PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  invoice_source_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL,
  unit_price INTEGER,
  amount INTEGER NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices_new (id) ON DELETE CASCADE,
  UNIQUE (connector_id, invoice_source_id, source_id)
);

CREATE TABLE invoice_transaction_preferences_new (
  invoice_id TEXT NOT NULL PRIMARY KEY,
  transaction_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('linked', 'separate')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (decision = 'linked' AND transaction_id IS NOT NULL)
    OR decision = 'separate'
  )
);

CREATE TABLE invoices_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  invoice_number TEXT,
  invoice_date TEXT NOT NULL,
  seller_name TEXT,
  amount INTEGER NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id)
);

CREATE TABLE manual_assets_new (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
, currency TEXT NOT NULL DEFAULT 'TWD');

CREATE TABLE net_worth_history_new (
  id TEXT NOT NULL PRIMARY KEY,
  date TEXT NOT NULL,
  net_worth INTEGER NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'total',
  source TEXT NOT NULL,
  snapshotted_at TEXT NOT NULL,
  UNIQUE (source, asset_type, date)
);

CREATE TABLE notification_preferences_new (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'default'),
  notify_success INTEGER NOT NULL DEFAULT 0,
  notify_failed INTEGER NOT NULL DEFAULT 1,
  notify_needs_user_action INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions_new (
  id TEXT NOT NULL PRIMARY KEY,
  encrypted_subscription TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE scheduled_sync_batches_new (
  id TEXT NOT NULL PRIMARY KEY,
  schedule_key TEXT NOT NULL DEFAULT 'default' CHECK (schedule_key = 'default'),
  notification_claimed_at TEXT,
  created_at TEXT NOT NULL
, completed_at TEXT, is_baseline INTEGER NOT NULL DEFAULT 0, assets_before_twd INTEGER, credit_card_debt_before_twd INTEGER, missing_currencies_before TEXT NOT NULL DEFAULT '[]', assets_after_twd INTEGER, credit_card_debt_after_twd INTEGER, missing_currencies_after TEXT NOT NULL DEFAULT '[]');

CREATE TABLE sync_jobs_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  locked_until TEXT,
  locked_by TEXT,
  lock_trigger TEXT CHECK (lock_trigger IS NULL OR lock_trigger IN ('manual', 'scheduled')),
  lock_scope TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, schedule_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (schedule_mode IN ('inherit', 'custom')), preferred_time TEXT NOT NULL DEFAULT '06:00', preferred_weekday INTEGER NOT NULL DEFAULT 1
  CHECK (preferred_weekday BETWEEN 0 AND 6),
  UNIQUE (connector_id, scope)
);

CREATE TABLE sync_schedule_settings_new (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'default'),
  interval_minutes INTEGER NOT NULL,
  preferred_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  updated_at TEXT NOT NULL
, preferred_weekday INTEGER NOT NULL DEFAULT 1
  CHECK (preferred_weekday BETWEEN 0 AND 6));

CREATE TABLE tdcc_sync_run_items_new (
  id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tdcc_sync_runs_new (id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  task_key TEXT NOT NULL DEFAULT '',
  account_id TEXT,
  page_cursor TEXT NOT NULL DEFAULT '',
  next_page_cursor TEXT,
  page_number INTEGER NOT NULL DEFAULT 0,
  task_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(task_json)),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, task_type, task_key, page_cursor)
);

CREATE TABLE tdcc_sync_runs_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'tdcc'
    CHECK (connector_id = 'tdcc'),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'investments', 'bank', 'trades')),
  sync_job_id TEXT REFERENCES sync_jobs_new (id) ON DELETE SET NULL,
  scheduled_batch_id TEXT REFERENCES scheduled_sync_batches_new (id) ON DELETE SET NULL,
  settings_version TEXT,
  phase TEXT NOT NULL DEFAULT 'initialize'
    CHECK (phase IN (
      'initialize', 'snapshot', 'positions', 'bank', 'investments',
      'trades', 'promote', 'finalize'
    )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'initializing', 'processing', 'promoting',
    'completed', 'failed', 'needs_user_action'
  )),
  -- The run retains the encrypted provider state it was initialized with.
  -- It is never exposed in an API response or log.
  encrypted_config TEXT,
  encrypted_session TEXT,
  session_json TEXT CHECK (session_json IS NULL OR json_valid(session_json)),
  total_item_count INTEGER NOT NULL DEFAULT 0,
  pending_item_count INTEGER NOT NULL DEFAULT 0,
  processing_item_count INTEGER NOT NULL DEFAULT 0,
  done_item_count INTEGER NOT NULL DEFAULT 0,
  failed_item_count INTEGER NOT NULL DEFAULT 0,
  session_refresh_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_at TEXT,
  completed_at TEXT
);

INSERT INTO bank_accounts_new (id, connector_id, source_id, institution_name, account_name, account_type, currency, raw_payload, created_at, updated_at, bank_code, account_last4, canonical_account_id, credit_limit, opened_date, maturity_date, inactive_at)
SELECT id, connector_id, source_id, institution_name, account_name, account_type, currency, raw_payload, created_at, updated_at, bank_code, account_last4, canonical_account_id, credit_limit, opened_date, maturity_date, inactive_at FROM bank_accounts;

INSERT INTO bank_balance_snapshots_new (id, connector_id, account_id, source_id, balance, available_balance, currency, as_of_at, raw_payload, created_at, updated_at, statement_balance, payment_due_date, no_payment_needed, statement_closing_date)
SELECT id, connector_id, account_id, source_id, balance, available_balance, currency, as_of_at, raw_payload, created_at, updated_at, statement_balance, payment_due_date, no_payment_needed, statement_closing_date FROM bank_balance_snapshots;

INSERT INTO bank_transaction_preferences_new (transaction_id, excluded_from_calculation, created_at, updated_at)
SELECT transaction_id, excluded_from_calculation, created_at, updated_at FROM bank_transaction_preferences;

INSERT INTO bank_transactions_new (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, counterparty, raw_payload, created_at, updated_at, status, transfer_peer_id, matched_transaction_id)
SELECT id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, counterparty, raw_payload, created_at, updated_at, status, transfer_peer_id, matched_transaction_id FROM bank_transactions;

INSERT INTO classification_categories_new (id, label, sort_order, is_system, created_at, updated_at)
SELECT id, label, sort_order, is_system, created_at, updated_at FROM classification_categories;

INSERT INTO classification_overrides_new (id, target_type, target_id, category_id, created_at, updated_at)
SELECT id, target_type, target_id, category_id, created_at, updated_at FROM classification_overrides;

INSERT INTO classification_rules_new (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at, excluded_from_calculation)
SELECT id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at, excluded_from_calculation FROM classification_rules;

INSERT INTO connector_settings_new (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at, public_config)
SELECT id, connector_id, encrypted_config, sync_cursor, created_at, updated_at, public_config FROM connector_settings;

INSERT INTO credit_card_bills_new (id, connector_id, account_id, source_id, billing_period, statement_amount, minimum_payment, paid_amount, is_paid, payment_due_date, statement_closing_date, currency, raw_payload, created_at, updated_at)
SELECT id, connector_id, account_id, source_id, billing_period, statement_amount, minimum_payment, paid_amount, is_paid, payment_due_date, statement_closing_date, currency, raw_payload, created_at, updated_at FROM credit_card_bills;

INSERT INTO einvoice_sync_run_items_new (id, run_id, invoice_source_id, header_json, normalized_invoice_json, detail_key, detail_metadata_json, detail_items_json, line_item_count, status, attempt_count, last_error, lease_token, lease_expires_at, created_at, updated_at, completed_at)
SELECT id, run_id, invoice_source_id, header_json, normalized_invoice_json, detail_key, detail_metadata_json, detail_items_json, line_item_count, status, attempt_count, last_error, lease_token, lease_expires_at, created_at, updated_at, completed_at FROM einvoice_sync_run_items;

INSERT INTO einvoice_sync_runs_new (id, connector_id, trigger, sync_job_id, scheduled_batch_id, settings_version, status, total_item_count, pending_item_count, processing_item_count, done_item_count, line_item_count, new_invoice_count, session_refresh_count, last_error, chunk_lease_owner, chunk_lease_expires_at, created_at, updated_at, promoted_at, completed_at)
SELECT id, connector_id, trigger, sync_job_id, scheduled_batch_id, settings_version, status, total_item_count, pending_item_count, processing_item_count, done_item_count, line_item_count, new_invoice_count, session_refresh_count, last_error, chunk_lease_owner, chunk_lease_expires_at, created_at, updated_at, promoted_at, completed_at FROM einvoice_sync_runs;

INSERT INTO exchange_rates_new (currency, rate_to_twd, updated_at)
SELECT currency, rate_to_twd, updated_at FROM exchange_rates;

INSERT INTO investment_positions_new (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at)
SELECT id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at FROM investment_positions;

INSERT INTO investment_transactions_new (id, connector_id, account_id, source_id, broker_no, broker_account, broker_name, symbol, name, asset_type, trade_date, posted_date, transaction_code, transaction_name, quantity, price, amount, currency, raw_payload, created_at, updated_at)
SELECT id, connector_id, account_id, source_id, broker_no, broker_account, broker_name, symbol, name, asset_type, trade_date, posted_date, transaction_code, transaction_name, quantity, price, amount, currency, raw_payload, created_at, updated_at FROM investment_transactions;

INSERT INTO invoice_line_items_new (id, invoice_id, connector_id, invoice_source_id, source_id, line_number, description, quantity, unit_price, amount, raw_payload, created_at, updated_at)
SELECT id, invoice_id, connector_id, invoice_source_id, source_id, line_number, description, quantity, unit_price, amount, raw_payload, created_at, updated_at FROM invoice_line_items;

INSERT INTO invoice_transaction_preferences_new (invoice_id, transaction_id, decision, created_at, updated_at)
SELECT invoice_id, transaction_id, decision, created_at, updated_at FROM invoice_transaction_preferences;

INSERT INTO invoices_new (id, connector_id, source_id, invoice_number, invoice_date, seller_name, amount, raw_payload, created_at, updated_at)
SELECT id, connector_id, source_id, invoice_number, invoice_date, seller_name, amount, raw_payload, created_at, updated_at FROM invoices;

INSERT INTO manual_assets_new (id, name, category, note, created_at, currency)
SELECT id, name, category, note, created_at, currency FROM manual_assets;

INSERT INTO net_worth_history_new (id, date, net_worth, asset_type, source, snapshotted_at)
SELECT id, date, net_worth, asset_type, source, snapshotted_at FROM net_worth_history;

INSERT INTO notification_preferences_new (id, notify_success, notify_failed, notify_needs_user_action, updated_at)
SELECT id, notify_success, notify_failed, notify_needs_user_action, updated_at FROM notification_preferences;

INSERT INTO push_subscriptions_new (id, encrypted_subscription, created_at, updated_at, last_success_at, consecutive_failures)
SELECT id, encrypted_subscription, created_at, updated_at, last_success_at, consecutive_failures FROM push_subscriptions;

INSERT INTO scheduled_sync_batches_new (id, schedule_key, notification_claimed_at, created_at, completed_at, is_baseline, assets_before_twd, credit_card_debt_before_twd, missing_currencies_before, assets_after_twd, credit_card_debt_after_twd, missing_currencies_after)
SELECT id, schedule_key, notification_claimed_at, created_at, completed_at, is_baseline, assets_before_twd, credit_card_debt_before_twd, missing_currencies_before, assets_after_twd, credit_card_debt_after_twd, missing_currencies_after FROM scheduled_sync_batches;

INSERT INTO sync_jobs_new (id, connector_id, scope, enabled, interval_minutes, next_run_at, locked_until, locked_by, lock_trigger, lock_scope, last_run_at, last_success_at, last_status, last_error, created_at, updated_at, schedule_mode, preferred_time, preferred_weekday)
SELECT id, connector_id, scope, enabled, interval_minutes, next_run_at, locked_until, locked_by, lock_trigger, lock_scope, last_run_at, last_success_at, last_status, last_error, created_at, updated_at, schedule_mode, preferred_time, preferred_weekday FROM sync_jobs;

INSERT INTO sync_schedule_settings_new (id, interval_minutes, preferred_time, timezone, updated_at, preferred_weekday)
SELECT id, interval_minutes, preferred_time, timezone, updated_at, preferred_weekday FROM sync_schedule_settings;

INSERT INTO tdcc_sync_run_items_new (id, run_id, task_type, task_key, account_id, page_cursor, next_page_cursor, page_number, task_json, payload_json, status, attempt_count, last_error, lease_token, lease_expires_at, created_at, updated_at, completed_at)
SELECT id, run_id, task_type, task_key, account_id, page_cursor, next_page_cursor, page_number, task_json, payload_json, status, attempt_count, last_error, lease_token, lease_expires_at, created_at, updated_at, completed_at FROM tdcc_sync_run_items;

INSERT INTO tdcc_sync_runs_new (id, connector_id, trigger, scope, sync_job_id, scheduled_batch_id, settings_version, phase, status, encrypted_config, encrypted_session, session_json, total_item_count, pending_item_count, processing_item_count, done_item_count, failed_item_count, session_refresh_count, last_error, lease_owner, lease_expires_at, created_at, updated_at, promoted_at, completed_at)
SELECT id, connector_id, trigger, scope, sync_job_id, scheduled_batch_id, settings_version, phase, status, encrypted_config, encrypted_session, session_json, total_item_count, pending_item_count, processing_item_count, done_item_count, failed_item_count, session_refresh_count, last_error, lease_owner, lease_expires_at, created_at, updated_at, promoted_at, completed_at FROM tdcc_sync_runs;

DROP TABLE bank_transaction_preferences;
DROP TABLE invoice_transaction_preferences;
DROP TABLE invoice_line_items;
DROP TABLE einvoice_sync_run_items;
DROP TABLE tdcc_sync_run_items;
DROP TABLE bank_balance_snapshots;
DROP TABLE bank_transactions;
DROP TABLE credit_card_bills;
DROP TABLE classification_overrides;
DROP TABLE classification_rules;
DROP TABLE einvoice_sync_runs;
DROP TABLE tdcc_sync_runs;
DROP TABLE investment_positions;
DROP TABLE investment_transactions;
DROP TABLE invoices;
DROP TABLE bank_accounts;
DROP TABLE classification_categories;
DROP TABLE connector_settings;
DROP TABLE exchange_rates;
DROP TABLE manual_assets;
DROP TABLE net_worth_history;
DROP TABLE notification_preferences;
DROP TABLE push_subscriptions;
DROP TABLE scheduled_sync_batches;
DROP TABLE sync_jobs;
DROP TABLE sync_schedule_settings;
ALTER TABLE bank_accounts_new RENAME TO bank_accounts;
ALTER TABLE bank_balance_snapshots_new RENAME TO bank_balance_snapshots;
ALTER TABLE bank_transaction_preferences_new RENAME TO bank_transaction_preferences;
ALTER TABLE bank_transactions_new RENAME TO bank_transactions;
ALTER TABLE classification_categories_new RENAME TO classification_categories;
ALTER TABLE classification_overrides_new RENAME TO classification_overrides;
ALTER TABLE classification_rules_new RENAME TO classification_rules;
ALTER TABLE connector_settings_new RENAME TO connector_settings;
ALTER TABLE credit_card_bills_new RENAME TO credit_card_bills;
ALTER TABLE einvoice_sync_run_items_new RENAME TO einvoice_sync_run_items;
ALTER TABLE einvoice_sync_runs_new RENAME TO einvoice_sync_runs;
ALTER TABLE exchange_rates_new RENAME TO exchange_rates;
ALTER TABLE investment_positions_new RENAME TO investment_positions;
ALTER TABLE investment_transactions_new RENAME TO investment_transactions;
ALTER TABLE invoice_line_items_new RENAME TO invoice_line_items;
ALTER TABLE invoice_transaction_preferences_new RENAME TO invoice_transaction_preferences;
ALTER TABLE invoices_new RENAME TO invoices;
ALTER TABLE manual_assets_new RENAME TO manual_assets;
ALTER TABLE net_worth_history_new RENAME TO net_worth_history;
ALTER TABLE notification_preferences_new RENAME TO notification_preferences;
ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;
ALTER TABLE scheduled_sync_batches_new RENAME TO scheduled_sync_batches;
ALTER TABLE sync_jobs_new RENAME TO sync_jobs;
ALTER TABLE sync_schedule_settings_new RENAME TO sync_schedule_settings;
ALTER TABLE tdcc_sync_run_items_new RENAME TO tdcc_sync_run_items;
ALTER TABLE tdcc_sync_runs_new RENAME TO tdcc_sync_runs;

CREATE TABLE scheduled_sync_batch_results (
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  status TEXT CHECK (status IN ('success', 'failed', 'needs_user_action')),
  completed_at TEXT, new_invoices INTEGER NOT NULL DEFAULT 0, new_bank_transactions INTEGER NOT NULL DEFAULT 0, new_investment_transactions INTEGER NOT NULL DEFAULT 0, recovered_at TEXT,
  PRIMARY KEY (batch_id, job_id),
  FOREIGN KEY (batch_id) REFERENCES scheduled_sync_batches(id) ON DELETE CASCADE
);
INSERT INTO scheduled_sync_batch_results (batch_id, job_id, connector_id, status, completed_at, new_invoices, new_bank_transactions, new_investment_transactions, recovered_at)
SELECT batch_id, job_id, connector_id, status, completed_at, new_invoices, new_bank_transactions, new_investment_transactions, recovered_at FROM _pk_migration_scheduled_sync_batch_results_backup;
DROP TABLE _pk_migration_scheduled_sync_batch_results_backup;

CREATE INDEX idx_bank_accounts_match
  ON bank_accounts (bank_code, account_last4, currency);
CREATE INDEX idx_bank_balance_snapshots_as_of
  ON bank_balance_snapshots (as_of_at);
CREATE INDEX idx_bank_balance_snapshots_account_as_of
  ON bank_balance_snapshots (account_id, as_of_at);
CREATE INDEX idx_bank_transaction_preferences_excluded
  ON bank_transaction_preferences (excluded_from_calculation);
CREATE UNIQUE INDEX idx_bank_transactions_matched_transaction
  ON bank_transactions(matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;
CREATE INDEX idx_bank_transactions_transaction_day
  ON bank_transactions (
    CASE
      WHEN length(authorized_at) > 10
        THEN COALESCE(
          date(authorized_at, '+8 hours'),
          substr(authorized_at, 1, 10)
        )
      ELSE substr(COALESCE(authorized_at, posted_date), 1, 10)
    END
  );
CREATE INDEX idx_bank_transactions_status
  ON bank_transactions (connector_id, account_id, status);
CREATE INDEX idx_bank_transactions_effective_updated
  ON bank_transactions (effective_date DESC, updated_at DESC, id DESC);
CREATE INDEX idx_bank_transactions_posted_date
  ON bank_transactions (posted_date);
CREATE INDEX idx_bank_transactions_account_posted_date
  ON bank_transactions (account_id, posted_date);
CREATE UNIQUE INDEX idx_classification_categories_label_nocase
  ON classification_categories (label COLLATE NOCASE);
CREATE INDEX idx_classification_overrides_category
  ON classification_overrides (category_id);
CREATE INDEX idx_classification_rules_category
  ON classification_rules (category_id);
CREATE INDEX idx_classification_rules_enabled_priority
  ON classification_rules (enabled, target_type, priority);
CREATE INDEX idx_credit_card_bills_page
  ON credit_card_bills (billing_period DESC, account_id ASC, id ASC);
CREATE INDEX idx_credit_card_bills_account_period
  ON credit_card_bills (account_id, billing_period);
CREATE INDEX idx_einvoice_sync_run_items_claim
  ON einvoice_sync_run_items (run_id, status, lease_expires_at, created_at);
CREATE INDEX idx_einvoice_sync_runs_completed
  ON einvoice_sync_runs (completed_at DESC);
CREATE UNIQUE INDEX idx_einvoice_sync_runs_one_active
  ON einvoice_sync_runs (connector_id)
  WHERE status IN ('queued', 'initializing', 'processing');
CREATE INDEX idx_investment_positions_page
  ON investment_positions (as_of_date DESC, asset_type ASC, name ASC, id ASC);
CREATE INDEX idx_investment_positions_latest_scope
  ON investment_positions (connector_id, asset_type, as_of_date DESC);
CREATE INDEX idx_investment_positions_asset_type
  ON investment_positions (asset_type);
CREATE INDEX idx_investment_positions_as_of_date
  ON investment_positions (as_of_date);
CREATE INDEX idx_investment_transactions_effective_updated
  ON investment_transactions (effective_date DESC, updated_at DESC, id DESC);
CREATE INDEX idx_investment_transactions_symbol
  ON investment_transactions (symbol);
CREATE INDEX idx_investment_transactions_trade_date
  ON investment_transactions (trade_date);
CREATE INDEX idx_invoice_line_items_invoice_source
  ON invoice_line_items (connector_id, invoice_source_id);
CREATE INDEX idx_invoice_line_items_invoice_id
  ON invoice_line_items (invoice_id);
CREATE UNIQUE INDEX idx_invoice_transaction_preferences_linked_transaction
  ON invoice_transaction_preferences (transaction_id)
  WHERE decision = 'linked';
CREATE INDEX idx_invoices_page
  ON invoices (invoice_date DESC, updated_at DESC, id DESC);
CREATE INDEX idx_invoices_invoice_date
  ON invoices (invoice_date);
CREATE INDEX idx_net_worth_history_page
  ON net_worth_history (date DESC, source ASC, asset_type ASC, id ASC);
CREATE INDEX idx_net_worth_history_date
  ON net_worth_history (date);
CREATE INDEX idx_scheduled_sync_batches_completed
  ON scheduled_sync_batches (completed_at DESC);
CREATE UNIQUE INDEX idx_scheduled_sync_batches_open
  ON scheduled_sync_batches (schedule_key)
  WHERE notification_claimed_at IS NULL;
CREATE INDEX idx_sync_jobs_due
  ON sync_jobs (enabled, next_run_at);
CREATE INDEX idx_tdcc_sync_run_items_account
  ON tdcc_sync_run_items (run_id, account_id, task_type, page_number);
CREATE INDEX idx_tdcc_sync_run_items_claim
  ON tdcc_sync_run_items (run_id, status, lease_expires_at, created_at);
CREATE INDEX idx_tdcc_sync_runs_completed
  ON tdcc_sync_runs (completed_at DESC);
CREATE UNIQUE INDEX idx_tdcc_sync_runs_one_active
  ON tdcc_sync_runs (connector_id)
  WHERE status IN ('queued', 'initializing', 'processing', 'promoting');