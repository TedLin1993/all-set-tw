import {
  listBankAccounts,
  listBankTransactions,
  listBankTransactionsForRefundMatching,
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
  classificationOverrideLookupIds,
  classifyTransactions,
  type ClassificationResult,
} from "../classification/service";
import {
  listClassificationOverrides,
  listEnabledClassificationRules,
  type ClassificationRuleMatchRow,
} from "../classification/repository";
import {
  findAutomaticCreditOffsetTransactionIds,
  findAutomaticTransferTransactionIds,
  getAutomaticTransferDay,
} from "./transfer-matching";
import {
  isRefundCandidate,
  matchRefundsToPurchases,
  refundOriginalDayRange,
} from "./refund-matching";

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Started early and awaited later; settling keeps a rejection from going unhandled.
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function loadClassificationRules(db: D1Database) {
  // Rules do not depend on the transactions, so fetch them in the first D1 round trip.
  return settle(listEnabledClassificationRules(db));
}

export async function getBankAccounts(db: D1Database) {
  return (await listBankAccounts(db)).map(normalizeBankAccountDisplay);
}

export async function getBankPage(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  const rules = loadClassificationRules(db);
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
    transactions: await presentBankTransactions(db, page, rules),
  };
}

export async function getBankRange(
  db: D1Database,
  range: MonthDateRange,
  days?: string[],
  accountRows?: Awaited<ReturnType<typeof listBankAccounts>>,
) {
  const rules = loadClassificationRules(db);
  const [accounts, transactions] = await Promise.all([
    accountRows ? Promise.resolve(accountRows) : listBankAccounts(db),
    listBankTransactionsInRange(db, range, days),
  ]);
  return {
    accounts: accounts.map(normalizeBankAccountDisplay),
    transactions: await presentBankTransactions(db, transactions, rules),
  };
}

function loadClassificationOverrides(
  db: D1Database,
  transactions: BankTransactionPageRow[],
) {
  return settle(
    transactions.length > 0
      ? listClassificationOverrides(
          db,
          classificationOverrideLookupIds(transactions),
        )
      : Promise.resolve([]),
  );
}

async function presentBankTransactions(
  db: D1Database,
  transactions: BankTransactionPageRow[],
  rules: Promise<Settled<ClassificationRuleMatchRow[]>>,
) {
  // Page overrides load beside the transfer candidates; only candidates from
  // outside the page need a further round trip.
  const pageOverrides = loadClassificationOverrides(db, transactions);
  // The counterpart can be on another page, so expand the set before classifying.
  const [transferCandidates, refundPurchaseCandidates] = await Promise.all([
    loadTransferCandidates(db, transactions),
    loadRefundPurchaseCandidates(db, transactions),
  ]);
  const transactionsById = new Map(
    transferCandidates.map((transaction) => [transaction.id, transaction]),
  );
  for (const candidate of refundPurchaseCandidates)
    if (!transactionsById.has(candidate.id))
      transactionsById.set(candidate.id, candidate);
  const transactionsForClassification = [...transactionsById.values()];
  const pageIds = new Set(transactions.map((transaction) => transaction.id));
  const [rulesResult, pageOverridesResult, candidateOverridesResult] =
    await Promise.all([
      rules,
      pageOverrides,
      loadClassificationOverrides(
        db,
        transactionsForClassification.filter(
          (transaction) => !pageIds.has(transaction.id),
        ),
      ),
    ]);
  let classificationMap: Map<string, ClassificationResult>;
  let classificationsReady = true;
  try {
    if (!rulesResult.ok) throw rulesResult.error;
    if (!pageOverridesResult.ok) throw pageOverridesResult.error;
    if (!candidateOverridesResult.ok) throw candidateOverridesResult.error;
    classificationMap = classifyTransactions(
      transactionsForClassification.map((transaction) => ({
        id: transaction.id,
        description: transaction.description,
        counterparty: transaction.counterparty,
        sourceId: transaction.sourceId,
        amount: transaction.amount,
      })),
      [...pageOverridesResult.value, ...candidateOverridesResult.value],
      rulesResult.value,
    );
  } catch (error) {
    console.error("[classify] resolveClassifications failed:", error);
    classificationMap = new Map();
    classificationsReady = false;
  }

  const eligibleTransactions = transferCandidates.filter((transaction) => {
    const classification = classificationMap.get(transaction.id);
    return (
      // An explicit include preference or user classification wins.
      transaction.calculationPreference !== 0 &&
      classification?.source !== "override" &&
      classification?.source !== "user_rule"
    );
  });
  const automaticTransferIds = classificationsReady
    ? findAutomaticTransferTransactionIds(eligibleTransactions)
    : new Set<string>();
  const automaticCreditOffsetIds = classificationsReady
    ? findAutomaticCreditOffsetTransactionIds(eligibleTransactions)
    : new Set<string>();
  const refundPurchaseIds = classificationsReady
    ? matchRefundsToPurchases(
        transactions,
        transactionsForClassification.filter(
          (transaction) =>
            !resolveCalculationExclusion({
              ...transaction,
              classificationExcludedFromCalculation: classificationMap.get(
                transaction.id,
              )?.excludedFromCalculation,
            }),
        ),
      )
    : new Map<string, string>();

  // A refund takes its purchase's category. A rule or manual category still
  // wins, and only counts as a refund when it agrees with the purchase.
  const refundClassification = (
    transactionId: string,
  ): ClassificationResult | undefined => {
    const purchaseId = refundPurchaseIds.get(transactionId);
    const own = classificationMap.get(transactionId);
    const purchase = purchaseId ? classificationMap.get(purchaseId) : undefined;
    if (!own || !purchase) return own;
    if (own.source === "fallback")
      return {
        categoryId: purchase.categoryId,
        label: purchase.label,
        source: "auto_refund",
        refund: true,
      };
    return own.categoryId === purchase.categoryId
      ? { ...own, refund: true }
      : own;
  };

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
          : refundClassification(transaction.id);
      return {
        ...normalizeBankTransactionDisplay(transaction),
        excludedFromCalculation: resolveCalculationExclusion({
          transferPeerId: transaction.transferPeerId,
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

/** Loads earlier card purchases that refunds on the page may return. */
async function loadRefundPurchaseCandidates(
  db: D1Database,
  transactions: BankTransactionPageRow[],
) {
  const refunds = transactions.filter(isRefundCandidate);
  const range = refundOriginalDayRange(refunds);
  if (!range) return [];
  try {
    return await listBankTransactionsForRefundMatching(
      db,
      [...new Set(refunds.map((refund) => refund.accountId))],
      range,
    );
  } catch (error) {
    console.error("[refund] load refund candidates failed:", error);
    return [];
  }
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
