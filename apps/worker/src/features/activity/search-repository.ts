export interface ActivitySearchInput {
  q: string;
  from?: string;
  to?: string;
  source?: "all" | "bank" | "card" | "invoice";
  flow?: "all" | "income" | "expense";
  category?: string;
}

/** Read bounded candidate days; full same-day context preserves invoice matching. */
export async function findActivitySearchDays(
  db: D1Database,
  input: ActivitySearchInput,
  matchingAccountIds: string[] = [],
  beforeDay?: string,
  inclusive = false,
) {
  const rows = await db
    .prepare(
      `
    WITH candidates AS (
      SELECT CASE WHEN length(txn.authorized_at) > 10
        THEN COALESCE(date(txn.authorized_at, '+8 hours'), substr(txn.authorized_at, 1, 10))
        ELSE substr(COALESCE(txn.authorized_at, txn.posted_date), 1, 10) END AS day
      FROM bank_transactions txn
      JOIN bank_accounts account ON account.id = txn.account_id
      WHERE account.canonical_account_id IS NULL AND (txn.status <> 'pending' OR txn.matched_transaction_id IS NULL) AND (
        instr(lower(COALESCE(txn.description, '') || ' ' || COALESCE(txn.counterparty, '') || ' ' ||
          COALESCE(account.institution_name, '') || ' ' || COALESCE(account.account_name, '') || ' ' ||
          COALESCE(account.account_last4, '') || ' 銀行 信用卡'), ?1) > 0
        OR account.id IN (SELECT value FROM json_each(?5))
        OR EXISTS (SELECT 1 FROM classification_categories WHERE instr(lower(label), ?1) > 0)
      )
      UNION ALL
      SELECT CASE WHEN length(invoice_date) > 10
        THEN COALESCE(date(invoice_date, '+8 hours'), substr(invoice_date, 1, 10))
        ELSE invoice_date END AS day
      FROM invoices
      WHERE instr(lower(COALESCE(seller_name, '') || ' ' || COALESCE(invoice_number, '') || ' 電子發票'), ?1) > 0
      UNION ALL
      SELECT substr(effective_date, 1, 10) AS day FROM investment_transactions
      WHERE instr(lower(COALESCE(name, '') || ' ' || COALESCE(symbol, '') || ' ' ||
        COALESCE(transaction_name, '') || ' ' || COALESCE(transaction_code, '') || ' 投資'), ?1) > 0
    )
    SELECT DISTINCT day FROM candidates
    WHERE day IS NOT NULL AND day != ''
      AND (?2 IS NULL OR day >= ?2) AND (?3 IS NULL OR day <= ?3)
      AND (?4 IS NULL OR day < ?4 OR (?6 = 1 AND day = ?4))
    ORDER BY day DESC LIMIT 33
  `,
    )
    .bind(
      input.q.toLowerCase(),
      input.from ?? null,
      input.to ?? null,
      beforeDay ?? null,
      JSON.stringify(matchingAccountIds),
      inclusive ? 1 : 0,
    )
    .all<{ day: string }>();
  return rows.results.map((row) => row.day);
}
