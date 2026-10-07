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

/** 舊版繳款列（識別碼含卡號）併入新版 `:payment:` 列，保留使用者的偏好、分類與發票連結。 */
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
        AND legacy.source_id NOT LIKE 'sinopac:card:tx:v2:%:payment:%'
        AND canonical.source_id LIKE 'sinopac:card:tx:v2:%:payment:%'
    ) WHERE legacy_rank = 1`;
  return Array.from({ length: SINOPAC_CARD_PAYMENT_MERGE_ROUNDS }, () =>
    mergeLegacyTransactionStatements(db, candidates),
  ).flat();
}

/**
 * 舊版以關鍵字判斷方向而記錯正負號的已入帳列，併入依銀行正負號重寫的新列。
 * 金額是識別碼的一部分，方向改正後會產生新列；兩列來自同一筆銀行明細（原始金額、摘要、
 * 日期、帳戶都相同），只有記錄的正負號相反，留下與銀行原始正負號一致的那一列。
 */
export function reconcileSinopacCardSignStatements(db: D1Database) {
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT legacy.id AS old_id, canonical.id AS new_id
    FROM bank_transactions legacy
    JOIN bank_transactions canonical
      ON canonical.connector_id = legacy.connector_id
      AND canonical.account_id = legacy.account_id
      AND canonical.currency = legacy.currency
      AND canonical.amount = -legacy.amount
      AND canonical.posted_date = legacy.posted_date
      AND COALESCE(canonical.description, '') = COALESCE(legacy.description, '')
      AND json_extract(canonical.raw_payload, '$.AMT')
        = json_extract(legacy.raw_payload, '$.AMT')
    WHERE legacy.connector_id = 'sinopac'
      AND legacy.status = 'posted'
      AND canonical.status = 'posted'
      AND legacy.source_id LIKE 'sinopac:card:tx:v2:%'
      AND canonical.source_id LIKE 'sinopac:card:tx:v2:%'
      AND (json_extract(canonical.raw_payload, '$.AMT') LIKE '-%')
        = (canonical.amount > 0)`,
  );
}
