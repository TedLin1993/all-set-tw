import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  exchangeRates,
  manualAssets,
  netWorthHistory,
} from "../../db";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

const history = alias(netWorthHistory, "history");
const asset = alias(manualAssets, "asset");
const rate = alias(exchangeRates, "rate");
const account = alias(bankAccounts, "account");
const latest = alias(bankBalanceSnapshots, "latest");

export type NetWorthPageCursor = {
  date: string;
  source: string;
  assetType: string;
  id: string;
};

export async function listNetWorthChartHistory(db: D1Database) {
  return createDrizzle(db)
    .select({
      date: history.date,
      netWorth: sql<number>`CASE
           WHEN ${history.source} != 'manual' OR ${asset.currency} = 'TWD'
             THEN ${history.netWorth}
           WHEN ${rate.rateToTwd} IS NOT NULL
             THEN ${history.netWorth} * ${rate.rateToTwd}
           ELSE 0
         END`.as("netWorth"),
      assetType: history.assetType,
      source: history.source,
    })
    .from(history)
    .leftJoin(
      asset,
      sql`${history.source} = 'manual' AND ${asset.id} = ${history.assetType}`,
    )
    .leftJoin(rate, eq(rate.currency, asset.currency))
    .where(
      sql`${history.source} = 'manual'
          OR (${history.source} = 'bank' AND ${history.assetType} = 'deposit')
          OR (
            ${history.assetType} IN ('stock', 'fund', 'crypto')
            -- 集保的台股市值與直接券商的台股合併，見 listTaiwanStockChartHistory。
            AND NOT (${history.source} = 'tdcc' AND ${history.assetType} = 'stock')
          )`,
    )
    .orderBy(
      asc(history.date),
      asc(history.source),
      asc(history.assetType),
      asc(history.id),
    )
    .all();
}

/**
 * 台股市值走勢：集保有資料的日期以集保為準（涵蓋所有券商）；集保最後一天之後，或沒有連接集保時，
 * 改用直接券商寫入的 `tw_stock`（同日各券商相加）。兩者合併成同一個 `tw-stock` 序列輸出，
 * 前端逐序列沿用前值時才不會把集保的舊值與券商的新值重複相加。
 * 保留原生 SQL：需要 CTE 取集保最後日期再挑選券商資料。
 */
export async function listTaiwanStockChartHistory(db: D1Database) {
  const { results } = await db
    .prepare(
      `WITH tdcc AS (
        SELECT date, net_worth
        FROM net_worth_history
        WHERE source = 'tdcc' AND asset_type = 'stock'
      ), direct AS (
        SELECT date, SUM(net_worth) AS net_worth
        FROM net_worth_history
        WHERE asset_type = 'tw_stock'
          AND date > COALESCE((SELECT MAX(date) FROM tdcc), '')
        GROUP BY date
      )
      SELECT date, net_worth AS netWorth FROM tdcc
      UNION ALL
      SELECT date, net_worth AS netWorth FROM direct
      ORDER BY date`,
    )
    .all<{ date: string; netWorth: number }>();
  return results.map((row) => ({
    ...row,
    assetType: "stock",
    source: "tw-stock",
  }));
}

export async function listNetWorthHistory(
  db: D1Database,
  limit: number,
  cursor?: NetWorthPageCursor,
) {
  return createDrizzle(db)
    .select({
      id: history.id,
      date: history.date,
      netWorth: history.netWorth,
      assetType: history.assetType,
      source: history.source,
    })
    .from(history)
    .where(
      cursor
        ? sql`(
            ${history.date} < ${cursor.date}
            OR (
              ${history.date} = ${cursor.date}
              AND (${history.source}, ${history.assetType}, ${history.id}) > (${cursor.source}, ${cursor.assetType}, ${cursor.id})
            )
          )`
        : undefined,
    )
    .orderBy(
      desc(history.date),
      asc(history.source),
      asc(history.assetType),
      asc(history.id),
    )
    .limit(limit)
    .all();
}

export async function findBankHistoryDateBounds(db: D1Database) {
  return (
    (await createDrizzle(db)
      .select({
        minDate: sql<
          string | null
        >`min(substr(${bankBalanceSnapshots.asOfAt}, 1, 10))`.as("minDate"),
        maxDate: sql<
          string | null
        >`max(substr(${bankBalanceSnapshots.asOfAt}, 1, 10))`.as("maxDate"),
      })
      .from(bankBalanceSnapshots)
      .get()) ?? null
  );
}

