-- Physical card identity for transactions in a shared credit-card account.
-- Connectors fill these normalized display fields during sync; they are not
-- part of transaction identity, matching or liability calculations.
ALTER TABLE bank_transactions ADD COLUMN card_last4 TEXT;
ALTER TABLE bank_transactions ADD COLUMN card_name TEXT;
