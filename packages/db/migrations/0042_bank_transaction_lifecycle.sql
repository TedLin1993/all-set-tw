ALTER TABLE bank_transactions ADD COLUMN matched_transaction_id TEXT;
CREATE UNIQUE INDEX idx_bank_transactions_matched_transaction
  ON bank_transactions(matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;
