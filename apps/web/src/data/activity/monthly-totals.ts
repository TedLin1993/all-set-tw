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

export function calculateMonthlyActivityTotals(
  bank: BankData,
  invoices: InvoiceSummaryRow[],
  mappings: InvoiceTransactionPreference[],
  rates: Record<string, number>,
): MonthlyActivityTotals {
  const accounts = new Map(
    bank.accounts.map((account) => [account.id, account]),
  );
  const transactions = deduplicateBankTransactions(
    bank.transactions.map((transaction) => ({
      ...transaction,
      accountType:
        transaction.accountType ??
        accounts.get(transaction.accountId)?.accountType,
    })),
  );
  const matches = matchInvoicesToTransactions(transactions, invoices, mappings);

  const totals = transactions.reduce(
    (result, transaction) => {
      if (transaction.excludedFromCalculation) return result;
      const amount = transactionValueTwd(transaction, rates);
      if (amount > 0) result.income += amount;
      if (amount < 0) result.expense += Math.abs(amount);
      return result;
    },
    { income: 0, expense: 0 },
  );

  totals.expense += invoices
    .filter((invoice) => !matches.invoiceToTransactionId.has(invoice.id))
    .reduce((sum, invoice) => sum + Math.abs(invoice.amount), 0);

  return totals;
}
