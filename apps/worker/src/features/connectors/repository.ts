import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { getConnectorSettings, upsertConnectorSettings } from "../../db";

export function findConnectorSettings(
  db: D1Database,
  connectorId: ConnectorId,
) {
  return getConnectorSettings(db, connectorId);
}

export function saveConnectorSettings(
  db: D1Database,
  input: {
    id: string;
    connectorId: ConnectorId;
    encryptedConfig: string;
    publicConfig: string | null;
    now: string;
  },
) {
  return upsertConnectorSettings(db, input);
}

// 解除連結保留原生 SQL：同步中 guard、跨表引用清理與刪除必須在同一個 D1 batch，
// 筆數預覽也共用下列範圍子查詢，才會與實際刪除的筆數一致。?1 一律為 connectorId。
const ACCOUNT_IDS = "SELECT id FROM bank_accounts WHERE connector_id = ?1";
// 也包含寫在這個來源帳戶下的列，否則外鍵會擋下刪除帳戶。
const ACCOUNT_DATA_SCOPE = `(connector_id = ?1 OR account_id IN (${ACCOUNT_IDS}))`;
const TRANSACTION_IDS = `SELECT id FROM bank_transactions WHERE ${ACCOUNT_DATA_SCOPE}`;
const INVOICE_IDS = "SELECT id FROM invoices WHERE connector_id = ?1";
// 其他來源合併到這個來源帳戶的帳戶；刪除資料時解除合併，改為獨立計算。
const MERGED_ACCOUNT_IDS = `SELECT id FROM bank_accounts WHERE connector_id != ?1 AND canonical_account_id IN (${ACCOUNT_IDS})`;

// 與 `GET /api/sync-jobs` 的 running 相同：有效的 connector lock、電子發票與集保的
// active run，或排隊中的背景手動同步。?2 為現在時間。
const SYNC_RUNNING = `(
  EXISTS (SELECT 1 FROM sync_jobs WHERE connector_id = ?1 AND locked_until > ?2)
  OR EXISTS (SELECT 1 FROM einvoice_sync_runs WHERE connector_id = ?1 AND status IN ('queued', 'initializing', 'processing'))
  OR EXISTS (SELECT 1 FROM tdcc_sync_runs WHERE connector_id = ?1 AND status IN ('queued', 'initializing', 'processing', 'promoting'))
  OR EXISTS (SELECT 1 FROM manual_sync_runs WHERE connector_id = ?1 AND status = 'queued')
)`;

export async function isConnectorSyncRunning(
  db: D1Database,
  connectorId: ConnectorId,
  now: string,
) {
  const row = await db
    .prepare(`SELECT ${SYNC_RUNNING} AS running`)
    .bind(connectorId, now)
    .first<{ running: number }>();
  return Boolean(row?.running);
}

/** 與同步的 owner guard 相同：同步中時以無效 JSON 中止整個 batch，檢查與刪除位於同一個 transaction。 */
export function connectorIdleGuardStatement(
  db: D1Database,
  connectorId: ConnectorId,
  now: string,
) {
  return db
    .prepare(
      `SELECT CASE WHEN ${SYNC_RUNNING} THEN json('connector sync running') ELSE 1 END AS valid`,
    )
    .bind(connectorId, now);
}

