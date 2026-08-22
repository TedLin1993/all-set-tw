export type TransferMatchTransaction = {
  id: string;
  accountId: string;
  amount: number;
  currency: string;
  accountType?: string | null;
  authorizedAt?: string | null;
  postedDate?: string | null;
  status?: string | null;
  description?: string | null;
  counterparty?: string | null;
};

type TransferCandidateGroup = {
  positive: TransferMatchTransaction[];
  negative: TransferMatchTransaction[];
};

const CREDIT_FEE_REDUCTION_PATTERN = /減免|折抵|回饋|退回|退費/u;

/**
 * Finds deterministic pairs of posted transactions that may represent a
 * transfer between two accounts. A pair must share the stored financial date
 * (using authorizedAt before postedDate, matching the date shown in Activity),
 * currency, and absolute amount while having opposite signs and different
 * accounts. The accounts may belong to the same bank. Credit-account
 * transactions are ignored because their signed entries commonly represent
 * card payments or refunds rather than account-to-account transfers.
 *
 * Same-account entries cannot form a transfer pair, so they are excluded from
 * the candidate edges. Each group is then matched one-to-one as far as
 * possible in a stable order; unmatched entries keep their existing
 * classification and can be changed manually by the user.
 */
export function findAutomaticTransferPairs(
  transactions: TransferMatchTransaction[],
): Array<readonly [string, string]> {
  const groups = new Map<string, TransferCandidateGroup>();

  for (const transaction of transactions) {
    if (transaction.status !== "posted") continue;
    if (transaction.accountType === "credit") continue;
    if (!Number.isFinite(transaction.amount) || transaction.amount === 0)
      continue;

    const day = getAutomaticTransferDay(transaction);
    if (!day) continue;

    const key = [
      day,
      transaction.currency.trim().toUpperCase(),
      Math.abs(transaction.amount),
    ].join("\u0000");
    const group = groups.get(key) ?? { positive: [], negative: [] };
    if (transaction.amount > 0) group.positive.push(transaction);
    else group.negative.push(transaction);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap(({ positive, negative }) =>
    pairCrossAccountCandidates(positive, negative),
  );
}

export function getAutomaticTransferDay(
  transaction: Pick<TransferMatchTransaction, "authorizedAt" | "postedDate">,
) {
  return storedFinancialDay(transaction.authorizedAt ?? transaction.postedDate);
}

export function findAutomaticTransferTransactionIds(
  transactions: TransferMatchTransaction[],
): Set<string> {
  const pairs = findAutomaticTransferPairs(transactions);
  return new Set(
    pairs.flatMap(([positiveId, negativeId]) => [positiveId, negativeId]),
  );
}

export function findAutomaticCreditOffsetTransactionIds(
  transactions: TransferMatchTransaction[],
): Set<string> {
  const pairs = findAutomaticCreditOffsetPairs(transactions);
  return new Set(
    pairs.flatMap(([positiveId, negativeId]) => [positiveId, negativeId]),
  );
}

/**
 * Finds same-card annual-fee reversals. These are not account transfers, but
 * they are a deliberate same-day, same-amount offset that should not affect
 * cash-flow calculations.
 */
export function findAutomaticCreditOffsetPairs(
  transactions: TransferMatchTransaction[],
): Array<readonly [string, string]> {
  const groups = new Map<string, TransferCandidateGroup>();

  for (const transaction of transactions) {
    if (
      transaction.status !== "posted" ||
      transaction.accountType !== "credit" ||
      !Number.isFinite(transaction.amount) ||
      transaction.amount === 0
    )
      continue;

    const day = getAutomaticTransferDay(transaction);
    if (!day) continue;

    const text = creditTransactionText(transaction);
    const isReduction = CREDIT_FEE_REDUCTION_PATTERN.test(text);
    if (!text.includes("年費") || transaction.amount > 0 !== isReduction)
      continue;

    const key = [
      transaction.accountId,
      day,
      transaction.currency.trim().toUpperCase(),
      Math.abs(transaction.amount),
    ].join("\u0000");
    const group = groups.get(key) ?? { positive: [], negative: [] };
    if (transaction.amount > 0) group.positive.push(transaction);
    else group.negative.push(transaction);
    groups.set(key, group);
  }

  return [...groups.values()].flatMap(({ positive, negative }) =>
    pairStableCandidates(positive, negative),
  );
}

function storedFinancialDay(value?: string | null) {
  if (!value) return undefined;

  const dateOnly = value.trim().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  // Bank connectors store the financial date in the timestamp prefix, and
  // Activity groups rows by that same prefix. Do not reinterpret it through
  // the runtime timezone: TDCC timestamps can represent a Taiwan local time
  // while carrying a UTC-looking suffix.
  if (dateOnly) return dateOnly;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;

  return parsed.toISOString().slice(0, 10);
}

function pairCrossAccountCandidates(
  positive: TransferMatchTransaction[],
  negative: TransferMatchTransaction[],
): Array<readonly [string, string]> {
  const orderedPositive = [...positive].sort(compareTransferCandidates);
  const orderedNegative = [...negative].sort(compareTransferCandidates);
  const matchedNegative = new Map<number, number>();

  for (
    let positiveIndex = 0;
    positiveIndex < orderedPositive.length;
    positiveIndex++
  ) {
    matchPositive(
      positiveIndex,
      new Set<number>(),
      orderedPositive,
      orderedNegative,
      matchedNegative,
    );
  }

  return [...matchedNegative.entries()]
    .sort(([, leftPositive], [, rightPositive]) => leftPositive - rightPositive)
    .map(([negativeIndex, positiveIndex]) => [
      orderedPositive[positiveIndex].id,
      orderedNegative[negativeIndex].id,
    ]);
}

function pairStableCandidates(
  positive: TransferMatchTransaction[],
  negative: TransferMatchTransaction[],
): Array<readonly [string, string]> {
  const orderedPositive = [...positive].sort(compareTransferCandidates);
  const orderedNegative = [...negative].sort(compareTransferCandidates);
  const pairCount = Math.min(orderedPositive.length, orderedNegative.length);

  return Array.from({ length: pairCount }, (_, index) => [
    orderedPositive[index].id,
    orderedNegative[index].id,
  ]);
}

function matchPositive(
  positiveIndex: number,
  visitedNegative: Set<number>,
  positive: TransferMatchTransaction[],
  negative: TransferMatchTransaction[],
  matchedNegative: Map<number, number>,
): boolean {
  for (
    let negativeIndex = 0;
    negativeIndex < negative.length;
    negativeIndex++
  ) {
    const candidate = negative[negativeIndex];
    if (
      visitedNegative.has(negativeIndex) ||
      positive[positiveIndex].accountId === candidate.accountId
    )
      continue;

    visitedNegative.add(negativeIndex);
    const previousPositive = matchedNegative.get(negativeIndex);
    if (
      previousPositive === undefined ||
      matchPositive(
        previousPositive,
        visitedNegative,
        positive,
        negative,
        matchedNegative,
      )
    ) {
      matchedNegative.set(negativeIndex, positiveIndex);
      return true;
    }
  }
  return false;
}

function compareTransferCandidates(
  left: TransferMatchTransaction,
  right: TransferMatchTransaction,
) {
  return left.id.localeCompare(right.id);
}

function creditTransactionText(transaction: TransferMatchTransaction) {
  return `${transaction.description ?? ""} ${transaction.counterparty ?? ""}`
    .normalize("NFKC")
    .replace(/\s+/gu, "");
}
