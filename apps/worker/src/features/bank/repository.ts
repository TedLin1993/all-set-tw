import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  bankTransactionPreferences,
  bankTransactions,
  creditCardBills,
} from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { TransactionPageCursor } from "../investments/repository";
import type { MonthDateRange } from "../../platform/month-range";

const txn = alias(bankTransactions, "txn");
const account = alias(bankAccounts, "account");
const preference = alias(bankTransactionPreferences, "preference");
const balance = alias(bankBalanceSnapshots, "balance");
const bill = alias(creditCardBills, "b");
const billAccount = alias(bankAccounts, "a");

// Must match idx_bank_transactions_transaction_day so range scans stay indexed.
const bankTransactionDay = sql`CASE WHEN length(txn.authorized_at) > 10
  THEN COALESCE(date(txn.authorized_at, '+8 hours'), substr(txn.authorized_at, 1, 10))
  ELSE substr(COALESCE(txn.authorized_at, txn.posted_date), 1, 10) END`;

const visibleBankTransactionFilter = and(
  isNull(account.canonicalAccountId),
  sql`(${txn.status} <> 'pending' OR ${txn.matchedTransactionId} IS NULL)`,
);

const bankTransactionColumns = {
  id: sql<string>`${txn.id}`.as("id"),
  connectorId: sql<string>`${txn.connectorId}`.as("connectorId"),
  accountId: sql<string>`${txn.accountId}`.as("accountId"),
  accountSourceId: sql<string>`${account.sourceId}`.as("accountSourceId"),
  accountName: sql<string>`${account.accountName}`.as("accountName"),
  institutionName: sql<string>`${account.institutionName}`.as(
    "institutionName",
  ),
  accountType: sql<string>`${account.accountType}`.as("accountType"),
  bankCode: sql<string>`${account.bankCode}`.as("bankCode"),
  accountLast4: sql<string>`${account.accountLast4}`.as("accountLast4"),
  sourceId: sql<string>`${txn.sourceId}`.as("sourceId"),
  transferPeerId: sql<string | null>`${txn.transferPeerId}`.as(
    "transferPeerId",
  ),
  postedDate: sql<string | null>`${txn.postedDate}`.as("postedDate"),
  authorizedAt: sql<string | null>`${txn.authorizedAt}`.as("authorizedAt"),
  amount: sql<number>`${txn.amount}`.as("amount"),
  currency: sql<string>`${txn.currency}`.as("currency"),
  description: sql<string | null>`${txn.description}`.as("description"),
  counterparty: sql<string | null>`${txn.counterparty}`.as("counterparty"),
  status: sql<"pending" | "posted">`${txn.status}`.as("status"),
  effectiveDate: sql<string>`${txn.effectiveDate}`.as("effectiveDate"),
  updatedAt: sql<string>`${txn.updatedAt}`.as("updatedAt"),
  calculationPreference: sql<
    number | null
  >`${preference.excludedFromCalculation}`.as("calculationPreference"),
};

const creditCardBillColumns = {
  id: sql<string>`${bill.id}`.as("id"),
  connectorId: sql<string>`${bill.connectorId}`.as("connectorId"),
  accountId: sql<string>`${bill.accountId}`.as("accountId"),
  accountSourceId: sql<string>`${billAccount.sourceId}`.as("accountSourceId"),
  sourceId: sql<string>`${bill.sourceId}`.as("sourceId"),
  billingPeriod: sql<string>`${bill.billingPeriod}`.as("billingPeriod"),
  statementAmount: sql<number | null>`${bill.statementAmount}`.as(
    "statementAmount",
  ),
  minimumPayment: sql<number | null>`${bill.minimumPayment}`.as(
    "minimumPayment",
  ),
  paidAmount: sql<number | null>`${bill.paidAmount}`.as("paidAmount"),
  isPaid: sql<number | null>`${bill.isPaid}`.as("isPaid"),
  paymentDueDate: sql<string | null>`${bill.paymentDueDate}`.as(
    "paymentDueDate",
  ),
  statementClosingDate: sql<string | null>`${bill.statementClosingDate}`.as(
    "statementClosingDate",
  ),
  currency: sql<string>`${bill.currency}`.as("currency"),
};

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
  transferPeerId?: string | null;
};

export type CreditCardBillPageCursor = {
  billingPeriod: string;
  accountId: string;
  id: string;
};

export type CreditCardBillPageRow = {
  id: string;
  connectorId: string;
  accountId: string;
  accountSourceId: string;
  sourceId: string;
  billingPeriod: string;
  statementAmount: number | null;
  minimumPayment: number | null;
  paidAmount: number | null;
  isPaid: number | null;
  paymentDueDate: string | null;
  statementClosingDate: string | null;
  currency: string;
};

