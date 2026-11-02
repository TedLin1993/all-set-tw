import {
  buildActivityItems,
  deduplicateBankTransactions,
  isManualInvoiceMatchCandidate,
  matchInvoicesToTransactions,
} from "@taiwan-fin-hub/shared";
import { getBankRange, getBankTransactionsByIds } from "../bank/service";
import { getInvestmentTransactionsRange } from "../investments/service";
import { getInvoicesByIds, getInvoicesRange } from "../invoices/service";
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

type LinkPreference = {
  invoiceId: string;
  transactionId: string | null;
  decision: "linked" | "separate";
};

/**
 * 自動配對只在同一天，跨日的配對一定是手動建立並存於配對表；
 * 依 linked 紀錄補讀不在本批資料中的另一端，讓配對結果不受讀取日期範圍影響。
 * 補讀的資料只供配對，呼叫端仍須依自己的範圍篩選要呈現的活動。
 */
export async function loadLinkedCounterparts(
  db: D1Database,
  transactions: ReadonlyArray<{ id: string }>,
  invoices: ReadonlyArray<{ id: string }>,
  preferences: ReadonlyArray<LinkPreference>,
) {
  const transactionIds = new Set(transactions.map(({ id }) => id));
  const invoiceIds = new Set(invoices.map(({ id }) => id));
  const missingTransactionIds: string[] = [];
  const missingInvoiceIds: string[] = [];
  for (const { invoiceId, transactionId, decision } of preferences) {
    if (decision !== "linked" || !transactionId) continue;
    const hasTransaction = transactionIds.has(transactionId);
    const hasInvoice = invoiceIds.has(invoiceId);
    if (hasTransaction && !hasInvoice) missingInvoiceIds.push(invoiceId);
    if (hasInvoice && !hasTransaction)
      missingTransactionIds.push(transactionId);
  }
  const [linkedTransactions, linkedInvoices] = await Promise.all([
    getBankTransactionsByIds(db, missingTransactionIds),
    getInvoicesByIds(db, missingInvoiceIds),
  ]);
  return { transactions: linkedTransactions, invoices: linkedInvoices };
}

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
  const linked = await loadLinkedCounterparts(
    db,
    bank.transactions,
    invoiceRows,
    preferences,
  );
  const invoices = [...invoiceRows, ...linked.invoices];
  const accounts = new Map(
    bank.accounts.map((account) => [
      String(account.id),
      { ...account, id: String(account.id) },
    ]),
  );
  const transactions = deduplicateBankTransactions(
    [...bank.transactions, ...linked.transactions].map((transaction) => ({
      ...transaction,
      accountType:
        transaction.accountType ??
        accounts.get(transaction.accountId)?.accountType,
    })),
  );
  const matches = matchInvoicesToTransactions(
    transactions,
    invoices,
    preferences,
  );
  return buildActivityItems(transactions, invoices, trades, accounts, matches);
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
