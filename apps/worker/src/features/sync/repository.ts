import {
  createDrizzle,
  connectorSettings,
  sanitizeDatabaseError,
} from "@taiwan-fin-hub/db";
import { eq } from "drizzle-orm";
import { mergeLegacyTransactionStatements } from "./transaction-merge";
import type { ConnectorId } from "@taiwan-fin-hub/core";

export async function updateConnectorEncryptedConfig(
  db: D1Database,
  connectorId: ConnectorId,
  encryptedConfig: string,
) {
  await createDrizzle(db)
    .update(connectorSettings)
    .set({ encryptedConfig })
    .where(eq(connectorSettings.connectorId, connectorId))
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}

// 以下 statement factories 保留原生 D1：service 將設定、cursor 與 lifecycle
// reconciliation 併入 persistence 的單一 promotion batch，不可各自 await。
export function connectorEncryptedConfigStatement(
  db: D1Database,
  connectorId: ConnectorId,
  encryptedConfig: string,
  publicConfig: string | null,
  now: string,
) {
  return db
    .prepare(
      `UPDATE connector_settings
    SET encrypted_config = ?, public_config = ?, updated_at = ?
    WHERE connector_id = ?`,
    )
    .bind(encryptedConfig, publicConfig, now, connectorId);
}

export function connectorStateStatement(
  db: D1Database,
  connectorId: ConnectorId,
  encryptedConfig: string,
  publicConfig: string | null,
  cursor: string,
  now: string,
) {
  return db
    .prepare(
      `UPDATE connector_settings
    SET encrypted_config = ?, public_config = ?, sync_cursor = ?, updated_at = ?
    WHERE connector_id = ?`,
    )
    .bind(encryptedConfig, publicConfig, cursor, now, connectorId);
}

export function connectorCursorStatement(
  db: D1Database,
  connectorId: ConnectorId,
  cursor: string,
  now: string,
) {
  return db
    .prepare(
      `UPDATE connector_settings
    SET sync_cursor = ?, updated_at = ?
    WHERE connector_id = ?`,
    )
    .bind(cursor, now, connectorId);
}

