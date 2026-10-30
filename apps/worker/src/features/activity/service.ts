import {
  buildActivityItems,
  deduplicateBankTransactions,
  matchInvoicesToTransactions,
} from "@taiwan-fin-hub/shared";
import { getBankRange } from "../bank/service";
import { getInvestmentTransactionsRange } from "../investments/service";
import { getInvoicesRange } from "../invoices/service";
import type { MonthDateRange } from "../../platform/month-range";
import {
  findLinkedInvoiceId,
  findMappingInvoice,
  findMappingTransaction,
  listInvoiceTransactionPreferences,
  upsertInvoiceTransactionPreference,
} from "./repository";

export class MappingInvoiceNotFoundError extends Error {}
export class MappingTransactionNotFoundError extends Error {}
export class MappingTransactionUnavailableError extends Error {}
export class MappingDateMismatchError extends Error {}
export class MappingTransactionNotExpenseError extends Error {}

/**
 * 依活動頁相同步驟組出區間內的活動：補帳戶類型、去重、配對發票後建立項目。
 * 呼叫端若只需要部分月份，應自行以活動日期篩選。
 */
export async function getActivityItemsInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  const [bank, invoiceRows, trades, preferences] = await Promise.all([
    getBankRange(db, range),
    getInvoicesRange(db, range),
    getInvestmentTransactionsRange(db, range),
    listInvoiceTransactionPreferences(db),
  ]);
  const accounts = new Map(
    bank.accounts.map((account) => [
      String(account.id),
      { ...account, id: String(account.id) },
    ]),
  );
  const transactions = deduplicateBankTransactions(
    bank.transactions.map((transaction) => ({
      ...transaction,
      accountType:
        transaction.accountType ??
        accounts.get(transaction.accountId)?.accountType,
    })),
  );
  const matches = matchInvoicesToTransactions(
    transactions,
    invoiceRows,
    preferences,
  );
  return buildActivityItems(
    transactions,
    invoiceRows,
    trades,
    accounts,
    matches,
  );
}

const taipeiDayFormatter = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function financialDay(value?: string | null) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const parts = Object.fromEntries(
    taipeiDayFormatter
      .formatToParts(parsed)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function linkInvoiceToTransaction(
  db: D1Database,
  invoiceId: string,
  transactionId: string,
) {
  const [invoice, transaction] = await Promise.all([
    findMappingInvoice(db, invoiceId),
    findMappingTransaction(db, transactionId),
  ]);
  if (!invoice) throw new MappingInvoiceNotFoundError();
  if (!transaction) throw new MappingTransactionNotFoundError();

  const invoiceDay = financialDay(invoice.invoiceDate);
  const transactionDay = financialDay(
    transaction.authorizedAt ?? transaction.postedDate?.slice(0, 10),
  );
  if (!invoiceDay || invoiceDay !== transactionDay)
    throw new MappingDateMismatchError();

  const isExpense =
    transaction.currency === "TWD" &&
    transaction.amount !== 0 &&
    (transaction.accountType === "credit" || transaction.amount < 0);
  if (!isExpense) throw new MappingTransactionNotExpenseError();

  const linkedInvoiceId = await findLinkedInvoiceId(db, transactionId);
  if (linkedInvoiceId && linkedInvoiceId !== invoiceId)
    throw new MappingTransactionUnavailableError();

  const now = new Date().toISOString();
  await upsertInvoiceTransactionPreference(db, {
    invoiceId,
    transactionId,
    decision: "linked",
    now,
  });
  return {
    invoiceId,
    transactionId,
    decision: "linked" as const,
    updatedAt: now,
  };
}

export async function keepInvoiceSeparate(db: D1Database, invoiceId: string) {
  if (!(await findMappingInvoice(db, invoiceId)))
    throw new MappingInvoiceNotFoundError();

  const now = new Date().toISOString();
  await upsertInvoiceTransactionPreference(db, {
    invoiceId,
    transactionId: null,
    decision: "separate",
    now,
  });
  return {
    invoiceId,
    transactionId: null,
    decision: "separate" as const,
    updatedAt: now,
  };
}