function bankTransactionQuery(db: D1Database) {
  return createDrizzle(db)
    .select(bankTransactionColumns)
    .from(txn)
    .innerJoin(account, eq(account.id, txn.accountId))
    .leftJoin(preference, eq(preference.transactionId, txn.id));
}

export async function listBankAccounts(db: D1Database) {
  return createDrizzle(db)
    .select({
      id: sql<string>`${account.id}`,
      connectorId: account.connectorId,
      sourceId: account.sourceId,
      institutionName: account.institutionName,
      accountName: account.accountName,
      accountType: account.accountType,
      currency: account.currency,
      openedDate: account.openedDate,
      maturityDate: account.maturityDate,
      bankCode: account.bankCode,
      accountLast4: account.accountLast4,
      balance: balance.balance,
      availableBalance: balance.availableBalance,
      paymentDueDate: balance.paymentDueDate,
      statementClosingDate: balance.statementClosingDate,
      asOfAt: balance.asOfAt,
    })
    .from(account)
    .leftJoin(
      balance,
      eq(
        balance.id,
        sql`(
          SELECT latest.id
          FROM bank_balance_snapshots latest
          WHERE latest.account_id = ${account.id}
          ORDER BY latest.as_of_at DESC, latest.updated_at DESC
          LIMIT 1
        )`,
      ),
    )
    .where(and(isNull(account.canonicalAccountId), isNull(account.inactiveAt)))
    .orderBy(
      asc(account.institutionName),
      asc(account.accountName),
      asc(account.sourceId),
    )
    .all();
}

export async function listBankTransactions(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  return bankTransactionQuery(db)
    .where(
      and(
        visibleBankTransactionFilter,
        cursor
          ? sql`(${txn.effectiveDate}, ${txn.updatedAt}, ${txn.id}) < (${cursor.effectiveDate}, ${cursor.updatedAt}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(txn.effectiveDate), desc(txn.updatedAt), desc(txn.id))
    .limit(limit)
    .all();
}

export async function listBankTransactionsInRange(
  db: D1Database,
  range: MonthDateRange,
  days?: string[],
) {
  return bankTransactionQuery(db)
    .where(
      and(
        visibleBankTransactionFilter,
        days
          ? sql`(${bankTransactionDay}) IN (SELECT value FROM json_each(${JSON.stringify(days)}))`
          : and(
              sql`(${bankTransactionDay}) >= ${range.from}`,
              sql`(${bankTransactionDay}) < ${range.to}`,
            ),
      ),
    )
    .orderBy(desc(txn.effectiveDate), desc(txn.updatedAt), desc(txn.id))
    .all();
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
  return bankTransactionQuery(db)
    .where(
      and(
        visibleBankTransactionFilter,
        eq(txn.status, "posted"),
        ne(txn.amount, 0),
        sql`ABS(txn.amount) IN (
          SELECT CAST(value AS INTEGER) FROM json_each(${JSON.stringify(amounts)})
        )`,
        sql`UPPER(TRIM(txn.currency)) IN (
          SELECT UPPER(TRIM(value)) FROM json_each(${JSON.stringify(currencies)})
        )`,
        matchDays.length > 0
          ? sql`(${bankTransactionDay}) IN (
              SELECT value FROM json_each(${JSON.stringify(matchDays)})
            )`
          : undefined,
      ),
    )
    .all();
}

export async function listCreditCardBills(
  db: D1Database,
  limit: number,
  cursor?: CreditCardBillPageCursor,
) {
  return createDrizzle(db)
    .select(creditCardBillColumns)
    .from(bill)
    .innerJoin(billAccount, eq(billAccount.id, bill.accountId))
    .where(
      cursor
        ? sql`(
            ${bill.billingPeriod} < ${cursor.billingPeriod}
            OR (
              ${bill.billingPeriod} = ${cursor.billingPeriod}
              AND (${bill.accountId}, ${bill.id}) > (${cursor.accountId}, ${cursor.id})
            )
          )`
        : undefined,
    )
    .orderBy(desc(bill.billingPeriod), asc(bill.accountId), asc(bill.id))
    .limit(limit)
    .all();
}

export async function listCreditCardBillsInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  return createDrizzle(db)
    .select(creditCardBillColumns)
    .from(bill)
    .innerJoin(billAccount, eq(billAccount.id, bill.accountId))
    .where(
      and(
        sql`${bill.billingPeriod} >= substr(${range.from}, 1, 7)`,
        sql`${bill.billingPeriod} < substr(${range.to}, 1, 7)`,
      ),
    )
    .orderBy(desc(bill.billingPeriod), asc(bill.accountId), asc(bill.id))
    .all();
}
