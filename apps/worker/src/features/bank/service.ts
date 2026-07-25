import {
  listBankAccounts,
  listBankTransactions,
  listBankTransactionsInRange,
  listCreditCardBills,
  listCreditCardBillsInRange,
  type BankTransactionPageRow,
  type CreditCardBillPageCursor,
} from "./repository";
import type { TransactionPageCursor } from "../investments/repository";
import type { MonthDateRange } from "../../platform/month-range";
import {
  normalizeBankAccountDisplay,
  normalizeBankTransactionDisplay,
} from "./display";
import { resolveCalculationExclusion } from "./calculation-service";
import {
  resolveClassifications,
  type ClassificationResult,
} from "../classification/service";

export async function getBankPage(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  const [accounts, transactions] = await Promise.all([
    listBankAccounts(db),
    listBankTransactions(db, limit + 1, cursor),
  ]);
  const hasMore = transactions.length > limit;
  const page = transactions.slice(0, limit);
  return {
    hasMore,
    last: page.at(-1),
    accounts: accounts.map(normalizeBankAccountDisplay),
    transactions: await presentBankTransactions(db, page),
  };
}

export async function getBankRange(db: D1Database, range: MonthDateRange) {
  const [accounts, transactions] = await Promise.all([
    listBankAccounts(db),
    listBankTransactionsInRange(db, range),
  ]);
  return {
    accounts: accounts.map(normalizeBankAccountDisplay),
    transactions: await presentBankTransactions(db, transactions),
  };
}

async function presentBankTransactions(
  db: D1Database,
  transactions: BankTransactionPageRow[],
) {
  let classificationMap: Map<string, ClassificationResult>;
  try {
    classificationMap = await resolveClassifications(
      db,
      transactions.map((transaction) => ({
        id: transaction.id,
        description: transaction.description,
        counterparty: transaction.counterparty,
        sourceId: transaction.sourceId,
      })),
    );
  } catch (error) {
    console.error("[classify] resolveClassifications failed:", error);
    classificationMap = new Map();
  }
  return transactions.map(
    ({
      effectiveDate: _effectiveDate,
      updatedAt: _updatedAt,
      ...transaction
    }) => ({
      ...normalizeBankTransactionDisplay(transaction),
      excludedFromCalculation: resolveCalculationExclusion({
        accountType: transaction.accountType,
        description: transaction.description,
        counterparty: transaction.counterparty,
        calculationPreference: transaction.calculationPreference,
        classificationExcludedFromCalculation: classificationMap.get(
          transaction.id,
        )?.excludedFromCalculation,
      }),
      classification: classificationMap.get(transaction.id),
    }),
  );
}

export async function getCreditCardBillPage(
  db: D1Database,
  limit: number,
  cursor?: CreditCardBillPageCursor,
) {
  const rows = await listCreditCardBills(db, limit + 1, cursor);
  const hasMore = rows.length > limit;
  const bills = rows.slice(0, limit);
  return { hasMore, bills, last: bills.at(-1) };
}

export async function getCreditCardBillsRange(
  db: D1Database,
  range: MonthDateRange,
) {
  return listCreditCardBillsInRange(db, range);
}
