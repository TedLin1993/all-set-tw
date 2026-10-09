import {
  createDrizzle,
  connectorSettings,
  sanitizeDatabaseError,
} from "../../db";
import { eq } from "drizzle-orm";
import type { ConnectorId } from "@taiwan-fin-hub/shared";

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

export async function updateConnectorEncryptedConfigIfCurrent(
  db: D1Database,
  connectorId: ConnectorId,
  expectedEncryptedConfig: string,
  encryptedConfig: string,
) {
  const result = await db
    .prepare(
      `UPDATE connector_settings
       SET encrypted_config = ?
       WHERE connector_id = ? AND encrypted_config = ?`,
    )
    .bind(encryptedConfig, connectorId, expectedEncryptedConfig)
    .run();
  return result.meta.changes === 1;
}

export function connectorSettingsGuardStatement(
  db: D1Database,
  connectorId: ConnectorId,
  encryptedConfig: string,
  updatedAt: string,
) {
  // An invalid JSON branch aborts the entire atomic D1 promotion batch when
  // credentials/settings changed during the external bank request.
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
    SELECT 1 FROM connector_settings WHERE connector_id = ? AND encrypted_config = ? AND updated_at = ?
  ) THEN 1 ELSE json('connector settings changed') END AS valid`,
    )
    .bind(connectorId, encryptedConfig, updatedAt);
}

export async function compareAndSetConnectorSecret(
  db: D1Database,
  connectorId: ConnectorId,
  previous: { encrypted_config: string; updated_at: string },
  encryptedConfig: string,
  now: string,
) {
  const result = await db
    .prepare(
      `UPDATE connector_settings SET encrypted_config = ?, updated_at = ?
    WHERE connector_id = ? AND encrypted_config = ? AND updated_at = ?`,
    )
    .bind(
      encryptedConfig,
      now,
      connectorId,
      previous.encrypted_config,
      previous.updated_at,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new Error("連線設定已變更，請重新操作。");
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
  expectedEncryptedConfig?: string,
) {
  return db
    .prepare(
      `UPDATE connector_settings
    SET encrypted_config = ?, public_config = ?, sync_cursor = ?, updated_at = ?
    WHERE connector_id = ?${expectedEncryptedConfig === undefined ? "" : " AND encrypted_config = ?"}`,
    )
    .bind(
      encryptedConfig,
      publicConfig,
      cursor,
      now,
      connectorId,
      ...(expectedEncryptedConfig === undefined
        ? []
        : [expectedEncryptedConfig]),
    );
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

const DIRECT_DEPOSIT_CONNECTOR_IDS = [
  "esun",
  "cathaybk",
  "sinopac",
  "taishin",
  "ctbc",
  "skbank",
  "obank",
  "hncb",
  "firstbank",
  "kgibank",
  "megabank",
  "rakuten",
] as const satisfies readonly ConnectorId[];

export function linkCanonicalBankAccountsStatement(
  db: D1Database,
  settingsGuard?: { connectorId: ConnectorId; encryptedConfig: string },
) {
  const directConnectorPlaceholders = DIRECT_DEPOSIT_CONNECTOR_IDS.map(
    (_, index) => `?${index + 1}`,
  ).join(", ");
  const settingsGuardSql = settingsGuard
    ? ` AND EXISTS (
        SELECT 1 FROM connector_settings
        WHERE connector_id = ?${DIRECT_DEPOSIT_CONNECTOR_IDS.length + 1}
          AND encrypted_config = ?${DIRECT_DEPOSIT_CONNECTOR_IDS.length + 2}
      )`
    : "";
  return db
    .prepare(
      `UPDATE bank_accounts
    SET canonical_account_id = (
      SELECT direct.id FROM bank_accounts direct
      WHERE direct.connector_id IN (${directConnectorPlaceholders})
        AND direct.bank_code = bank_accounts.bank_code
        AND direct.account_last4 = bank_accounts.account_last4
        AND direct.currency = bank_accounts.currency
      ORDER BY direct.connector_id
      LIMIT 1
    )
    WHERE connector_id NOT IN (${directConnectorPlaceholders})
      AND bank_code IS NOT NULL
      AND account_last4 IS NOT NULL${settingsGuardSql}`,
    )
    .bind(
      ...DIRECT_DEPOSIT_CONNECTOR_IDS,
      ...(settingsGuard
        ? [settingsGuard.connectorId, settingsGuard.encryptedConfig]
        : []),
    );
}

export function deactivateMissingCathayLoanAccountsStatement(
  db: D1Database,
  activeSourceIds: readonly string[],
  now: string,
) {
  return db
    .prepare(
      `UPDATE bank_accounts
       SET inactive_at = ?, updated_at = ?
       WHERE connector_id = 'cathaybk'
         AND account_type = 'loan'
         AND source_id LIKE 'loan:cathaybk:%'
         AND inactive_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM json_each(?) active
           WHERE active.value = bank_accounts.source_id
         )`,
    )
    .bind(now, now, JSON.stringify(activeSourceIds));
}
