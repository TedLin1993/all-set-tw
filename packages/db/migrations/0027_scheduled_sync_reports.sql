ALTER TABLE scheduled_sync_batches
  ADD COLUMN completed_at TEXT;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN is_baseline INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN assets_before_twd INTEGER;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN credit_card_debt_before_twd INTEGER;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN missing_currencies_before TEXT NOT NULL DEFAULT '[]';

ALTER TABLE scheduled_sync_batches
  ADD COLUMN assets_after_twd INTEGER;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN credit_card_debt_after_twd INTEGER;

ALTER TABLE scheduled_sync_batches
  ADD COLUMN missing_currencies_after TEXT NOT NULL DEFAULT '[]';

ALTER TABLE scheduled_sync_batch_results
  ADD COLUMN new_invoices INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_sync_batch_results
  ADD COLUMN new_bank_transactions INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_sync_batch_results
  ADD COLUMN new_investment_transactions INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_scheduled_sync_batches_completed
  ON scheduled_sync_batches (completed_at DESC);
