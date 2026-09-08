ALTER TABLE bank_accounts ADD COLUMN opened_date TEXT;
ALTER TABLE bank_accounts ADD COLUMN maturity_date TEXT;
-- Observation time, not the bank's actual settlement date.
ALTER TABLE bank_accounts ADD COLUMN inactive_at TEXT;
ALTER TABLE bank_transactions ADD COLUMN transfer_peer_id TEXT;
