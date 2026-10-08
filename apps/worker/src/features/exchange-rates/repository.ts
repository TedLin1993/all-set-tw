import {
  bankAccounts,
  bankBalanceSnapshots,
  createDrizzle,
  exchangeRates,
  investmentPositions,
  manualAssets,
  netWorthHistory,
} from "../../db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

export type ExchangeRateRow = Pick<
  typeof exchangeRates.$inferSelect,
  "updatedAt"
> & {
  currency: string;
  rateTwd: number;
};

export async function listExchangeRates(db: D1Database) {
  return createDrizzle(db)
    .select({
      currency: exchangeRates.currency,
      rateTwd: exchangeRates.rateToTwd,
      updatedAt: exchangeRates.updatedAt,
    })
    .from(exchangeRates)
    .orderBy(
      sql`CASE ${exchangeRates.currency}
       WHEN 'USD' THEN 1
       WHEN 'JPY' THEN 2
       WHEN 'EUR' THEN 3
       ELSE 4
     END`,
      asc(exchangeRates.currency),
    )
    .all();
}

export async function listAssetCurrencyAmounts(db: D1Database) {
  const database = createDrizzle(db);
  return database
    .select({
      currency: bankAccounts.currency,
      amount: sql<number>`COALESCE(${bankBalanceSnapshots.balance}, 0)`.as(
        "amount",
      ),
    })
    .from(bankAccounts)
    .leftJoin(
      bankBalanceSnapshots,
      eq(
        bankBalanceSnapshots.id,
        sql`(
          SELECT latest.id
          FROM bank_balance_snapshots latest
          WHERE latest.account_id = ${bankAccounts.id}
          ORDER BY latest.as_of_at DESC, latest.updated_at DESC
          LIMIT 1
        )`,
      ),
    )
    .where(
      and(
        isNull(bankAccounts.canonicalAccountId),
        isNull(bankAccounts.inactiveAt),
      ),
    )
    .unionAll(
      database
        .select({
          currency: investmentPositions.currency,
          amount:
            sql<number>`COALESCE(${investmentPositions.marketValue}, 0) + COALESCE(${investmentPositions.cashBalance}, 0)`.as(
              "amount",
            ),
        })
        .from(investmentPositions)
        .where(
          eq(
            investmentPositions.asOfDate,
            sql`(
              SELECT MAX(latest.as_of_date)
              FROM investment_positions latest
              WHERE latest.connector_id = ${investmentPositions.connectorId}
                AND latest.asset_type = ${investmentPositions.assetType}
            )`,
          ),
        ),
    )
    .unionAll(
      database
        .select({
          currency: manualAssets.currency,
          amount: sql<number>`COALESCE(${netWorthHistory.netWorth}, 0)`.as(
            "amount",
          ),
        })
        .from(manualAssets)
        .leftJoin(
          netWorthHistory,
          eq(
            netWorthHistory.id,
            sql`(
              SELECT latest.id
              FROM net_worth_history latest
              WHERE latest.source = 'manual'
                AND latest.asset_type = ${manualAssets.id}
              ORDER BY latest.date DESC, latest.snapshotted_at DESC
              LIMIT 1
            )`,
          ),
        ),
    )
    .all();
}

export async function upsertExchangeRates(
  db: D1Database,
  rates: Array<{ currency: string; rate: number }>,
  now: string,
) {
  const database = createDrizzle(db);
  // One D1 batch preserves the old rates if any fetched currency fails to write.
  const [first, ...rest] = rates.map(({ currency, rate }) =>
    database
      .insert(exchangeRates)
      .values({ currency, rateToTwd: rate, updatedAt: now })
      .onConflictDoUpdate({
        target: exchangeRates.currency,
        set: { rateToTwd: rate, updatedAt: now },
      }),
  );
  if (first) await database.batch([first, ...rest]);
}
