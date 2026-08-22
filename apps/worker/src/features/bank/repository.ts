import type { TransactionPageCursor } from "../investments/repository";
import type { MonthDateRange } from "../../platform/month-range";

export type BankTransactionPageRow = {
  id: string;
  connectorId: string;
  accountId: string;
  accountSourceId: string;
  accountName: string | null;
  institutionName: string | null;
  accountType: string | null;
  bankCode: string | null;
  accountLast4: string | null;
  sourceId: string;
  postedDate: string | null;
  authorizedAt: string | null;
  amount: number;
  currency: string;
  description: string | null;
  counterparty: string | null;
  status: "pending" | "posted";
  effectiveDate: string;
  updatedAt: string;
  calculationPreference: number | null;
};

export type CreditCardBillPageCursor = {
  billingPeriod: string;
  accountId: string;
  id: string;
};

const BANK_TRANSACTION_SELECT = `SELECT
      txn.id,
      txn.connector_id AS connectorId,
      txn.account_id AS accountId,
      account.source_id AS accountSourceId,
      account.account_name AS accountName,
      account.institution_name AS institutionName,
      account.account_type AS accountType,
      account.bank_code AS bankCode,
      account.account_last4 AS accountLast4,
      txn.source_id AS sourceId,
      txn.posted_date AS postedDate,
      txn.authorized_at AS authorizedAt,
      txn.amount,
      txn.currency,
      txn.description,
      txn.counterparty,
      txn.status,
      txn.effective_date AS effectiveDate,
      txn.updated_at AS updatedAt,
      preference.excluded_from_calculation AS calculationPreference
    FROM bank_transactions txn
    JOIN bank_accounts account ON account.id = txn.account_id
    LEFT JOIN bank_transaction_preferences preference
      ON preference.transaction_id = txn.id`;

export async function listBankAccounts(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT
      account.id,
      account.connector_id AS connectorId,
      account.source_id AS sourceId,
      account.institution_name AS institutionName,
      account.account_name AS accountName,
      account.account_type AS accountType,
      account.currency,
      account.bank_code AS bankCode,
      account.account_last4 AS accountLast4,
      balance.balance AS balance,
      balance.available_balance AS availableBalance,
      balance.payment_due_date AS paymentDueDate,
      balance.statement_closing_date AS statementClosingDate,
      balance.as_of_at AS asOfAt
    FROM bank_accounts account
    LEFT JOIN bank_balance_snapshots balance
      ON balance.id = (
        SELECT latest.id
        FROM bank_balance_snapshots latest
        WHERE latest.account_id = account.id
        ORDER BY latest.as_of_at DESC, latest.updated_at DESC
        LIMIT 1
      )
    WHERE account.canonical_account_id IS NULL
    ORDER BY account.institution_name ASC, account.account_name ASC, account.source_id ASC`,
    )
    .all<Record<string, unknown>>();
  return rows.results;
}

export async function listBankTransactions(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  const cursorClause = cursor
    ? "AND (txn.effective_date, txn.updated_at, txn.id) < (?, ?, ?)"
    : "";
  const statement = db.prepare(
    `${BANK_TRANSACTION_SELECT}
    WHERE account.canonical_account_id IS NULL
    ${cursorClause}
    ORDER BY txn.effective_date DESC, txn.updated_at DESC, txn.id DESC
    LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(cursor.effectiveDate, cursor.updatedAt, cursor.id, limit)
      : statement.bind(limit)
  ).all<BankTransactionPageRow>();
  return rows.results;
}

export async function listBankTransactionsInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  const rows = await db
    .prepare(
      `${BANK_TRANSACTION_SELECT}
       WHERE account.canonical_account_id IS NULL
         AND COALESCE(txn.authorized_at, txn.posted_date) >= ?
         AND COALESCE(txn.authorized_at, txn.posted_date) < ?
       ORDER BY txn.effective_date DESC, txn.updated_at DESC, txn.id DESC`,
    )
    .bind(range.from, range.to)
    .all<BankTransactionPageRow>();
  return rows.results;
}

