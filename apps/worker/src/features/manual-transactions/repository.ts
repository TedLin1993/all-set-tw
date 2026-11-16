import { MANUAL_ACCOUNT_ID, MANUAL_CONNECTOR_ID } from "@taiwan-fin-hub/shared";

const ACCOUNT_SOURCE_ID = "cash";
const BALANCE_SNAPSHOT_ID = `${MANUAL_ACCOUNT_ID}:balance`;
const OVERRIDE_TARGET_TYPE = "bank_transaction";

export type ManualTransactionRow = {
  id: string;
  sourceId: string;
  date: string;
  /** 已帶正負號的新台幣金額。 */
  amount: number;
  description: string;
  type: string;
  excludedFromCalculation: boolean;
  /** undefined 保留原分類，null 移除手動分類。 */
  categoryId?: string | null;
  /** undefined 保留原備註，null 清除。 */
  note?: string | null;
};

export type ManualBalanceAdjustment = {
  id: string;
  sourceId: string;
  date: string;
  target: number;
};

/** 已存在的手動記錄與它們目前的日期；更新日期時原日期也要重算歷史。 */
export async function listExistingManualTransactionDates(
  db: D1Database,
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, string>();
  const { results } = await db
    .prepare(
      `SELECT id, posted_date AS date FROM bank_transactions
       WHERE connector_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
    .bind(MANUAL_CONNECTOR_ID, JSON.stringify(ids))
    .all<{ id: string; date: string }>();
  return new Map(results.map((row) => [row.id, row.date]));
}

/**
 * 交易、分類、備註、餘額調整與餘額快照在同一個 batch 寫入，
 * 每一天的現金餘額因此永遠等於到當天為止的手動記錄加總。
 */
export async function writeManualTransactions(
  db: D1Database,
  rows: ManualTransactionRow[],
  adjustment: ManualBalanceAdjustment | undefined,
  now: string,
) {
  const statements = [
    db
      .prepare(
        `INSERT INTO bank_accounts (id, connector_id, source_id, institution_name, account_name, account_type, currency, created_at, updated_at)
         VALUES (?, ?, ?, '手動記錄', '現金', 'stored_value', 'TWD', ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        MANUAL_ACCOUNT_ID,
        MANUAL_CONNECTOR_ID,
        ACCOUNT_SOURCE_ID,
        now,
        now,
      ),
    ...rows.flatMap((row) => transactionStatements(db, row, now)),
    ...(adjustment ? adjustmentStatements(db, adjustment, now) : []),
    ...balanceSnapshotStatements(db, now),
    balanceQuery(db),
    db
      .prepare(`SELECT amount FROM bank_transactions WHERE id = ?`)
      .bind(adjustment?.id ?? ""),
  ];
  const results = await db.batch<{ balance?: number; amount?: number }>(
    statements,
  );
  return {
    balance: results.at(-2)?.results[0]?.balance ?? 0,
    adjustmentAmount: results.at(-1)?.results[0]?.amount,
  };
}

function transactionStatements(
  db: D1Database,
  row: ManualTransactionRow,
  now: string,
) {
  const statements = [
    db
      .prepare(
        `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, raw_payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'TWD', ?, ?, 'posted', ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           posted_date = excluded.posted_date,
           amount = excluded.amount,
           description = excluded.description,
           raw_payload = excluded.raw_payload,
           updated_at = excluded.updated_at`,
      )
      .bind(
        row.id,
        MANUAL_CONNECTOR_ID,
        MANUAL_ACCOUNT_ID,
        row.sourceId,
        row.date,
        row.amount,
        row.description,
        JSON.stringify({ type: row.type }),
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (transaction_id) DO UPDATE SET
           excluded_from_calculation = excluded.excluded_from_calculation,
           note = CASE WHEN ? = 1 THEN excluded.note ELSE note END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        row.id,
        row.excludedFromCalculation ? 1 : 0,
        row.note ?? null,
        now,
        now,
        row.note === undefined ? 0 : 1,
      ),
  ];
  if (row.categoryId === null) {
    statements.push(deleteOverrideStatement(db, row.id));
  } else if (row.categoryId !== undefined) {
    statements.push(
      overrideStatement(db, row.id, row.categoryId, now),
      // 分類改由使用者指定後，先前的 AI 分類不再適用。
      db
        .prepare(`DELETE FROM ai_classifications WHERE transaction_id = ?`)
        .bind(row.id),
    );
  }
  return statements;
}

/** 差額為 0 時不寫入任何資料。 */
function adjustmentStatements(
  db: D1Database,
  adjustment: ManualBalanceAdjustment,
  now: string,
) {
  const exists = `EXISTS (SELECT 1 FROM bank_transactions WHERE id = ?)`;
  return [
    db
      .prepare(
        `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, raw_payload, status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, diff, 'TWD', '餘額調整', '{"type":"adjustment"}', 'posted', ?, ?
         FROM (
           SELECT ? - COALESCE(SUM(amount), 0) AS diff
           FROM bank_transactions WHERE account_id = ?
         )
         WHERE diff <> 0`,
      )
      .bind(
        adjustment.id,
        MANUAL_CONNECTOR_ID,
        MANUAL_ACCOUNT_ID,
        adjustment.sourceId,
        adjustment.date,
        now,
        now,
        adjustment.target,
        MANUAL_ACCOUNT_ID,
      ),
    db
      .prepare(
        `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
         SELECT ?, 1, ?, ? WHERE ${exists}`,
      )
      .bind(adjustment.id, now, now, adjustment.id),
    // 手動分類讓餘額調整不會與同日同額的銀行交易自動配成互轉。
    db
      .prepare(
        `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
         SELECT ?, ?, ?, 'transfer', ?, ? WHERE ${exists}`,
      )
      .bind(
        overrideId(adjustment.id),
        OVERRIDE_TARGET_TYPE,
        adjustment.id,
        now,
        now,
        adjustment.id,
      ),
  ];
}

