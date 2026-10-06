/**
 * 兆豐存款交易 sourceId 的寫入時對帳。
 *
 * 舊版 sourceId 的雜湊含 serialNo／seq，但這兩欄其實是「當天的交易順序」：同一天稍後又有新交易
 * 入帳時，先前交易的順序欄位會變，導致同一筆被當成新交易重複寫入。新版 sourceId 不再含這兩欄，
 * 但公式一改，所有既有列的 sourceId 都跟新算出來的不同，若不處理，下一次同步會把所有既有存款交易
 * 再寫一遍。
 *
 * 作法是在寫入前把「新格式 sourceId」換成既有列的舊 sourceId：同帳戶、同日、同金額、同摘要的
 * 既有列視為同一筆，沿用其 sourceId，寫入路徑（conflict on connector_id + account_id + source_id）
 * 就會 UPDATE 既有列，而不是新增。既有列的 id、created_at 與使用者偏好、分類覆寫、發票關聯
 * 全部保持原樣；舊列永遠保留舊 sourceId，只有新交易使用新格式。這裡不刪除、也不改寫任何既有列。
 *
 * log 只記錄筆數，不含金額、摘要或帳號。
 */

export const MEGABANK_DEPOSIT_SOURCE_ID_PREFIX = "megabank:deposit:tx:";

/** 輸入交易需要的欄位（`accountId` 是帳戶 sourceId）。 */
export type MegabankIncomingDeposit = {
  accountId: string;
  sourceId: string;
  postedDate?: string | null;
  amount: number;
  description?: string | null;
};

/** 資料庫既有的兆豐存款交易（`accountId` 已對應成帳戶 sourceId）。 */
export type MegabankExistingDeposit = {
  id: string;
  accountId: string;
  sourceId: string;
  postedDate: string | null;
  amount: number;
  description: string | null;
  createdAt: string;
};

function matchKey(row: {
  accountId: string;
  postedDate?: string | null;
  amount: number;
  description?: string | null;
}) {
  return JSON.stringify([
    row.accountId,
    row.postedDate ?? "",
    row.amount,
    row.description ?? "",
  ]);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * 回傳與輸入同順序的交易（未對應到舊列的原樣保留），以及被改回舊 sourceId 的筆數。
 * 輸入物件不會被修改；非兆豐存款格式的 sourceId（信用卡等）原樣保留。
 */
export function reconcileMegabankDepositSourceIds<
  T extends MegabankIncomingDeposit,
>(
  incoming: readonly T[],
  existing: readonly MegabankExistingDeposit[],
): { transactions: T[]; remapped: number } {
  const bySourceId = new Map<string, MegabankExistingDeposit>();
  const byMatchKey = new Map<string, MegabankExistingDeposit[]>();
  for (const row of existing) {
    bySourceId.set(`${row.accountId}\u0000${row.sourceId}`, row);
    const key = matchKey(row);
    const bucket = byMatchKey.get(key);
    if (bucket) bucket.push(row);
    else byMatchKey.set(key, [row]);
  }
  // 最舊的既有列優先被認領；created_at 相同時以 id 決定，確保結果可重現。
  for (const bucket of byMatchKey.values()) {
    bucket.sort(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.id, right.id),
    );
  }

  const claimed = new Set<string>();
  const candidates: number[] = [];
  incoming.forEach((row, index) => {
    if (!row.sourceId.startsWith(MEGABANK_DEPOSIT_SOURCE_ID_PREFIX)) return;
    const exact = bySourceId.get(`${row.accountId}\u0000${row.sourceId}`);
    if (exact) claimed.add(exact.id);
    else candidates.push(index);
  });

  candidates.sort((left, right) => {
    const a = incoming[left]!;
    const b = incoming[right]!;
    return (
      compareText(matchKey(a), matchKey(b)) ||
      compareText(a.sourceId, b.sourceId) ||
      left - right
    );
  });

  const transactions = [...incoming];
  let remapped = 0;
  for (const index of candidates) {
    const row = incoming[index]!;
    const match = byMatchKey
      .get(matchKey(row))
      ?.find((candidate) => !claimed.has(candidate.id));
    if (!match) continue;
    claimed.add(match.id);
    transactions[index] = { ...row, sourceId: match.sourceId };
    remapped += 1;
  }
  return { transactions, remapped };
}

/** 載入涵蓋輸入日期範圍的既有兆豐存款交易（只讀）。 */
export async function loadExistingMegabankDeposits(
  db: D1Database,
  incoming: readonly MegabankIncomingDeposit[],
): Promise<MegabankExistingDeposit[]> {
  const dates = incoming
    .filter((row) => row.sourceId.startsWith(MEGABANK_DEPOSIT_SOURCE_ID_PREFIX))
    .map((row) => row.postedDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  if (dates.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT t.id AS id, a.source_id AS accountId, t.source_id AS sourceId,
              t.posted_date AS postedDate, t.amount AS amount,
              t.description AS description, t.created_at AS createdAt
       FROM bank_transactions t
       JOIN bank_accounts a ON a.id = t.account_id
       WHERE t.connector_id = 'megabank'
         AND t.source_id LIKE 'megabank:deposit:tx:%'
         AND t.posted_date BETWEEN ? AND ?`,
    )
    .bind(dates[0], dates[dates.length - 1])
    .all<MegabankExistingDeposit>();
  return result.results;
}

/** 同步寫入前的入口：載入既有列並把新格式 sourceId 換回舊 sourceId。 */
export async function reconcileMegabankDeposits<
  T extends MegabankIncomingDeposit,
>(db: D1Database, incoming: readonly T[]): Promise<T[]> {
  const existing = await loadExistingMegabankDeposits(db, incoming);
  const { transactions, remapped } = reconcileMegabankDepositSourceIds(
    incoming,
    existing,
  );
  if (remapped > 0) {
    console.log(
      JSON.stringify({ event: "megabank_tx_source_reconciled", remapped }),
    );
  }
  return transactions;
}
