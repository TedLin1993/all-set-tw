import type { BankData, BankTransactionRow } from "@/data/bank/types";
import type {
  InvoiceSummaryRow,
  InvoiceTransactionPreference,
} from "@/data/invoices/types";
import { transactionValueTwd } from "@/shared/format/financial";
import {
  deduplicateBankTransactions,
  matchInvoicesToTransactions,
} from "./matching";

export interface MonthlyActivityTotals {
  income: number;
  expense: number;
}

/**
 * linkedTransactions 是區間外、但已與區間內發票連結的交易：只用來配對發票，
 * 本身屬於其他月份，不計入這個區間的收支。
 */
export function calculateMonthlyActivityTotals(
  bank: BankData,
  invoices: InvoiceSummaryRow[],
  mappings: InvoiceTransactionPreference[],
  rates: Record<string, number>,
  linkedTransactions: BankTransactionRow[] = [],
): MonthlyActivityTotals {
  const accounts = new Map(
    bank.accounts.map((account) => [account.id, account]),
  );
  const withAccountType = (transaction: BankTransactionRow) => ({
    ...transaction,
    accountType:
      transaction.accountType ??
      accounts.get(transaction.accountId)?.accountType,
  });
  const transactions = deduplicateBankTransactions(
    bank.transactions.map(withAccountType),
  );
  const matches = matchInvoicesToTransactions(
    [...transactions, ...linkedTransactions.map(withAccountType)],
    invoices,
    mappings,
  );

  const totals = transactions.reduce(
    (result, transaction) => {
      if (transaction.excludedFromCalculation) return result;
      const amount = transactionValueTwd(transaction, rates);
      // A merchant refund reduces spending instead of counting as income.
      if (amount > 0 && transaction.classification?.refund)
        result.expense -= amount;
      else if (amount > 0) result.income += amount;
      if (amount < 0) result.expense += Math.abs(amount);
      return result;
    },
    { income: 0, expense: 0 },
  );

  totals.expense += invoices
    .filter(
      (invoice) =>
        !invoice.excludedFromCalculation &&
        !matches.invoiceToTransactionId.has(invoice.id),
    )
    .reduce((sum, invoice) => sum + Math.abs(invoice.amount), 0);

  return totals;
}
