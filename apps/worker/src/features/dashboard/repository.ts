export async function loadDashboardSummary(db: D1Database) {
  const [invoiceRow, investmentRow, bankAccountRow, bankBalanceRow] =
    await Promise.all([
      db
        .prepare("SELECT COUNT(*) AS count FROM invoices")
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(market_value), 0) AS total
       FROM investment_positions
       WHERE as_of_date = (
         SELECT MAX(p2.as_of_date) FROM investment_positions p2
         WHERE p2.connector_id = investment_positions.connector_id
           AND p2.asset_type = investment_positions.asset_type
       )`,
        )
        .first<{ count: number; total: number }>(),
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM bank_accounts WHERE canonical_account_id IS NULL AND inactive_at IS NULL",
        )
        .first<{ count: number }>(),
      db
        .prepare(
          `SELECT COALESCE(SUM(balance), 0) AS total
       FROM bank_balance_snapshots
       WHERE id IN (
         SELECT (
           SELECT latest.id
           FROM bank_balance_snapshots latest
           WHERE latest.account_id = account.id
           ORDER BY latest.as_of_at DESC, latest.updated_at DESC
           LIMIT 1
         )
         FROM bank_accounts account
         WHERE account.canonical_account_id IS NULL AND account.inactive_at IS NULL
       )`,
        )
        .first<{ total: number }>(),
    ]);
  return { invoiceRow, investmentRow, bankAccountRow, bankBalanceRow };
}
