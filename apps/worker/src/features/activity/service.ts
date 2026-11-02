import {
  buildActivityItems,
  deduplicateBankTransactions,
  isManualInvoiceMatchCandidate,
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

  const isExpense =
    transaction.currency === "TWD" &&
    transaction.amount !== 0 &&
    (transaction.accountType === "credit" || transaction.amount < 0);
  if (!isExpense) throw new MappingTransactionNotExpenseError();

  if (!isManualInvoiceMatchCandidate(transaction, invoice))
    throw new MappingDateMismatchError();

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
