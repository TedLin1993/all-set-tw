export type NetWorthPageCursor = {
  date: string;
  source: string;
  assetType: string;
  id: string;
};

export async function listNetWorthChartHistory(db: D1Database) {
  const result = await db
    .prepare(
      `SELECT
         history.date,
         CASE
           WHEN history.source != 'manual' OR asset.currency = 'TWD'
             THEN history.net_worth
           WHEN rate.rate_to_twd IS NOT NULL
             THEN history.net_worth * rate.rate_to_twd
           ELSE 0
         END AS netWorth,
         history.asset_type AS assetType,
         history.source
       FROM net_worth_history history
       LEFT JOIN manual_assets asset
         ON history.source = 'manual' AND asset.id = history.asset_type
       LEFT JOIN exchange_rates rate ON rate.currency = asset.currency
       WHERE history.source = 'manual'
          OR (history.source = 'bank' AND history.asset_type = 'deposit')
          OR history.asset_type IN ('stock', 'fund')
       ORDER BY
         history.date ASC,
         history.source ASC,
         history.asset_type ASC,
         history.id ASC`,
    )
    .all<{
      date: string;
      netWorth: number;
      assetType: string;
      source: string;
    }>();
  return result.results;
}

export async function listNetWorthHistory(
  db: D1Database,
  limit: number,
  cursor?: NetWorthPageCursor,
) {
  const cursorClause = cursor
    ? `WHERE (
        date < ?
        OR (
          date = ?
          AND (source, asset_type, id) > (?, ?, ?)
        )
      )`
    : "";
  const statement = db.prepare(
    `SELECT id, date, net_worth AS netWorth, asset_type AS assetType, source
     FROM net_worth_history
     ${cursorClause}
     ORDER BY date DESC, source ASC, asset_type ASC, id ASC
     LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(
          cursor.date,
          cursor.date,
          cursor.source,
          cursor.assetType,
          cursor.id,
          limit,
        )
      : statement.bind(limit)
  ).all<{
    id: string;
    date: string;
    netWorth: number;
    assetType: string;
    source: string;
  }>();
  return rows.results;
}

export function findBankHistoryDateBounds(db: D1Database) {
  return db
    .prepare(
      `SELECT
       MIN(substr(as_of_at, 1, 10)) AS minDate,
       MAX(substr(as_of_at, 1, 10)) AS maxDate
     FROM bank_balance_snapshots`,
    )
    .first<{ minDate: string | null; maxDate: string | null }>();
}

export async function calculateBankDepositValue(db: D1Database, date: string) {
  const rows = await db
    .prepare(
      `SELECT
       latest.balance AS balance,
       latest.currency AS currency,
       rate.rate_to_twd AS rateToTwd
     FROM bank_accounts account
     JOIN bank_balance_snapshots latest
       ON latest.id = (
         SELECT snapshot.id
         FROM bank_balance_snapshots snapshot
         WHERE snapshot.account_id = account.id
           AND substr(snapshot.as_of_at, 1, 10) <= ?
         ORDER BY snapshot.as_of_at DESC, snapshot.updated_at DESC
         LIMIT 1
       )
     LEFT JOIN exchange_rates rate ON rate.currency = latest.currency
     WHERE account.canonical_account_id IS NULL
       AND COALESCE(account.account_type, 'unknown') != 'credit'`,
    )
    .bind(date)
    .all<{ balance: number; currency: string; rateToTwd: number | null }>();

  return Math.round(
    rows.results.reduce((sum, row) => {
      const currency = row.currency || "TWD";
      if (currency === "TWD") return sum + row.balance;
      return row.rateToTwd ? sum + row.balance * row.rateToTwd : sum;
    }, 0),
  );
}

export async function upsertBankDepositHistory(
  db: D1Database,
  points: Array<{ date: string; netWorth: number }>,
  now: string,
) {
  for (let offset = 0; offset < points.length; offset += 100) {
    await db.batch(
      points.slice(offset, offset + 100).map(({ date, netWorth }) =>
        db
          .prepare(
            `INSERT INTO net_worth_history (id, date, net_worth, asset_type, source, snapshotted_at)
         VALUES (?, ?, ?, 'deposit', 'bank', ?)
         ON CONFLICT(source, asset_type, date) DO UPDATE SET
           net_worth = excluded.net_worth,
           snapshotted_at = excluded.snapshotted_at`,
          )
          .bind(`bank:deposit:${date}`, date, netWorth, now),
      ),
    );
  }
}