export async function findManualTransactionDate(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT posted_date AS date FROM bank_transactions WHERE id = ? AND connector_id = ?`,
    )
    .bind(id, MANUAL_CONNECTOR_ID)
    .first<{ date: string }>();
  return row?.date;
}

export async function deleteManualTransaction(
  db: D1Database,
  id: string,
  now: string,
) {
  const results = await db.batch<{ balance?: number }>([
    deleteOverrideStatement(db, id),
    db
      .prepare(`DELETE FROM ai_classifications WHERE transaction_id = ?`)
      .bind(id),
    db
      .prepare(
        `DELETE FROM bank_transaction_preferences WHERE transaction_id = ?`,
      )
      .bind(id),
    // 「保持分開」是對發票的決定，交易刪除後仍然有效，只解除對交易的引用。
    db
      .prepare(
        `UPDATE invoice_transaction_preferences SET transaction_id = NULL, updated_at = ?
         WHERE transaction_id = ? AND decision = 'separate'`,
      )
      .bind(now, id),
    // 已連結的發票回到自動配對，之後單獨計入支出。
    db
      .prepare(
        `DELETE FROM invoice_transaction_preferences
         WHERE transaction_id = ? AND decision = 'linked'`,
      )
      .bind(id),
    db
      .prepare(
        `DELETE FROM bank_transactions WHERE id = ? AND connector_id = ?`,
      )
      .bind(id, MANUAL_CONNECTOR_ID),
    ...balanceSnapshotStatements(db, now),
    balanceQuery(db),
  ]);
  return results.at(-1)?.results[0]?.balance ?? 0;
}

const overrideId = (transactionId: string) =>
  `override:${OVERRIDE_TARGET_TYPE}:${transactionId}`;

function overrideStatement(
  db: D1Database,
  transactionId: string,
  categoryId: string,
  now: string,
) {
  return db
    .prepare(
      `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id) DO UPDATE SET
         category_id = excluded.category_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      overrideId(transactionId),
      OVERRIDE_TARGET_TYPE,
      transactionId,
      categoryId,
      now,
      now,
    );
}

function deleteOverrideStatement(db: D1Database, transactionId: string) {
  return db
    .prepare(
      `DELETE FROM classification_overrides WHERE target_type = ? AND target_id = ?`,
    )
    .bind(OVERRIDE_TARGET_TYPE, transactionId);
}

/**
 * 每個有記錄的日期各一列快照，餘額是到當天為止的累計，
 * 補記過去日期或重建歷史淨值時，各日期才讀得到當時的現金。
 */
function balanceSnapshotStatements(db: D1Database, now: string) {
  const columns = `id, connector_id, account_id, source_id, balance, currency, as_of_at, created_at, updated_at`;
  return [
    db
      .prepare(`DELETE FROM bank_balance_snapshots WHERE account_id = ?`)
      .bind(MANUAL_ACCOUNT_ID),
    db
      .prepare(
        `INSERT INTO bank_balance_snapshots (${columns})
         SELECT ? || ':' || posted_date, ?, ?, ? || ':' || posted_date,
           SUM(SUM(amount)) OVER (ORDER BY posted_date), 'TWD',
           posted_date || 'T00:00:00.000Z', ?, ?
         FROM bank_transactions WHERE account_id = ?
         GROUP BY posted_date`,
      )
      .bind(
        BALANCE_SNAPSHOT_ID,
        MANUAL_CONNECTOR_ID,
        MANUAL_ACCOUNT_ID,
        ACCOUNT_SOURCE_ID,
        now,
        now,
        MANUAL_ACCOUNT_ID,
      ),
    // 記錄全數刪除後，帳戶仍顯示 0 而不是沒有餘額。
    db
      .prepare(
        `INSERT INTO bank_balance_snapshots (${columns})
         SELECT ?, ?, ?, ?, 0, 'TWD', ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM bank_transactions WHERE account_id = ?)`,
      )
      .bind(
        BALANCE_SNAPSHOT_ID,
        MANUAL_CONNECTOR_ID,
        MANUAL_ACCOUNT_ID,
        ACCOUNT_SOURCE_ID,
        now,
        now,
        now,
        MANUAL_ACCOUNT_ID,
      ),
  ];
}

function balanceQuery(db: D1Database) {
  return db
    .prepare(
      `SELECT balance FROM bank_balance_snapshots WHERE account_id = ?
       ORDER BY as_of_at DESC LIMIT 1`,
    )
    .bind(MANUAL_ACCOUNT_ID);
}
