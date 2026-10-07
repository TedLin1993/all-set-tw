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
