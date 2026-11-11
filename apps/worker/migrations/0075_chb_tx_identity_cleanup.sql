-- Clean up duplicate CHB deposit rows produced across sync batches when
-- transactionTime shifted slightly under the v1 sourceId formula.
CREATE TABLE migration_0075_chb_candidates (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  survivor_priority INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO migration_0075_chb_candidates (
  transaction_id,
  account_id,
  currency,
  semantic_key,
  survivor_priority,
  created_at
)
WITH base AS (
  SELECT
    t.id,
    t.account_id,
    t.source_id,
    t.currency,
    COALESCE(t.posted_date, '') AS posted_date,
    CAST(ROUND(t.amount * 100) AS INTEGER) AS amount_cents,
    trim(replace(COALESCE(t.description, ''), char(9), ' ')) AS desc_norm,
    CASE WHEN json_valid(t.raw_payload) THEN t.raw_payload ELSE '{}' END AS valid_raw,
    t.created_at
  FROM bank_transactions t
  WHERE t.connector_id = 'chb'
    AND (
      t.source_id LIKE 'chb:deposit:tx:v1:%'
      OR t.source_id LIKE 'chb:deposit:tx:v2:%'
    )
), extracted AS (
  SELECT
    id,
    account_id,
    source_id,
    currency,
    posted_date,
    amount_cents,
    desc_norm,
    CAST(ROUND(CAST(json_extract(valid_raw, '$.balanceAfter') AS REAL) * 100) AS INTEGER) AS bal_cents,
    CASE
      WHEN COALESCE(json_extract(valid_raw, '$.adjustment'), 0) IN (1, 'true') THEN 1
      ELSE 0
    END AS adj_flag,
    created_at
  FROM base
  WHERE posted_date <> ''
    AND json_type(valid_raw, '$.balanceAfter') IN ('integer', 'real')
), sequenced AS (
  SELECT
    id,
    account_id,
    source_id,
    currency,
    posted_date,
    amount_cents,
    desc_norm,
    bal_cents,
    adj_flag,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, posted_date, currency, amount_cents, desc_norm, bal_cents, adj_flag, created_at
      ORDER BY source_id, id
    ) AS batch_seq
  FROM extracted
)
SELECT
  id AS transaction_id,
  account_id,
  currency,
  account_id || '|' || posted_date || '|' || currency || '|' || amount_cents
    || '|' || bal_cents || '|' || adj_flag || '|' || batch_seq || '|' || desc_norm AS semantic_key,
  CASE
    WHEN source_id LIKE 'chb:deposit:tx:v2:%' THEN 0
    WHEN EXISTS (
      SELECT 1 FROM classification_overrides o
      WHERE o.target_type = 'bank_transaction' AND o.target_id = sequenced.id
    ) OR EXISTS (
      SELECT 1 FROM bank_transaction_preferences p
      WHERE p.transaction_id = sequenced.id
    ) OR EXISTS (
      SELECT 1 FROM invoice_transaction_preferences ip
      WHERE ip.transaction_id = sequenced.id AND ip.decision = 'linked'
    ) THEN 1
    ELSE 2
  END AS survivor_priority,
  created_at
FROM sequenced;

CREATE TABLE migration_0075_chb_groups (
  semantic_key TEXT PRIMARY KEY,
  survivor_id TEXT NOT NULL
);

INSERT INTO migration_0075_chb_groups (
  semantic_key,
  survivor_id
)
WITH ranked AS (
  SELECT
    semantic_key,
    transaction_id,
    ROW_NUMBER() OVER (
      PARTITION BY semantic_key
      ORDER BY survivor_priority ASC, created_at ASC, transaction_id ASC
    ) AS rank_in_group
  FROM migration_0075_chb_candidates
)
SELECT semantic_key, transaction_id
FROM ranked
WHERE rank_in_group = 1;

-- Skip singletons and any group whose deletion or metadata merge would conflict.
DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(*)
  FROM migration_0075_chb_candidates c
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
) < 2;

DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(DISTINCT c.currency)
  FROM migration_0075_chb_candidates c
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
) > 1;

DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(*)
  FROM invoice_transaction_preferences ip
  JOIN migration_0075_chb_candidates c ON c.transaction_id = ip.transaction_id
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
    AND ip.decision = 'linked'
) > 1;

DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(DISTINCT o.category_id)
  FROM classification_overrides o
  JOIN migration_0075_chb_candidates c ON c.transaction_id = o.target_id
  WHERE o.target_type = 'bank_transaction'
    AND c.semantic_key = migration_0075_chb_groups.semantic_key
) > 1;

DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(DISTINCT p.excluded_from_calculation)
  FROM bank_transaction_preferences p
  JOIN migration_0075_chb_candidates c ON c.transaction_id = p.transaction_id
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
    AND p.excluded_from_calculation IS NOT NULL
) > 1;

