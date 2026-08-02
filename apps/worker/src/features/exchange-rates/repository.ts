export type ExchangeRateRow = {
  currency: string;
  rateTwd: number;
  updatedAt: string;
};

export const SUPPORTED_EXCHANGE_CURRENCIES = ["USD", "JPY", "EUR"] as const;

export async function listExchangeRates(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT currency, rate_to_twd AS rateTwd, updated_at AS updatedAt
     FROM exchange_rates
     WHERE currency IN ('USD', 'JPY', 'EUR')
     ORDER BY CASE currency
       WHEN 'USD' THEN 1
       WHEN 'JPY' THEN 2
       WHEN 'EUR' THEN 3
       ELSE 4
     END`,
    )
    .all<ExchangeRateRow>();
  return rows.results;
}

export async function replaceExchangeRates(
  db: D1Database,
  rates: Array<{ currency: string; rate: number }>,
  now: string,
) {
  const statements = [db.prepare("DELETE FROM exchange_rates")];
  if (rates.length === 0) {
    await db.batch(statements);
    return;
  }

  statements.push(
    ...rates.map(({ currency, rate }) =>
      db
        .prepare(
          `INSERT INTO exchange_rates (currency, rate_to_twd, updated_at) VALUES (?, ?, ?)`,
        )
        .bind(currency, rate, now),
    ),
  );

  await db.batch(statements);
}
