import {
  listBankAccounts,
  listBankTransactions,
  listBankTransactionsForTransferMatching,
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
import {
  findAutomaticCreditOffsetTransactionIds,
  findAutomaticTransferTransactionIds,
  getAutomaticTransferDay,
} from "./transfer-matching";

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
  // The counterpart can be on another page, so expand the set before classifying.
  const transactionsForClassification = await loadTransferCandidates(
    db,
    transactions,
  );
  let classificationMap: Map<string, ClassificationResult>;
  let classificationsReady = true;
  try {
    classificationMap = await resolveClassifications(
      db,
      transactionsForClassification.map((transaction) => ({
        id: transaction.id,
        description: transaction.description,
        counterparty: transaction.counterparty,
        sourceId: transaction.sourceId,
      })),
    );
  } catch (error) {
    console.error("[classify] resolveClassifications failed:", error);
    classificationMap = new Map();
    classificationsReady = false;
  }

  const eligibleTransactions = transactionsForClassification.filter(
    (transaction) => {
      const classification = classificationMap.get(transaction.id);
      return (
        // An explicit include preference or user classification wins.
        transaction.calculationPreference !== 0 &&
        classification?.source !== "override" &&
        classification?.source !== "user_rule"
      );
    },
  );
  const automaticTransferIds = classificationsReady
    ? findAutomaticTransferTransactionIds(eligibleTransactions)
    : new Set<string>();
  const automaticCreditOffsetIds = classificationsReady
    ? findAutomaticCreditOffsetTransactionIds(eligibleTransactions)
    : new Set<string>();

  return transactions.map(
    ({
      effectiveDate: _effectiveDate,
      updatedAt: _updatedAt,
      ...transaction
    }) => {
      const classification = automaticCreditOffsetIds.has(transaction.id)
        ? {
            categoryId: "fee",
            label: "手續費",
            source: "auto_offset" as const,
            excludedFromCalculation: true,
          }
        : automaticTransferIds.has(transaction.id)
          ? {
              categoryId: "transfer",
              label: "轉帳",
              source: "auto_transfer" as const,
              excludedFromCalculation: true,
            }
          : classificationMap.get(transaction.id);
      return {
        ...normalizeBankTransactionDisplay(transaction),
        excludedFromCalculation: resolveCalculationExclusion({
          accountType: transaction.accountType,
          description: transaction.description,
          counterparty: transaction.counterparty,
          calculationPreference: transaction.calculationPreference,
          classificationExcludedFromCalculation:
            classification?.excludedFromCalculation,
        }),
        classification,
      };
    },
  );
}

async function loadTransferCandidates(
  db: D1Database,
  transactions: BankTransactionPageRow[],
) {
  if (transactions.length === 0) return transactions;

  const visibleKeys = new Set(
    transactions
      .map(transferMatchKey)
      .filter((key): key is string => key !== undefined),
  );
  if (visibleKeys.size === 0) return transactions;

  let candidates: BankTransactionPageRow[];
  try {
    candidates = await listBankTransactionsForTransferMatching(
      db,
      transactions,
      [
        ...new Set(
          transactions
            .map(getAutomaticTransferDay)
            .filter((day): day is string => day !== undefined),
        ),
      ],
    );
  } catch (error) {
    console.error("[transfer] load transfer candidates failed:", error);
    return transactions;
  }

  const byId = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  for (const candidate of candidates) {
    if (visibleKeys.has(transferMatchKey(candidate) ?? ""))
      byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function transferMatchKey(transaction: BankTransactionPageRow) {
  const day = getAutomaticTransferDay(transaction);
  if (!day || !Number.isFinite(transaction.amount) || transaction.amount === 0)
    return undefined;
  const currency = transaction.currency.trim().toUpperCase();
  if (!currency) return undefined;
  return `${day}\u0000${currency}\u0000${Math.abs(transaction.amount)}`;
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
