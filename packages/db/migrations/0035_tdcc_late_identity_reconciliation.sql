-- TDCC may add or change STAN after a transaction first appears. Use the
-- account-scoped semantic fields that remain stable across syncs instead.
CREATE TABLE migration_0035_tdcc_identity_targets (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  target_source_id TEXT NOT NULL
);

INSERT INTO migration_0035_tdcc_identity_targets (
  transaction_id,
  account_id,
  currency,
  target_source_id
)
WITH normalized AS (
  SELECT
    id,
    account_id,
    amount,
    currency,
    json_type(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.amount'
    ) AS raw_amount_type,
    json_type(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.occurredAt'
    ) AS raw_occurred_at_type,
    json_type(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.memo'
    ) AS raw_memo_type,
    trim(COALESCE(CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.amount'
    ) AS TEXT), '')) AS raw_amount_text,
    CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.amount'
    ) AS REAL) AS raw_amount,
    trim(COALESCE(CAST(json_extract(
      CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
      '$.occurredAt'
    ) AS TEXT), '')) AS raw_occurred_at,
    replace(replace(replace(replace(replace(replace(replace(replace(
      trim(COALESCE(CAST(json_extract(
        CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
        '$.memo'
      ) AS TEXT), '')),
      ' ', ''),
      char(9), ''),
      char(10), ''),
      char(11), ''),
      char(12), ''),
      char(13), ''),
      char(160), ''),
      char(12288), '') AS raw_memo
  FROM bank_transactions
  WHERE connector_id = 'tdcc'
), targets AS (
  SELECT
    id AS transaction_id,
    account_id,
    currency,
    'missing:' || raw_occurred_at || ':' || raw_amount_text || ':' ||
      COALESCE(NULLIF(raw_memo, ''), '-') AS target_source_id
  FROM normalized
  WHERE raw_amount_type IN ('integer', 'real', 'text')
    AND raw_occurred_at_type = 'text'
    AND COALESCE(raw_memo_type, 'null') IN ('text', 'null')
    AND raw_occurred_at <> ''
    AND raw_amount_text <> ''
    AND raw_amount_text GLOB '*[0-9]*'
    AND raw_amount_text NOT GLOB '*[^0-9.-]*'
    AND length(raw_amount_text) - length(replace(raw_amount_text, '.', '')) <= 1
    AND length(raw_amount_text) - length(replace(raw_amount_text, '-', '')) <= 1
    AND instr(substr(raw_amount_text, 2), '-') = 0
    AND raw_amount = amount
)
SELECT transaction_id, account_id, currency, target_source_id
FROM targets;

CREATE TABLE migration_0035_tdcc_identity_groups (
  account_id TEXT NOT NULL,
  target_source_id TEXT NOT NULL,
  survivor_id TEXT NOT NULL,
  PRIMARY KEY (account_id, target_source_id)
);

INSERT INTO migration_0035_tdcc_identity_groups (
  account_id,
  target_source_id,
  survivor_id
)
WITH ranked AS (
  SELECT
    target.account_id,
    target.target_source_id,
    target.transaction_id,
    ROW_NUMBER() OVER (
      PARTITION BY target.account_id, target.target_source_id
      ORDER BY
        CASE
          WHEN row_data.source_id = target.target_source_id THEN 0
          ELSE 1
        END,
        row_data.created_at DESC,
        row_data.id
    ) AS survivor_rank
  FROM migration_0035_tdcc_identity_targets target
  JOIN bank_transactions row_data
    ON row_data.id = target.transaction_id
)
SELECT account_id, target_source_id, transaction_id
FROM ranked
WHERE survivor_rank = 1;

-- Leave a semantic group untouched when its key is occupied by a row other
-- than the selected survivor, currencies disagree, or merging would overwrite
-- user decisions.
DELETE FROM migration_0035_tdcc_identity_groups
WHERE EXISTS (
  SELECT 1
  FROM bank_transactions destination
  WHERE destination.connector_id = 'tdcc'
    AND destination.account_id =
      migration_0035_tdcc_identity_groups.account_id
    AND destination.source_id =
      migration_0035_tdcc_identity_groups.target_source_id
    AND destination.id <>
      migration_0035_tdcc_identity_groups.survivor_id
);

DELETE FROM migration_0035_tdcc_identity_groups
WHERE (
  SELECT COUNT(DISTINCT target.currency)
  FROM migration_0035_tdcc_identity_targets target
  WHERE target.account_id = migration_0035_tdcc_identity_groups.account_id
    AND target.target_source_id =
      migration_0035_tdcc_identity_groups.target_source_id
) > 1;

DELETE FROM migration_0035_tdcc_identity_groups
WHERE (
  SELECT COUNT(*)
  FROM invoice_transaction_preferences preference
  JOIN migration_0035_tdcc_identity_targets target
    ON target.transaction_id = preference.transaction_id
  WHERE target.account_id = migration_0035_tdcc_identity_groups.account_id
    AND target.target_source_id =
      migration_0035_tdcc_identity_groups.target_source_id
    AND preference.decision = 'linked'
) > 1;