export async function countConnectorData(
  db: D1Database,
  connectorId: ConnectorId,
) {
  const row = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM bank_accounts WHERE connector_id = ?1) AS accounts,
        (SELECT COUNT(*) FROM bank_transactions WHERE ${ACCOUNT_DATA_SCOPE}) AS transactions,
        (SELECT COUNT(*) FROM bank_balance_snapshots WHERE ${ACCOUNT_DATA_SCOPE}) AS balanceSnapshots,
        (SELECT COUNT(*) FROM credit_card_bills WHERE ${ACCOUNT_DATA_SCOPE}) AS creditCardBills,
        (SELECT COUNT(*) FROM invoices WHERE connector_id = ?1) AS invoices,
        (SELECT COUNT(*) FROM investment_positions WHERE connector_id = ?1) AS investmentPositions,
        (SELECT COUNT(*) FROM investment_transactions WHERE connector_id = ?1) AS investmentTransactions,
        (SELECT COUNT(*) FROM classification_overrides
          WHERE target_type = 'bank_transaction' AND target_id IN (${TRANSACTION_IDS})) AS categoryOverrides,
        (SELECT COUNT(*) FROM bank_transaction_preferences
          WHERE transaction_id IN (${TRANSACTION_IDS})) AS transactionPreferences,
        (SELECT COUNT(*) FROM invoice_transaction_preferences
          WHERE invoice_id IN (${INVOICE_IDS}) OR transaction_id IN (${TRANSACTION_IDS})) AS invoiceLinks,
        (SELECT COUNT(*) FROM bank_account_payment_accounts
          WHERE account_id IN (${ACCOUNT_IDS}) OR payment_account_id IN (${ACCOUNT_IDS})) AS paymentAccounts`,
    )
    .bind(connectorId)
    .first<Record<string, number>>();
  return row ?? {};
}

/**
 * 刪除資料後存款歷史的重算起日：被刪帳戶與解除合併的帳戶中最早的餘額日期。
 * 解除合併的帳戶改為計入存款，它們較早的日期也要重算；兩者都沒有餘額時存款不變，不需重算。
 */
export async function findConnectorBalanceStartDate(
  db: D1Database,
  connectorId: ConnectorId,
) {
  const row = await db
    .prepare(
      `SELECT MIN(substr(as_of_at, 1, 10)) AS date FROM bank_balance_snapshots
       WHERE ${ACCOUNT_DATA_SCOPE} OR account_id IN (${MERGED_ACCOUNT_IDS})`,
    )
    .bind(connectorId)
    .first<{ date: string | null }>();
  return row?.date ?? null;
}

/**
 * 刪除這個來源同步進來的資料。順序依外鍵安排：先清掉其他來源與使用者決定對這些交易、
 * 帳戶的引用，再刪除資料；交易引用的處理與刪除手動記錄相同。
 */
export function connectorDataDeletionStatements(
  db: D1Database,
  connectorId: ConnectorId,
  now: string,
) {
  const scoped = (query: string) => db.prepare(query).bind(connectorId);
  const stamped = (query: string) => db.prepare(query).bind(connectorId, now);
  return [
    stamped(
      `UPDATE bank_transactions SET transfer_peer_id = NULL, updated_at = ?2
       WHERE transfer_peer_id IN (${TRANSACTION_IDS}) AND NOT ${ACCOUNT_DATA_SCOPE}`,
    ),
    stamped(
      `UPDATE bank_transactions SET matched_transaction_id = NULL, updated_at = ?2
       WHERE matched_transaction_id IN (${TRANSACTION_IDS}) AND NOT ${ACCOUNT_DATA_SCOPE}`,
    ),
    // 「保持分開」的決定保留但清掉交易引用；已連結的發票回到自動配對。
    stamped(
      `UPDATE invoice_transaction_preferences SET transaction_id = NULL, updated_at = ?2
       WHERE decision = 'separate' AND transaction_id IN (${TRANSACTION_IDS})
         AND invoice_id NOT IN (${INVOICE_IDS})`,
    ),
    scoped(
      `DELETE FROM invoice_transaction_preferences
       WHERE invoice_id IN (${INVOICE_IDS}) OR transaction_id IN (${TRANSACTION_IDS})`,
    ),
    scoped(
      `DELETE FROM bank_transaction_preferences WHERE transaction_id IN (${TRANSACTION_IDS})`,
    ),
    scoped(
      `DELETE FROM classification_overrides
       WHERE target_type = 'bank_transaction' AND target_id IN (${TRANSACTION_IDS})`,
    ),
    scoped(
      `DELETE FROM ai_classifications WHERE transaction_id IN (${TRANSACTION_IDS})`,
    ),
    scoped(`DELETE FROM bank_transactions WHERE ${ACCOUNT_DATA_SCOPE}`),
    scoped(`DELETE FROM bank_balance_snapshots WHERE ${ACCOUNT_DATA_SCOPE}`),
    scoped(`DELETE FROM credit_card_bills WHERE ${ACCOUNT_DATA_SCOPE}`),
    // 扣款帳戶設定不設 FK；刪掉後改回銀行資料，重新連結時不會悄悄恢復舊設定。
    scoped(
      `DELETE FROM bank_account_payment_accounts
       WHERE account_id IN (${ACCOUNT_IDS}) OR payment_account_id IN (${ACCOUNT_IDS})`,
    ),
    // 其他來源合併到這些帳戶的帳戶改為獨立計算；該來源下次同步時會重新比對。
    stamped(
      `UPDATE bank_accounts SET canonical_account_id = NULL, updated_at = ?2
       WHERE connector_id != ?1 AND canonical_account_id IN (${ACCOUNT_IDS})`,
    ),
    scoped("DELETE FROM bank_accounts WHERE connector_id = ?1"),
    scoped(
      `DELETE FROM invoice_line_items WHERE connector_id = ?1 OR invoice_id IN (${INVOICE_IDS})`,
    ),
    scoped("DELETE FROM invoices WHERE connector_id = ?1"),
    scoped("DELETE FROM investment_transactions WHERE connector_id = ?1"),
    scoped("DELETE FROM investment_positions WHERE connector_id = ?1"),
    scoped("DELETE FROM net_worth_history WHERE source = ?1"),
    // 報告明細的快照是資料內容的副本（changes／details 隨外鍵刪除）；
    // 排程批次的資產總額為跨來源加總，無法拆分而保留。
    scoped("DELETE FROM sync_activity_runs WHERE connector_id = ?1"),
    scoped("DELETE FROM scheduled_sync_batch_results WHERE connector_id = ?1"),
  ];
}

/** 刪除憑證並讓來源回到尚未連結的狀態；已同步的資料不受影響。 */
export function connectorUnlinkStatements(
  db: D1Database,
  connectorId: ConnectorId,
  now: string,
) {
  const scoped = (query: string) => db.prepare(query).bind(connectorId);
  return [
    // 電子發票與集保的 run 保存憑證與 session 副本；items 隨外鍵刪除。
    scoped("DELETE FROM einvoice_sync_runs WHERE connector_id = ?1"),
    scoped("DELETE FROM tdcc_sync_runs WHERE connector_id = ?1"),
    scoped("DELETE FROM manual_sync_runs WHERE connector_id = ?1"),
    // 重新連結後比照新來源：首次同步成功才開啟排程，也不沿用舊的錯誤狀態。
    db
      .prepare(
        `UPDATE sync_jobs SET enabled = 0,
           locked_until = NULL, locked_by = NULL, lock_trigger = NULL, lock_scope = NULL, lock_phase = NULL,
           last_run_at = NULL, last_success_at = NULL, last_status = NULL,
           last_error = NULL, last_error_code = NULL, updated_at = ?2
         WHERE connector_id = ?1`,
      )
      .bind(connectorId, now),
    scoped("DELETE FROM connector_settings WHERE connector_id = ?1"),
  ];
}
