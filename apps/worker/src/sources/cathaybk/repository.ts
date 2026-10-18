const MAX_BIND_PARAMETERS = 90;

/**
 * Restore the source-of-truth unpaid state for explicitly identified current
 * Cathay statements. Shared persistence intentionally keeps an existing paid
 * value sticky, so this repair must run after promotion and remain narrowly
 * scoped to the current sync result.
 */
export function reconcileCathayUnpaidCurrentBillStatements(
  db: D1Database,
  billIds: string[],
): D1PreparedStatement[] {
  if (billIds.length === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < billIds.length; offset += MAX_BIND_PARAMETERS) {
    const ids = billIds.slice(offset, offset + MAX_BIND_PARAMETERS);
    const placeholders = ids.map(() => "?").join(", ");
    statements.push(
      db
        .prepare(
          `UPDATE credit_card_bills
           SET is_paid = 0
           WHERE connector_id = 'cathaybk'
             AND is_paid = 1
             AND id IN (${placeholders})`,
        )
        .bind(...ids),
    );
  }
  return statements;
}