export async function calculateBankDepositValue(db: D1Database, date: string) {
  const rows = await createDrizzle(db)
    .select({
      balance: latest.balance,
      currency: latest.currency,
      rateToTwd: rate.rateToTwd,
    })
    .from(account)
    .innerJoin(
      latest,
      eq(
        latest.id,
        sql`(
          SELECT snapshot.id
          FROM bank_balance_snapshots snapshot
          WHERE snapshot.account_id = ${account.id}
            AND substr(snapshot.as_of_at, 1, 10) <= ${date}
          ORDER BY snapshot.as_of_at DESC, snapshot.updated_at DESC
          LIMIT 1
        )`,
      ),
    )
    .leftJoin(rate, eq(rate.currency, latest.currency))
    .where(
      and(
        isNull(account.canonicalAccountId),
        sql`COALESCE(${account.accountType}, 'unknown') NOT IN ('credit', 'loan')`,
      ),
    )
    .all();

  return Math.round(
    rows.reduce((sum, row) => {
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
  const database = createDrizzle(db);
  for (let offset = 0; offset < points.length; offset += 100) {
    const [first, ...rest] = points
      .slice(offset, offset + 100)
      .map(({ date, netWorth }) =>
        database
          .insert(netWorthHistory)
          .values({
            id: `bank:deposit:${date}`,
            date,
            netWorth,
            assetType: "deposit",
            source: "bank",
            snapshottedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              netWorthHistory.source,
              netWorthHistory.assetType,
              netWorthHistory.date,
            ],
            set: {
              netWorth,
              snapshottedAt: now,
            },
          }),
      );
    if (first) await database.batch([first, ...rest]);
  }
}

/**
 * 以一個 statement 重算 `from` 起既有的存款歷史，規則與 calculateBankDepositValue 相同。
 * 刪除資料來源時與刪除放在同一個 D1 batch，不逐日查詢（免費方案每次請求的 D1 查詢數有限）。
 * 早於剩餘最早餘額的日期已沒有存款資料，直接移除而不留下 0。保留原生 SQL：相關子查詢。
 */
export function bankDepositHistoryRebuildStatements(
  db: D1Database,
  from: string,
  now: string,
) {
  return [
    db.prepare(
      `DELETE FROM net_worth_history
       WHERE source = 'bank' AND asset_type = 'deposit'
         AND date < COALESCE((SELECT MIN(substr(as_of_at, 1, 10)) FROM bank_balance_snapshots), '9999-12-31')`,
    ),
    db
      .prepare(
        `UPDATE net_worth_history
         SET net_worth = (
           SELECT CAST(ROUND(COALESCE(SUM(CASE
             WHEN COALESCE(NULLIF(latest.currency, ''), 'TWD') = 'TWD' THEN latest.balance
             WHEN rate.rate_to_twd IS NOT NULL THEN latest.balance * rate.rate_to_twd
             ELSE 0
           END), 0)) AS INTEGER)
           FROM bank_accounts account
           JOIN bank_balance_snapshots latest ON latest.id = (
             SELECT snapshot.id
             FROM bank_balance_snapshots snapshot
             WHERE snapshot.account_id = account.id
               AND substr(snapshot.as_of_at, 1, 10) <= net_worth_history.date
             ORDER BY snapshot.as_of_at DESC, snapshot.updated_at DESC
             LIMIT 1
           )
           LEFT JOIN exchange_rates rate ON rate.currency = latest.currency
           WHERE account.canonical_account_id IS NULL
             AND COALESCE(account.account_type, 'unknown') NOT IN ('credit', 'loan')
         ),
         snapshotted_at = ?2
         WHERE source = 'bank' AND asset_type = 'deposit' AND date >= ?1`,
      )
      .bind(from, now),
  ];
}

const COST_CONNECTORS_CTE = `cost_connectors AS MATERIALIZED (
  SELECT DISTINCT connector_id FROM investment_positions WHERE cost_basis IS NOT NULL
)`;

/**
 * 股票投入成本回推所需的資料。保留原生 SQL：多個 CTE 與 JSON 欄位。
 * 只看曾提供成本的直接券商（目前為永豐）。
 */
export async function loadStockCostInputs(db: D1Database) {
  const [positions, trades, foreignTrades, uncovered, foreignStart] =
    await db.batch<Record<string, unknown>>([
      // 各直接券商每個快照日、每個市場與幣別的成本合計；缺成本的非零持倉另計筆數。
      // 以市場區分台股與海外：海外持倉可能以 TWD 計價，不能只看幣別。
      db.prepare(
        `WITH ${COST_CONNECTORS_CTE}
      SELECT
        substr(as_of_date, 1, 10) AS date,
        CASE
          WHEN NULLIF(TRIM(market), '') IS NOT NULL THEN UPPER(TRIM(market)) != 'TW'
          ELSE currency != 'TWD'
        END AS foreign_market,
        currency,
        TOTAL(cost_basis) AS cost,
        SUM(CASE WHEN cost_basis IS NULL AND COALESCE(market_value, 0) != 0 THEN 1 ELSE 0 END) AS missing
      FROM investment_positions
      JOIN cost_connectors USING (connector_id)
      WHERE asset_type IN ('stock', 'etf')
      GROUP BY 1, 2, 3
      ORDER BY 1`,
      ),
      db.prepare(
        `WITH ${COST_CONNECTORS_CTE}
      SELECT
        substr(effective_date, 1, 10) AS date,
        transaction_code AS code,
        amount,
        json_extract(raw_payload, '$.realizedCost') AS realizedCost
      FROM investment_transactions
      JOIN cost_connectors USING (connector_id)
      WHERE currency = 'TWD'
        AND COALESCE(json_extract(raw_payload, '$.market'), 'TW') = 'TW'
        AND transaction_code IN ('B', 'S')
        AND effective_date IS NOT NULL
      ORDER BY 1 DESC`,
      ),
      // 海外成交（原幣），供海外市值進入走勢以前的成本回推。
      db.prepare(
        `WITH ${COST_CONNECTORS_CTE}
      SELECT
        substr(effective_date, 1, 10) AS date,
        transaction_code AS code,
        amount,
        currency
      FROM investment_transactions
      JOIN cost_connectors USING (connector_id)
      WHERE COALESCE(json_extract(raw_payload, '$.market'), 'TW') != 'TW'
        AND transaction_code IN ('B', 'S')
        AND effective_date IS NOT NULL
      ORDER BY 1`,
      ),
      // 集保最新快照中，不屬於任何直接券商帳戶的持股：市值線含這些持股但成本未知。
      // 各 CTE 先物化、只算一次：寫成相關子查詢時，每筆集保持股都會重掃整張
      // investment_positions，快照累積後單次查詢可讀上百萬列（D1 每日讀取額度）。
      db.prepare(
        `WITH ${COST_CONNECTORS_CTE},
      -- 只看券商最新快照：已不在最新快照的帳戶，舊列不代表成本仍涵蓋這筆持股。
      direct_latest AS MATERIALIZED (
        SELECT connector_id, MAX(as_of_date) AS as_of_date
        FROM investment_positions
        JOIN cost_connectors USING (connector_id)
        GROUP BY connector_id
      ),
      covered_accounts AS MATERIALIZED (
        SELECT DISTINCT direct.broker_no, direct.broker_account
        FROM investment_positions direct
        JOIN direct_latest
          ON direct_latest.connector_id = direct.connector_id
          AND direct_latest.as_of_date = direct.as_of_date
      ),
      tdcc_latest AS MATERIALIZED (
        SELECT asset_type, MAX(as_of_date) AS as_of_date
        FROM investment_positions
        WHERE connector_id = 'tdcc' AND asset_type IN ('stock', 'etf')
        GROUP BY asset_type
      )
      -- CROSS JOIN 固定由最新快照日帶出集保列，只讀最新那天，不掃集保歷史。
      SELECT COUNT(*) AS count
      FROM tdcc_latest
      CROSS JOIN investment_positions tdcc
        ON tdcc.connector_id = 'tdcc'
        AND tdcc.asset_type = tdcc_latest.asset_type
        AND tdcc.as_of_date = tdcc_latest.as_of_date
      WHERE COALESCE(tdcc.market_value, 0) != 0
        AND NOT EXISTS (
          SELECT 1 FROM covered_accounts covered
          WHERE covered.broker_no = tdcc.broker_no
            AND covered.broker_account = tdcc.broker_account
        )`,
      ),
      // 海外市值從這天才進入走勢；之前的海外成本由成交回推。
      db.prepare(
        `SELECT MIN(date) AS date FROM net_worth_history
       WHERE asset_type = 'stock' AND source != 'tdcc'`,
      ),
    ]);
  const rates = await createDrizzle(db)
    .select({
      currency: exchangeRates.currency,
      rateToTwd: exchangeRates.rateToTwd,
    })
    .from(exchangeRates)
    .all();
  return {
    positions: positions!.results as Array<{
      date: string;
      /** SQLite 布林：1 為海外市場。 */
      foreign_market: number;
      currency: string;
      cost: number;
      missing: number;
    }>,
    trades: trades!.results as Array<{
      date: string;
      code: string;
      amount: number | null;
      realizedCost: number | null;
    }>,
    foreignTrades: foreignTrades!.results as Array<{
      date: string;
      code: string;
      amount: number | null;
      currency: string;
    }>,
    uncoveredTdccHoldings: Number(uncovered!.results[0]?.count ?? 0),
    foreignStartDate: (foreignStart!.results[0]?.date as string | null) ?? null,
    ratesToTwd: Object.fromEntries(
      rates.map((rate) => [rate.currency, rate.rateToTwd]),
    ),
  };
}
