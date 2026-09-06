-- Keep the activity date semantics indexable: authorized timestamps use Taipei
-- calendar days, while date-only or legacy posted values keep their stored day.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_transaction_day
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
