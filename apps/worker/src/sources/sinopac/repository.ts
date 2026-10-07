import { mergeLegacyTransactionStatements } from "../../features/sync/transaction-merge";

export function reconcileSinopacLegacyTransactionStatements(db: D1Database) {
  const match = `canonical.connector_id = legacy.connector_id
      AND canonical.account_id = legacy.account_id
      AND (
        substr(canonical.authorized_at, 1, 10) = substr(legacy.posted_date, 1, 10)
        OR substr(canonical.posted_date, 1, 10) = substr(legacy.posted_date, 1, 10)
      )
      AND canonical.amount = legacy.amount
      AND canonical.currency = legacy.currency
      AND COALESCE(canonical.description, '') = COALESCE(legacy.description, '')`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT legacy.id AS old_id, canonical.id AS new_id
    FROM bank_transactions legacy
    JOIN bank_transactions canonical ON ${match}
    WHERE legacy.connector_id = 'sinopac'
      AND legacy.source_id LIKE 'sinopac:card:tx:%'
      AND legacy.source_id NOT LIKE 'sinopac:card:tx:v2:%'
      AND canonical.source_id LIKE 'sinopac:card:tx:v2:%'
      AND canonical.status = 'posted'`,
  );
}

// 一張帳單的繳款可能在不同次同步被掛在不同張卡下，同一筆繳款因此留下多筆舊列；
// 每輪只把最舊的一筆併入，重複數輪就能收斂（合併要求一對一）。
const SINOPAC_CARD_PAYMENT_MERGE_ROUNDS = 3;

/**
 * 舊版繳款列（識別碼含卡號，或尚未含摘要雜湊的 `:payment:`）併入新版 `:payment-<雜湊>:` 列，
 * 保留使用者的偏好、分類與發票關係。
 */
export function reconcileSinopacCardPaymentStatements(db: D1Database) {
  const candidates = `
    SELECT old_id, new_id FROM (
      SELECT legacy.id AS old_id, canonical.id AS new_id,
        ROW_NUMBER() OVER (
          PARTITION BY canonical.id ORDER BY legacy.created_at, legacy.id
        ) AS legacy_rank
      FROM bank_transactions legacy
      JOIN bank_transactions canonical
        ON canonical.connector_id = legacy.connector_id
        AND canonical.account_id = legacy.account_id
        AND substr(COALESCE(canonical.authorized_at, canonical.posted_date), 1, 10)
          = substr(COALESCE(legacy.authorized_at, legacy.posted_date), 1, 10)
        AND canonical.amount = legacy.amount
        AND canonical.currency = legacy.currency
        AND COALESCE(canonical.description, '') = COALESCE(legacy.description, '')
      WHERE legacy.connector_id = 'sinopac'
        AND legacy.amount > 0
        AND legacy.source_id LIKE 'sinopac:card:tx:v2:%'
        AND legacy.source_id NOT LIKE 'sinopac:card:tx:v2:%:payment-%'
        AND canonical.source_id LIKE 'sinopac:card:tx:v2:%:payment-%'
    ) WHERE legacy_rank = 1`;
  return Array.from({ length: SINOPAC_CARD_PAYMENT_MERGE_ROUNDS }, () =>
    mergeLegacyTransactionStatements(db, candidates),
  ).flat();
}

// 一筆銀行明細的身分只取銀行原始欄位：已入帳為卡號末四碼、消費日、原始金額（AMT，沒有時 TXAMT）、
// 幣別代碼與摘要；授權為卡號、授權日、授權時間、授權金額與摘要。缺卡號或日期時為 NULL，不參與合併。
const SINOPAC_CARD_IDENTITY = `CASE WHEN json_valid(raw_payload) THEN
    CASE WHEN status = 'posted' THEN 'posted|'
      || COALESCE(NULLIF(json_extract(raw_payload, '$.CardNoLast4'), ''),
        NULLIF(json_extract(raw_payload, '$.CardLast4'), '')) || '|'
      || json_extract(raw_payload, '$.TXDATE') || '|'
      || COALESCE(NULLIF(json_extract(raw_payload, '$.AMT'), ''),
        NULLIF(json_extract(raw_payload, '$.TXAMT'), '')) || '|'
      || COALESCE(json_extract(raw_payload, '$.CurrencyCode'),
        json_extract(raw_payload, '$.TXCUR'), '') || '|'
      || COALESCE(json_extract(raw_payload, '$.MEMO'), '')
    ELSE 'pending|'
      || NULLIF(json_extract(raw_payload, '$.CardNo'), '') || '|'
      || json_extract(raw_payload, '$.AuthDate') || '|'
      || COALESCE(json_extract(raw_payload, '$.AuthTime'), '') || '|'
      || COALESCE(NULLIF(json_extract(raw_payload, '$.AuthAmt'), ''),
        NULLIF(json_extract(raw_payload, '$.AuthAmtDesc'), '')) || '|'
      || COALESCE(json_extract(raw_payload, '$.Memo'), '')
    END
  END`;

/**
 * 同一筆銀行明細留下的過期列，併入這次同步寫入的列（`updated_at` 等於這次同步時間）。
 *
 * 金額與序號都是識別碼的一部分：方向判斷改正後金額正負號改變、同組序號重排，同一筆明細就會
 * 換成新識別碼，原本的列不再被寫入。過期列與這次寫入的列身分相同（見 SINOPAC_CARD_IDENTITY），
 * 依序號在同身分內一對一配對，同卡同日同店的多筆同額交易也各自配對。
 *
 * 必須排在授權寫入之後：授權寫入會把配對設回同步前讀到的交易 ID，合併再把它改指向留下的列。
 */
export function reconcileSinopacCardStaleStatements(
  db: D1Database,
  syncedAt: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(syncedAt)) {
    throw new Error("同步時間格式不正確。");
  }
  const ranked = `(
      SELECT id, account_id, status, identity, fresh,
        ROW_NUMBER() OVER (
          PARTITION BY account_id, status, identity, fresh
          ORDER BY occurrence, created_at, id
        ) AS identity_rank
      FROM (
        SELECT id, account_id, status, created_at,
          json_extract(raw_payload, '$.duplicateOccurrence') AS occurrence,
          ${SINOPAC_CARD_IDENTITY} AS identity,
          updated_at = '${syncedAt}' AS fresh
        FROM bank_transactions
        WHERE connector_id = 'sinopac' AND source_id LIKE 'sinopac:card:tx:v2:%'
      )
      WHERE identity IS NOT NULL
    )`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT stale.id AS old_id, current.id AS new_id
    FROM ${ranked} stale
    JOIN ${ranked} current
      ON current.account_id = stale.account_id
      AND current.status = stale.status
      AND current.identity = stale.identity
      AND current.identity_rank = stale.identity_rank
    WHERE stale.fresh = 0 AND current.fresh = 1`,
  );
}