DELETE FROM migration_0035_tdcc_identity_groups
WHERE (
  SELECT COUNT(DISTINCT override.category_id)
  FROM classification_overrides override
  JOIN migration_0035_tdcc_identity_targets target
    ON target.transaction_id = override.target_id
  WHERE override.target_type = 'bank_transaction'
    AND target.account_id = migration_0035_tdcc_identity_groups.account_id
    AND target.target_source_id =
      migration_0035_tdcc_identity_groups.target_source_id
) > 1;

DELETE FROM migration_0035_tdcc_identity_groups
WHERE EXISTS (
  SELECT 1
  FROM classification_overrides override
  WHERE override.id =
      'override:bank_transaction:' ||
      migration_0035_tdcc_identity_groups.survivor_id
    AND (
      override.target_type <> 'bank_transaction'
      OR override.target_id <>
        migration_0035_tdcc_identity_groups.survivor_id
    )
);

INSERT INTO bank_transaction_preferences (
  transaction_id,
  excluded_from_calculation,
  created_at,
  updated_at
)
SELECT
  group_row.survivor_id,
  MAX(preference.excluded_from_calculation),
  MIN(preference.created_at),
  MAX(preference.updated_at)
FROM migration_0035_tdcc_identity_groups group_row
JOIN migration_0035_tdcc_identity_targets target
  ON target.account_id = group_row.account_id
 AND target.target_source_id = group_row.target_source_id
JOIN bank_transaction_preferences preference
  ON preference.transaction_id = target.transaction_id
GROUP BY group_row.survivor_id
ON CONFLICT(transaction_id) DO UPDATE SET
  excluded_from_calculation = MAX(
    bank_transaction_preferences.excluded_from_calculation,
    excluded.excluded_from_calculation
  ),
  created_at = MIN(bank_transaction_preferences.created_at, excluded.created_at),
  updated_at = MAX(bank_transaction_preferences.updated_at, excluded.updated_at);

INSERT OR IGNORE INTO classification_overrides (
  id,
  target_type,
  target_id,
  category_id,
  created_at,
  updated_at
)
SELECT
  'override:bank_transaction:' || group_row.survivor_id,
  'bank_transaction',
  group_row.survivor_id,
  MIN(override.category_id),
  MIN(override.created_at),
  MAX(override.updated_at)
FROM migration_0035_tdcc_identity_groups group_row
JOIN migration_0035_tdcc_identity_targets target
  ON target.account_id = group_row.account_id
 AND target.target_source_id = group_row.target_source_id
JOIN classification_overrides override
  ON override.target_type = 'bank_transaction'
 AND override.target_id = target.transaction_id
GROUP BY group_row.survivor_id;

UPDATE invoice_transaction_preferences
SET transaction_id = (
  SELECT group_row.survivor_id
  FROM migration_0035_tdcc_identity_targets target
  JOIN migration_0035_tdcc_identity_groups group_row
    ON group_row.account_id = target.account_id
   AND group_row.target_source_id = target.target_source_id
  WHERE target.transaction_id =
    invoice_transaction_preferences.transaction_id
)
WHERE transaction_id IN (
  SELECT target.transaction_id
  FROM migration_0035_tdcc_identity_targets target
  JOIN migration_0035_tdcc_identity_groups group_row
    ON group_row.account_id = target.account_id
   AND group_row.target_source_id = target.target_source_id
);

DELETE FROM bank_transaction_preferences
WHERE transaction_id IN (
  SELECT target.transaction_id
  FROM migration_0035_tdcc_identity_targets target
  JOIN migration_0035_tdcc_identity_groups group_row
    ON group_row.account_id = target.account_id
   AND group_row.target_source_id = target.target_source_id
  WHERE target.transaction_id <> group_row.survivor_id
);

DELETE FROM classification_overrides
WHERE target_type = 'bank_transaction'
  AND target_id IN (
    SELECT target.transaction_id
    FROM migration_0035_tdcc_identity_targets target
    JOIN migration_0035_tdcc_identity_groups group_row
      ON group_row.account_id = target.account_id
     AND group_row.target_source_id = target.target_source_id
    WHERE target.transaction_id <> group_row.survivor_id
  );

DELETE FROM bank_transactions
WHERE id IN (
  SELECT target.transaction_id
  FROM migration_0035_tdcc_identity_targets target
  JOIN migration_0035_tdcc_identity_groups group_row
    ON group_row.account_id = target.account_id
   AND group_row.target_source_id = target.target_source_id
  WHERE target.transaction_id <> group_row.survivor_id
);

UPDATE bank_transactions
SET source_id = (
  SELECT group_row.target_source_id
  FROM migration_0035_tdcc_identity_groups group_row
  WHERE group_row.survivor_id = bank_transactions.id
)
WHERE id IN (
  SELECT survivor_id FROM migration_0035_tdcc_identity_groups
);

DROP TABLE migration_0035_tdcc_identity_groups;
DROP TABLE migration_0035_tdcc_identity_targets;
