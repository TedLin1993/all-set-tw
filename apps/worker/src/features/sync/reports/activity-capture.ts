import { supersededTdccTradeSql } from "../../../db";

/**
 * 報告層的去重只處理「兩邊都列進報告」的成交：集保買賣對得上永豐成交，而且永豐那筆
 * 已在報告的變化紀錄裡。永豐以未列入報告的方式匯入（例如手動同步、首次回補）時，
 * 集保那筆是報告裡唯一的紀錄，必須保留。
 */
const REPORTED_DIRECT_TRADE_SQL = `AND EXISTS (SELECT 1 FROM sync_activity_changes reported
  WHERE reported.entity_type = 'investment_transaction' AND reported.record_id = direct.id)`;
const REPORTED_DUPLICATE_TDCC_TRADE_SQL = supersededTdccTradeSql(
  (name) => `investment_transactions.${name}`,
  REPORTED_DIRECT_TRADE_SQL,
);
/** 同一條規則套用在尚未寫入的 staging payload（JSON 欄位名與資料表欄位相同）。 */
export const stagedReportedDuplicateTdccTradeSql = (payload: string) =>
  supersededTdccTradeSql(
    (name) => `json_extract(${payload}, '$.${name}')`,
    REPORTED_DIRECT_TRADE_SQL,
  );

/** Set-based journal writes share the promotion transaction and its lock owner. */
export function captureStagedActivityBefore(
  db: D1Database,
  stagingRunId: string,
  entities: Array<{
    entityType: string;
    table: string;
    conflictColumns: string[];
  }>,
) {
  const owner = `JOIN sync_jobs job ON job.connector_id = json_extract(staging.payload, '$.connector_id')
    JOIN sync_activity_runs run ON run.id = job.locked_by`;
  const statements = entities.map(({ entityType, table, conflictColumns }) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO sync_activity_changes
      (run_id, entity_type, record_id, change_kind, snapshot)
      SELECT run.id, staging.entity_type, json_extract(staging.payload, '$.id'), 'added', '{}'
      FROM sync_write_staging staging ${owner}
      WHERE staging.run_id = ? AND staging.entity_type = ?
        AND NOT EXISTS (SELECT 1 FROM ${table} target WHERE ${conflictColumns.map((c) => `target.${c} = json_extract(staging.payload, '$.${c}')`).join(" AND ")})`,
      )
      .bind(stagingRunId, entityType),
  );
  if (entities.some((e) => e.entityType === "bank_transaction")) {
    // Observe existing unmatched authorizations before lifecycle reconciliation.
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sync_activity_changes
      (run_id, entity_type, record_id, change_kind, snapshot)
      SELECT run.id, 'bank_transaction', txn.id, 'pending', '{}'
      FROM sync_activity_runs run JOIN sync_jobs job ON job.locked_by = run.id
      JOIN bank_transactions txn ON txn.connector_id = run.connector_id
      WHERE txn.status = 'pending' AND txn.matched_transaction_id IS NULL
        AND EXISTS (SELECT 1 FROM sync_write_staging staging WHERE staging.run_id = ?
          AND staging.entity_type = 'bank_transaction'
          AND json_extract(staging.payload, '$.connector_id') = run.connector_id)`,
        )
        .bind(stagingRunId),
    );
  }
  return statements;
}

export const bankActivitySnapshotSql = (t: string, a: string) => `json_object(
  'id', ${t}.id, 'connectorId', ${t}.connector_id, 'sourceId', ${t}.source_id,
  'accountId', ${t}.account_id, 'accountType', ${a}.account_type,
  'institutionName', ${a}.institution_name, 'accountName', ${a}.account_name,
  'accountLast4', ${a}.account_last4, 'amount', ${t}.amount, 'currency', ${t}.currency,
  'authorizedAt', ${t}.authorized_at, 'postedDate', ${t}.posted_date,
  'description', ${t}.description, 'counterparty', ${t}.counterparty, 'status', ${t}.status,
  'canonicalAccountId', ${a}.canonical_account_id)`;