export async function listBankTransactionsForTransferMatching(
  db: D1Database,
  transactions: Array<Pick<BankTransactionPageRow, "amount" | "currency">>,
  days: string[] = [],
) {
  const amounts = [
    ...new Set(
      transactions
        .filter(
          (transaction) =>
            Number.isFinite(transaction.amount) && transaction.amount !== 0,
        )
        .map((transaction) => Math.abs(transaction.amount)),
    ),
  ];
  const currencies = [
    ...new Set(
      transactions
        .map((transaction) => transaction.currency.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (amounts.length === 0 || currencies.length === 0) return [];

  const matchDays = [...new Set(days.filter(Boolean))];
  const dayClause =
    matchDays.length > 0
      ? `
         AND substr(COALESCE(txn.authorized_at, txn.posted_date), 1, 10) IN (
           SELECT value FROM json_each(?)
         )`
      : "";
  const values = [JSON.stringify(amounts), JSON.stringify(currencies)];
  if (matchDays.length > 0) values.push(JSON.stringify(matchDays));

  const rows = await db
    .prepare(
      `${BANK_TRANSACTION_SELECT}
       WHERE account.canonical_account_id IS NULL
         AND txn.status = 'posted'
         AND txn.amount <> 0
         AND ABS(txn.amount) IN (
           SELECT CAST(value AS INTEGER) FROM json_each(?)
         )
         AND UPPER(TRIM(txn.currency)) IN (
           SELECT UPPER(TRIM(value)) FROM json_each(?)
         )${dayClause}`,
    )
    .bind(...values)
    .all<BankTransactionPageRow>();
  return rows.results;
}

export async function listCreditCardBills(
  db: D1Database,
  limit: number,
  cursor?: CreditCardBillPageCursor,
) {
  const cursorClause = cursor
    ? `WHERE (
        b.billing_period < ?
        OR (
          b.billing_period = ?
          AND (b.account_id, b.id) > (?, ?)
        )
      )`
    : "";
  const statement = db.prepare(
    `SELECT
      b.id,
      b.connector_id AS connectorId,
      b.account_id AS accountId,
      a.source_id AS accountSourceId,
      b.source_id AS sourceId,
      b.billing_period AS billingPeriod,
      b.statement_amount AS statementAmount,
      b.minimum_payment AS minimumPayment,
      b.paid_amount AS paidAmount,
      b.is_paid AS isPaid,
      b.payment_due_date AS paymentDueDate,
      b.statement_closing_date AS statementClosingDate,
      b.currency
    FROM credit_card_bills b
    JOIN bank_accounts a ON a.id = b.account_id
    ${cursorClause}
    ORDER BY b.billing_period DESC, b.account_id ASC, b.id ASC
    LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(
          cursor.billingPeriod,
          cursor.billingPeriod,
          cursor.accountId,
          cursor.id,
          limit,
        )
      : statement.bind(limit)
  ).all<
    Record<string, unknown> & {
      id: string;
      accountId: string;
      billingPeriod: string;
    }
  >();
  return rows.results;
}

export async function listCreditCardBillsInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  const rows = await db
    .prepare(
      `SELECT
      b.id,
      b.connector_id AS connectorId,
      b.account_id AS accountId,
      a.source_id AS accountSourceId,
      b.source_id AS sourceId,
      b.billing_period AS billingPeriod,
      b.statement_amount AS statementAmount,
      b.minimum_payment AS minimumPayment,
      b.paid_amount AS paidAmount,
      b.is_paid AS isPaid,
      b.payment_due_date AS paymentDueDate,
      b.statement_closing_date AS statementClosingDate,
      b.currency
    FROM credit_card_bills b
    JOIN bank_accounts a ON a.id = b.account_id
    WHERE b.billing_period >= substr(?, 1, 7)
      AND b.billing_period < substr(?, 1, 7)
    ORDER BY b.billing_period DESC, b.account_id ASC, b.id ASC`,
    )
    .bind(range.from, range.to)
    .all<
      Record<string, unknown> & {
        id: string;
        accountId: string;
        billingPeriod: string;
      }
    >();
  return rows.results;
}
