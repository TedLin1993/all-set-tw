CREATE TABLE migration_0033_tdcc_transaction_matches (
  legacy_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL
);

INSERT INTO migration_0033_tdcc_transaction_matches (legacy_id, canonical_id)
WITH normalized AS (
  SELECT
    id,
    connector_id,
    account_id,
    source_id,
    amount,
    currency,
    created_at,
    trim(CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.txnId'
    ) AS TEXT)) AS raw_txn_id,
    CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.amount'
    ) AS REAL) AS raw_amount,
    CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.occurredAt'
    ) AS TEXT) AS raw_occurred_at,
    replace(replace(replace(replace(
      trim(COALESCE(CAST(json_extract(
        CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
        '$.memo'
      ) AS TEXT), '')),
      ' ', ''), char(9), ''), char(10), ''), char(13), '') AS raw_memo
  FROM bank_transactions
  WHERE connector_id = 'tdcc'
), candidates AS (
  SELECT
    legacy.id AS legacy_id,
    canonical.id AS canonical_id,
    COUNT(*) OVER (PARTITION BY legacy.id) AS legacy_candidate_count,
    COUNT(*) OVER (PARTITION BY canonical.id) AS canonical_candidate_count
  FROM normalized legacy
  JOIN normalized canonical
    ON canonical.account_id = legacy.account_id
   AND canonical.id <> legacy.id
   AND canonical.source_id = canonical.raw_txn_id
   AND canonical.raw_txn_id <> ''
   AND instr(canonical.source_id, canonical.raw_occurred_at) > 0
   AND canonical.raw_occurred_at <> ''
   AND canonical.raw_occurred_at = legacy.raw_occurred_at
   AND canonical.raw_amount = legacy.raw_amount
   AND canonical.amount = legacy.amount
   AND canonical.currency = legacy.currency
   AND canonical.raw_memo = legacy.raw_memo
   AND canonical.created_at > legacy.created_at
  WHERE legacy.raw_txn_id <> ''
    AND legacy.source_id = legacy.raw_txn_id
    AND legacy.raw_occurred_at <> ''
    AND instr(legacy.source_id, legacy.raw_occurred_at) = 0
)
SELECT legacy_id, canonical_id
FROM candidates
WHERE legacy_candidate_count = 1
  AND canonical_candidate_count = 1;

-- Never merge two linked invoice decisions into one transaction.
DELETE FROM migration_0033_tdcc_transaction_matches
WHERE canonical_id IN (
  SELECT matches.canonical_id
  FROM migration_0033_tdcc_transaction_matches matches
  JOIN invoice_transaction_preferences legacy_preference
    ON legacy_preference.transaction_id = matches.legacy_id
   AND legacy_preference.decision = 'linked'
  GROUP BY matches.canonical_id
  HAVING COUNT(*) > 1
     OR EXISTS (
       SELECT 1
       FROM invoice_transaction_preferences canonical_preference
       WHERE canonical_preference.transaction_id = matches.canonical_id
         AND canonical_preference.decision = 'linked'
     )
);

-- Conflicting manual classifications are left for explicit user resolution.
DELETE FROM migration_0033_tdcc_transaction_matches
WHERE canonical_id IN (
  SELECT decisions.canonical_id
  FROM (
    SELECT matches.canonical_id, override.category_id
    FROM migration_0033_tdcc_transaction_matches matches
    JOIN classification_overrides override
      ON override.target_type = 'bank_transaction'
     AND override.target_id = matches.legacy_id
    UNION ALL
    SELECT matches.canonical_id, override.category_id
    FROM (
      SELECT DISTINCT canonical_id
      FROM migration_0033_tdcc_transaction_matches
    ) matches
    JOIN classification_overrides override
      ON override.target_type = 'bank_transaction'
     AND override.target_id = matches.canonical_id
  ) decisions
  GROUP BY decisions.canonical_id
  HAVING COUNT(DISTINCT decisions.category_id) > 1
);

INSERT INTO bank_transaction_preferences
  (transaction_id, excluded_from_calculation, created_at, updated_at)
SELECT
  matches.canonical_id,
  MAX(preference.excluded_from_calculation),
  MIN(preference.created_at),
  MAX(preference.updated_at)
FROM migration_0033_tdcc_transaction_matches matches
JOIN bank_transaction_preferences preference
  ON preference.transaction_id = matches.legacy_id
GROUP BY matches.canonical_id
HAVING COUNT(*) > 0
ON CONFLICT(transaction_id) DO UPDATE SET
  excluded_from_calculation = MAX(
    bank_transaction_preferences.excluded_from_calculation,
    excluded.excluded_from_calculation
  ),
  created_at = MIN(bank_transaction_preferences.created_at, excluded.created_at),
  updated_at = MAX(bank_transaction_preferences.updated_at, excluded.updated_at);

INSERT OR IGNORE INTO classification_overrides
  (id, target_type, target_id, category_id, created_at, updated_at)
SELECT
  'override:bank_transaction:' || matches.canonical_id,
  'bank_transaction',
  matches.canonical_id,
  MIN(override.category_id),
  MIN(override.created_at),
  MAX(override.updated_at)
FROM migration_0033_tdcc_transaction_matches matches
JOIN classification_overrides override
  ON override.target_type = 'bank_transaction'
 AND override.target_id = matches.legacy_id
GROUP BY matches.canonical_id;

UPDATE invoice_transaction_preferences
SET transaction_id = (
  SELECT matches.canonical_id
  FROM migration_0033_tdcc_transaction_matches matches
  WHERE matches.legacy_id = invoice_transaction_preferences.transaction_id
)
WHERE transaction_id IN (
  SELECT legacy_id FROM migration_0033_tdcc_transaction_matches
);

DELETE FROM bank_transaction_preferences
WHERE transaction_id IN (
  SELECT legacy_id FROM migration_0033_tdcc_transaction_matches
);

DELETE FROM classification_overrides
WHERE target_type = 'bank_transaction'
  AND target_id IN (
    SELECT legacy_id FROM migration_0033_tdcc_transaction_matches
  );

DELETE FROM bank_transactions
WHERE id IN (
  SELECT legacy_id FROM migration_0033_tdcc_transaction_matches
);

DROP TABLE migration_0033_tdcc_transaction_matches;