DELETE FROM migration_0075_chb_groups
WHERE (
  SELECT COUNT(DISTINCT p.note)
  FROM bank_transaction_preferences p
  JOIN migration_0075_chb_candidates c ON c.transaction_id = p.transaction_id
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
    AND p.note IS NOT NULL
) > 1;

DELETE FROM migration_0075_chb_groups
WHERE EXISTS (
  SELECT 1
  FROM classification_overrides o
  WHERE o.id = 'override:bank_transaction:' || migration_0075_chb_groups.survivor_id
    AND (
      o.target_type <> 'bank_transaction'
      OR o.target_id <> migration_0075_chb_groups.survivor_id
    )
);

DELETE FROM migration_0075_chb_groups
WHERE EXISTS (
  SELECT 1
  FROM migration_0075_chb_candidates c
  JOIN bank_transactions ref
    ON ref.transfer_peer_id = c.transaction_id
    OR ref.matched_transaction_id = c.transaction_id
  WHERE c.semantic_key = migration_0075_chb_groups.semantic_key
    AND c.transaction_id <> migration_0075_chb_groups.survivor_id
);

INSERT INTO bank_transaction_preferences (
  transaction_id,
  excluded_from_calculation,
  created_at,
  updated_at,
  note
)
SELECT
  g.survivor_id,
  MAX(p.excluded_from_calculation),
  MIN(p.created_at),
  MAX(p.updated_at),
  MAX(p.note)
FROM migration_0075_chb_groups g
JOIN migration_0075_chb_candidates c ON c.semantic_key = g.semantic_key
JOIN bank_transaction_preferences p ON p.transaction_id = c.transaction_id
GROUP BY g.survivor_id
ON CONFLICT(transaction_id) DO UPDATE SET
  excluded_from_calculation = COALESCE(bank_transaction_preferences.excluded_from_calculation, excluded.excluded_from_calculation),
  created_at = MIN(bank_transaction_preferences.created_at, excluded.created_at),
  updated_at = MAX(bank_transaction_preferences.updated_at, excluded.updated_at),
  note = COALESCE(bank_transaction_preferences.note, excluded.note);

INSERT OR IGNORE INTO classification_overrides (
  id,
  target_type,
  target_id,
  category_id,
  created_at,
  updated_at
)
SELECT
  'override:bank_transaction:' || g.survivor_id,
  'bank_transaction',
  g.survivor_id,
  MIN(o.category_id),
  MIN(o.created_at),
  MAX(o.updated_at)
FROM migration_0075_chb_groups g
JOIN migration_0075_chb_candidates c ON c.semantic_key = g.semantic_key
JOIN classification_overrides o
  ON o.target_type = 'bank_transaction'
 AND o.target_id = c.transaction_id
GROUP BY g.survivor_id;

INSERT OR IGNORE INTO ai_classifications (
  transaction_id,
  category_id,
  probability,
  input_hash,
  model,
  created_at,
  updated_at
)
WITH ranked_ai AS (
  SELECT
    g.survivor_id,
    a.category_id,
    a.probability,
    a.input_hash,
    a.model,
    a.created_at,
    a.updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY g.survivor_id
      ORDER BY a.updated_at DESC, a.transaction_id ASC
    ) AS rn
  FROM migration_0075_chb_groups g
  JOIN migration_0075_chb_candidates c ON c.semantic_key = g.semantic_key
  JOIN ai_classifications a ON a.transaction_id = c.transaction_id
)
SELECT
  survivor_id,
  category_id,
  probability,
  input_hash,
  model,
  created_at,
  updated_at
FROM ranked_ai
WHERE rn = 1;

UPDATE invoice_transaction_preferences
SET transaction_id = (
  SELECT g.survivor_id
  FROM migration_0075_chb_candidates c
  JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
  WHERE c.transaction_id = invoice_transaction_preferences.transaction_id
)
WHERE transaction_id IN (
  SELECT c.transaction_id
  FROM migration_0075_chb_candidates c
  JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
);

DELETE FROM ai_classifications
WHERE transaction_id IN (
  SELECT c.transaction_id
  FROM migration_0075_chb_candidates c
  JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
  WHERE c.transaction_id <> g.survivor_id
);

DELETE FROM bank_transaction_preferences
WHERE transaction_id IN (
  SELECT c.transaction_id
  FROM migration_0075_chb_candidates c
  JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
  WHERE c.transaction_id <> g.survivor_id
);

DELETE FROM classification_overrides
WHERE target_type = 'bank_transaction'
  AND target_id IN (
    SELECT c.transaction_id
    FROM migration_0075_chb_candidates c
    JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
    WHERE c.transaction_id <> g.survivor_id
  );

DELETE FROM bank_transactions
WHERE id IN (
  SELECT c.transaction_id
  FROM migration_0075_chb_candidates c
  JOIN migration_0075_chb_groups g ON g.semantic_key = c.semantic_key
  WHERE c.transaction_id <> g.survivor_id
);

DROP TABLE migration_0075_chb_groups;
DROP TABLE migration_0075_chb_candidates;
