export async function bankTransactionExists(
  db: D1Database,
  transactionId: string,
) {
  return Boolean(
    await db
      .prepare(
        "SELECT id FROM bank_transactions WHERE id = ? AND (status <> 'pending' OR matched_transaction_id IS NULL)",
      )
      .bind(transactionId)
      .first<{ id: string }>(),
  );
}

export async function upsertCalculationPreference(
  db: D1Database,
  transactionId: string,
  excludedFromCalculation: boolean,
  now: string,
) {
  await db
    .prepare(
      `INSERT INTO bank_transaction_preferences
       (transaction_id, excluded_from_calculation, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       excluded_from_calculation = excluded.excluded_from_calculation,
       updated_at = excluded.updated_at`,
    )
    .bind(transactionId, excludedFromCalculation ? 1 : 0, now, now)
    .run();
}