export function captureStagedActivityAfter(
  db: D1Database,
  stagingRunId: string,
) {
  const runs = `SELECT DISTINCT job.locked_by FROM sync_write_staging staging
    JOIN sync_jobs job ON job.connector_id = json_extract(staging.payload, '$.connector_id')
    WHERE staging.run_id = ?`;
  return [
    db
      .prepare(
        `UPDATE sync_activity_runs SET captured_at = ? WHERE id IN (${runs})`,
      )
      .bind(new Date().toISOString(), stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET change_kind = 'posted'
      WHERE run_id IN (${runs}) AND entity_type = 'bank_transaction' AND change_kind = 'pending'
        AND EXISTS (SELECT 1 FROM bank_transactions t WHERE t.id = change.record_id
          AND (t.status = 'posted' OR t.matched_transaction_id IS NOT NULL))`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `DELETE FROM sync_activity_changes WHERE run_id IN (${runs}) AND change_kind = 'pending'`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT ${bankActivitySnapshotSql("t", "a")} FROM bank_transactions original
      JOIN bank_transactions t ON t.id = COALESCE(original.matched_transaction_id, original.id)
      JOIN bank_accounts a ON a.id = t.account_id WHERE original.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'bank_transaction'
      AND EXISTS (SELECT 1 FROM bank_transactions WHERE id = change.record_id)`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT json_object('id', i.id, 'invoiceDate', i.invoice_date, 'sellerName', i.seller_name,
        'invoiceNumber', i.invoice_number, 'amount', i.amount) FROM invoices i WHERE i.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'invoice'`,
      )
      .bind(stagingRunId),
    // 永豐那筆已列進報告的集保買賣不重複列為新增。
    db
      .prepare(
        `DELETE FROM sync_activity_changes WHERE run_id IN (${runs})
      AND entity_type = 'investment_transaction'
      AND EXISTS (SELECT 1 FROM investment_transactions
        WHERE investment_transactions.id = sync_activity_changes.record_id
          AND ${REPORTED_DUPLICATE_TDCC_TRADE_SQL})`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `UPDATE sync_activity_changes AS change SET snapshot = (
      SELECT json_object('id', t.id, 'name', t.name, 'symbol', t.symbol, 'tradeDate', t.trade_date,
        'postedDate', t.posted_date, 'transactionName', t.transaction_name, 'transactionCode', t.transaction_code,
        'quantity', t.quantity, 'price', t.price, 'amount', t.amount, 'currency', t.currency)
      FROM investment_transactions t WHERE t.id = change.record_id
    ) WHERE run_id IN (${runs}) AND entity_type = 'investment_transaction'`,
      )
      .bind(stagingRunId),
    db
      .prepare(
        `DELETE FROM sync_activity_changes WHERE run_id IN (${runs}) AND snapshot = '{}'`,
      )
      .bind(stagingRunId),
  ];
}

const DUPLICATE_TDCC_CHANGE_SQL = `change.entity_type = 'investment_transaction'
  AND EXISTS (SELECT 1 FROM investment_transactions
    WHERE investment_transactions.id = change.record_id
      AND ${REPORTED_DUPLICATE_TDCC_TRADE_SQL})`;

/**
 * 集保比永豐先同步到的成交，要等永豐寫入後才對得上。投資交易 promotion 後回頭把
 * 先前報告裡與永豐重複的集保買賣移除：先扣新增筆數，再刪展示快照與變化紀錄，
 * 讓同一筆成交只留在永豐的報告。本次集保 run 自己的重複列已由
 * captureStagedActivityAfter 移除且未計入筆數，不會在這裡被重複扣除。
 */
export function removeDuplicateTdccReportActivity(db: D1Database) {
  return [
    db.prepare(
      `UPDATE scheduled_sync_batch_results AS result
      SET new_investment_transactions = MAX(0, new_investment_transactions - (
        SELECT COUNT(*) FROM sync_activity_changes change
        JOIN sync_activity_runs run ON run.id = change.run_id
        WHERE run.batch_id = result.batch_id AND run.connector_id = result.connector_id
          AND ${DUPLICATE_TDCC_CHANGE_SQL}))
      WHERE connector_id = 'tdcc' AND new_investment_transactions > 0`,
    ),
    db.prepare(
      `DELETE FROM sync_activity_details
      WHERE activity_id LIKE 'investment:%'
        AND EXISTS (SELECT 1 FROM investment_transactions
          WHERE investment_transactions.id = substr(sync_activity_details.activity_id, 12)
            AND ${REPORTED_DUPLICATE_TDCC_TRADE_SQL})`,
    ),
    db.prepare(
      `DELETE FROM sync_activity_changes AS change WHERE ${DUPLICATE_TDCC_CHANGE_SQL}`,
    ),
  ];
}