export function reconcileEsunLifecycleShadowStatements(db: D1Database) {
  const shadowJoin = `canonical.connector_id = shadow.connector_id
      AND canonical.account_id = shadow.account_id
      AND canonical.source_id = replace(
        replace(shadow.source_id, ':已入帳:', ':'),
        ':未入帳:', ':'
      )`;
  const isLifecycleShadow = `shadow.connector_id = 'esun'
      AND (instr(shadow.source_id, ':已入帳:') > 0 OR instr(shadow.source_id, ':未入帳:') > 0)`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT shadow.id AS old_id, canonical.id AS new_id
    FROM bank_transactions shadow
    JOIN bank_transactions canonical ON ${shadowJoin}
    WHERE ${isLifecycleShadow}`,
  );
}

export function reconcileEsunSingleCardSummaryAccountStatements(
  db: D1Database,
) {
  return reconcileSingleCardSummaryAccountStatements(db, "esun");
}

export function reconcileHncbSingleCardSummaryAccountStatements(
  db: D1Database,
) {
  return reconcileSingleCardSummaryAccountStatements(db, "hncb");
}

// 早期同步在讀不到卡號末四碼時會寫入 credit:<connector>:main 摘要帳戶；
// 之後解析出實體卡就會多出一筆孤兒帳戶，只有單張卡時可以安全併回實體卡。
function reconcileSingleCardSummaryAccountStatements(
  db: D1Database,
  connectorId: "esun" | "hncb",
) {
  const mainAccountId = `(SELECT id FROM bank_accounts
    WHERE connector_id = '${connectorId}' AND source_id = 'credit:${connectorId}:main')`;
  const physicalAccountFilter = `connector_id = '${connectorId}'
    AND account_type = 'credit'
    AND source_id LIKE 'credit:${connectorId}:%'
    AND source_id <> 'credit:${connectorId}:main'
    AND canonical_account_id IS NULL`;
  const physicalAccountId = `(SELECT id FROM bank_accounts
    WHERE ${physicalAccountFilter}
    ORDER BY id
    LIMIT 1)`;
  const hasSinglePhysicalCard = `(SELECT COUNT(*) FROM bank_accounts
    WHERE ${physicalAccountFilter}) = 1`;

  return [
    db.prepare(
      `DELETE FROM credit_card_bills
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND EXISTS (
           SELECT 1 FROM credit_card_bills current
           WHERE current.account_id = ${physicalAccountId}
             AND current.billing_period = credit_card_bills.billing_period
         )`,
    ),
    db.prepare(
      `DELETE FROM bank_balance_snapshots
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND EXISTS (
           SELECT 1 FROM bank_balance_snapshots current
           WHERE current.account_id = ${physicalAccountId}
             AND current.source_id = bank_balance_snapshots.source_id
         )`,
    ),
    ...mergeLegacyTransactionStatements(
      db,
      `
      SELECT shadow.id AS old_id, canonical.id AS new_id
      FROM bank_transactions shadow
      JOIN bank_transactions canonical
        ON canonical.connector_id = shadow.connector_id
       AND canonical.account_id = ${physicalAccountId}
       AND canonical.source_id = shadow.source_id
      WHERE shadow.connector_id = '${connectorId}'
        AND shadow.account_id = ${mainAccountId}
        AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE credit_card_bills
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE bank_balance_snapshots
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}`,
    ),
    db.prepare(
      `UPDATE bank_transactions
       SET account_id = ${physicalAccountId}
       WHERE account_id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND NOT EXISTS (
           SELECT 1 FROM bank_transactions current
           WHERE current.connector_id = bank_transactions.connector_id
             AND current.account_id = ${physicalAccountId}
             AND current.source_id = bank_transactions.source_id
         )`,
    ),
    db.prepare(
      `DELETE FROM bank_accounts
       WHERE id = ${mainAccountId}
         AND ${hasSinglePhysicalCard}
         AND NOT EXISTS (
           SELECT 1 FROM bank_balance_snapshots
           WHERE account_id = bank_accounts.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM bank_transactions
           WHERE account_id = bank_accounts.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM credit_card_bills
           WHERE account_id = bank_accounts.id
         )`,
    ),
  ];
}

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

export function reconcileHncbLegacyTransactionStatements(db: D1Database) {
  const match = `canonical.connector_id = legacy.connector_id
      AND canonical.account_id = legacy.account_id
      AND (
        substr(canonical.authorized_at, 1, 10) = substr(legacy.authorized_at, 1, 10)
        OR substr(canonical.authorized_at, 1, 10) = substr(legacy.posted_date, 1, 10)
        OR substr(canonical.posted_date, 1, 10) = substr(legacy.posted_date, 1, 10)
        OR substr(canonical.posted_date, 1, 10) = substr(legacy.authorized_at, 1, 10)
      )
      AND canonical.amount = legacy.amount
      AND canonical.currency = legacy.currency`;
  return mergeLegacyTransactionStatements(
    db,
    `
    SELECT legacy.id AS old_id, canonical.id AS new_id
    FROM bank_transactions legacy
    JOIN bank_transactions canonical ON ${match}
    WHERE legacy.connector_id = 'hncb'
      AND legacy.source_id LIKE 'hncb:card:tx:%'
      AND legacy.source_id NOT LIKE 'hncb:card:tx:v2:%'
      AND canonical.source_id LIKE 'hncb:card:tx:v2:%'
      `,
  );
}

export function linkCanonicalBankAccountsStatement(db: D1Database) {
  return db.prepare(
    `UPDATE bank_accounts
    SET canonical_account_id = (
      SELECT direct.id FROM bank_accounts direct
      WHERE direct.connector_id IN ('esun', 'cathaybk', 'ctbc', 'skbank', 'obank', 'hncb', 'firstbank', 'kgibank')
        AND direct.bank_code = bank_accounts.bank_code
        AND direct.account_last4 = bank_accounts.account_last4
        AND direct.currency = bank_accounts.currency
      ORDER BY direct.connector_id
      LIMIT 1
    )
    WHERE connector_id NOT IN ('esun', 'cathaybk', 'ctbc', 'skbank', 'obank', 'hncb', 'firstbank', 'kgibank')
      AND bank_code IS NOT NULL
      AND account_last4 IS NOT NULL`,
  );
}
