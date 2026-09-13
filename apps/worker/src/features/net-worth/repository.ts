import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  exchangeRates,
  manualAssets,
  netWorthHistory,
} from "@taiwan-fin-hub/db";
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
          OR ${history.assetType} IN ('stock', 'fund')`,
    )
    .orderBy(
      asc(history.date),
      asc(history.source),
      asc(history.assetType),
      asc(history.id),
    )
    .all();
}

export async function listNetWorthHistory(
  db: D1Database,
  limit: number,
  cursor?: NetWorthPageCursor,
) {
  return createDrizzle(db)
    .select({
      id: sql<string>`${history.id}`,
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
        sql`COALESCE(${account.accountType}, 'unknown') != 'credit'`,
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
