import { createDrizzle } from "@taiwan-fin-hub/db";
import { sql } from "drizzle-orm";

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
  const q = input.q.toLowerCase();
  const from = input.from ?? null;
  const to = input.to ?? null;
  const before = beforeDay ?? null;
  const matchingIds = JSON.stringify(matchingAccountIds);
  const inclusiveFlag = inclusive ? 1 : 0;

  // UNION ALL + DISTINCT keeps cross-source day dedupe; the bank CASE must
  // stay identical to idx_bank_transactions_transaction_day.
  const rows = await createDrizzle(db).all<{ day: string }>(sql`
    WITH candidates AS (
      SELECT CASE WHEN length(txn.authorized_at) > 10
        THEN COALESCE(date(txn.authorized_at, '+8 hours'), substr(txn.authorized_at, 1, 10))
        ELSE substr(COALESCE(txn.authorized_at, txn.posted_date), 1, 10) END AS day
      FROM bank_transactions txn
      JOIN bank_accounts account ON account.id = txn.account_id
      WHERE account.canonical_account_id IS NULL AND (txn.status <> 'pending' OR txn.matched_transaction_id IS NULL) AND (
        instr(lower(COALESCE(txn.description, '') || ' ' || COALESCE(txn.counterparty, '') || ' ' ||
          COALESCE(account.institution_name, '') || ' ' || COALESCE(account.account_name, '') || ' ' ||
          COALESCE(account.account_last4, '') || ' 銀行 信用卡'), ${q}) > 0
        OR account.id IN (SELECT value FROM json_each(${matchingIds}))
        OR EXISTS (SELECT 1 FROM classification_categories WHERE instr(lower(label), ${q}) > 0)
      )
      UNION ALL
      SELECT CASE WHEN length(invoice_date) > 10
        THEN COALESCE(date(invoice_date, '+8 hours'), substr(invoice_date, 1, 10))
        ELSE invoice_date END AS day
      FROM invoices
      WHERE instr(lower(COALESCE(seller_name, '') || ' ' || COALESCE(invoice_number, '') || ' 電子發票'), ${q}) > 0
      UNION ALL
      SELECT substr(effective_date, 1, 10) AS day FROM investment_transactions
      WHERE instr(lower(COALESCE(name, '') || ' ' || COALESCE(symbol, '') || ' ' ||
        COALESCE(transaction_name, '') || ' ' || COALESCE(transaction_code, '') || ' 投資'), ${q}) > 0
    )
    SELECT DISTINCT day FROM candidates
    WHERE day IS NOT NULL AND day != ''
      AND (${from} IS NULL OR day >= ${from}) AND (${to} IS NULL OR day <= ${to})
      AND (${before} IS NULL OR day < ${before} OR (${inclusiveFlag} = 1 AND day = ${before}))
    ORDER BY day DESC LIMIT 33
  `);
  return rows.map((row) => row.day);
}
