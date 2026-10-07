ALTER TABLE bank_accounts ADD COLUMN loan_category TEXT CHECK (loan_category IS NULL OR loan_category IN ('housing', 'other'));
ALTER TABLE bank_accounts ADD COLUMN loan_interest_rate REAL;
ALTER TABLE bank_balance_snapshots ADD COLUMN loan_payment_amount INTEGER;
ALTER TABLE bank_balance_snapshots ADD COLUMN loan_payment_status TEXT CHECK (loan_payment_status IS NULL OR loan_payment_status IN ('scheduled', 'collection_incomplete'));
ALTER TABLE bank_balance_snapshots ADD COLUMN loan_installments_paid INTEGER;
ALTER TABLE bank_balance_snapshots ADD COLUMN loan_installments_total INTEGER;
