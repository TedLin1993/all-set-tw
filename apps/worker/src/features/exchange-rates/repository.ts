import { createDrizzle, exchangeRates } from "@taiwan-fin-hub/db";
import { inArray, sql } from "drizzle-orm";

export type ExchangeRateRow = Pick<
  typeof exchangeRates.$inferSelect,
  "updatedAt"
> & {
  currency: string;
  rateTwd: number;
};

export const SUPPORTED_EXCHANGE_CURRENCIES = ["USD", "JPY", "EUR"] as const;

export async function listExchangeRates(db: D1Database) {
  return createDrizzle(db)
    .select({
      // The IN predicate excludes the nullable legacy TEXT primary key.
      currency: sql<string>`${exchangeRates.currency}`,
      rateTwd: exchangeRates.rateToTwd,
      updatedAt: exchangeRates.updatedAt,
    })
    .from(exchangeRates)
    .where(inArray(exchangeRates.currency, [...SUPPORTED_EXCHANGE_CURRENCIES]))
    .orderBy(
      sql`CASE ${exchangeRates.currency}
       WHEN 'USD' THEN 1
       WHEN 'JPY' THEN 2
       WHEN 'EUR' THEN 3
       ELSE 4
     END`,
    )
    .all();
}

export async function replaceExchangeRates(
  db: D1Database,
  rates: Array<{ currency: string; rate: number }>,
  now: string,
) {
  const database = createDrizzle(db);
  // Delete + inserts stay in one D1 batch so a failed insert leaves the old rates.
  await database.batch([
    database.delete(exchangeRates),
    ...rates.map(({ currency, rate }) =>
      database.insert(exchangeRates).values({
        currency,
        rateToTwd: rate,
        updatedAt: now,
      }),
    ),
  ]);
}
