import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  bankTransactionPreferences,
  bankTransactions,
  creditCardBills,
} from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { TransactionPageCursor } from "../investments/repository";
import type { MonthDateRange } from "../../platform/month-range";

const txn = alias(bankTransactions, "txn");
const account = alias(bankAccounts, "account");
const preference = alias(bankTransactionPreferences, "preference");
const balance = alias(bankBalanceSnapshots, "balance");
const latestBalance = alias(bankBalanceSnapshots, "latest");
const bill = alias(creditCardBills, "b");
const billAccount = alias(bankAccounts, "a");

// Must match idx_bank_transactions_transaction_day so range scans stay indexed.
const bankTransactionDay = sql`CASE WHEN length(txn.authorized_at) > 10
  THEN COALESCE(date(txn.authorized_at, '+8 hours'), substr(txn.authorized_at, 1, 10))
  ELSE substr(COALESCE(txn.authorized_at, txn.posted_date), 1, 10) END`;

const visibleBankTransactionFilter = and(
  isNull(account.canonicalAccountId),
  or(ne(txn.status, "pending"), isNull(txn.matchedTransactionId)),
);

const bankTransactionColumns = {
  id: sql<string>`${txn.id}`,
  connectorId: txn.connectorId,
  accountId: txn.accountId,
  accountSourceId: account.sourceId,
  accountName: account.accountName,
  institutionName: account.institutionName,
  accountType: account.accountType,
  bankCode: account.bankCode,
  accountLast4: account.accountLast4,
  sourceId: txn.sourceId,
  transferPeerId: txn.transferPeerId,
  postedDate: txn.postedDate,
  authorizedAt: txn.authorizedAt,
  amount: txn.amount,
  currency: txn.currency,
  description: txn.description,
  counterparty: txn.counterparty,
  status: sql<"pending" | "posted">`${txn.status}`,
  effectiveDate: sql<string>`${txn.effectiveDate}`,
  updatedAt: txn.updatedAt,
  calculationPreference: preference.excludedFromCalculation,
};

const creditCardBillColumns = {
  id: sql<string>`${bill.id}`,
  connectorId: bill.connectorId,
  accountId: bill.accountId,
  accountSourceId: billAccount.sourceId,
  sourceId: bill.sourceId,
  billingPeriod: bill.billingPeriod,
  statementAmount: bill.statementAmount,
  minimumPayment: bill.minimumPayment,
  paidAmount: bill.paidAmount,
  isPaid: bill.isPaid,
  paymentDueDate: bill.paymentDueDate,
  statementClosingDate: bill.statementClosingDate,
  currency: bill.currency,
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
          SELECT ${latestBalance.id}
          FROM ${latestBalance}
          WHERE ${latestBalance.accountId} = ${account.id}
          ORDER BY ${latestBalance.asOfAt} DESC, ${latestBalance.updatedAt} DESC
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
