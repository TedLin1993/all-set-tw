import {
  getAutomaticTransferDay,
  type TransferMatchTransaction,
} from "./transfer-matching";

/** Refunds normally post within a statement cycle or two of the purchase. */
export const REFUND_MATCH_WINDOW_DAYS = 90;

// Positive card entries with these words are rewards, payments or fee waivers.
const NON_REFUND_CREDIT_PATTERN =
  /折抵|回饋|減免|紅利|點數|年費|繳款|扣繳|入帳|還款/u;
const MIN_SHARED_MERCHANT_LENGTH = 4;
const MIN_SHARED_MERCHANT_RATIO = 0.6;
const DAY_MS = 24 * 60 * 60 * 1000;
// Wallets and payment gateways prefix many unrelated merchants; comparing the
// prefix would pair a refund with another store paid through the same wallet.
const PAYMENT_CHANNEL_PREFIX =
  /^\s*(?:連支|連加|line\s*pay|全支付|街口(?:支付)?|jko\s*pay|悠遊付|icash\s*pay|pi\s*拍錢包|全盈\+?\s*pay|綠界|ecpay|藍新|newebpay|tappay)\s*[*＊\-－﹘—–_/:：·・]+/iu;

function rawText(transaction: TransferMatchTransaction) {
  return `${transaction.description ?? ""} ${transaction.counterparty ?? ""}`.normalize(
    "NFKC",
  );
}

function merchantKey(transaction: TransferMatchTransaction) {
  return (transaction.description ?? transaction.counterparty ?? "")
    .normalize("NFKC")
    .replace(PAYMENT_CHANNEL_PREFIX, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function longestCommonSubstringLength(left: string, right: string) {
  let longest = 0;
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] !== right[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      longest = Math.max(longest, current[j]);
    }
    previous = current;
  }
  return longest;
}

/**
 * Card descriptors for a refund often repeat the purchase descriptor, or keep
 * the merchant name with a different acquirer prefix, merchant category or a
 * city/country suffix. The shared run must be a real name (at least 4
 * characters) and cover most of the shorter descriptor, so a common word such
 * as 商行 or a city name alone never pairs two merchants.
 */
function isSameMerchant(left: string, right: string) {
  if (!left || !right) return false;
  if (left === right) return true;
  const shared = longestCommonSubstringLength(left, right);
  return (
    shared >= MIN_SHARED_MERCHANT_LENGTH &&
    shared >=
      Math.ceil(Math.min(left.length, right.length) * MIN_SHARED_MERCHANT_RATIO)
  );
}

function dayDifference(fromDay: string, toDay: string) {
  return (
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) /
    DAY_MS
  );
}

function shiftDay(day: string, days: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** A positive merchant entry on a card that may return part of an earlier purchase. */
export function isRefundCandidate(transaction: TransferMatchTransaction) {
  return (
    transaction.accountType === "credit" &&
    Number.isFinite(transaction.amount) &&
    transaction.amount > 0 &&
    getAutomaticTransferDay(transaction) !== undefined &&
    merchantKey(transaction).length > 0 &&
    !NON_REFUND_CREDIT_PATTERN.test(rawText(transaction))
  );
}

/** Day range that contains every purchase the given refunds could return. */
export function refundOriginalDayRange(
  transactions: TransferMatchTransaction[],
) {
  const days = transactions
    .filter(isRefundCandidate)
    .map(getAutomaticTransferDay)
    .filter((day): day is string => day !== undefined)
    .sort();
  if (days.length === 0) return undefined;
  return {
    from: shiftDay(days[0], -REFUND_MATCH_WINDOW_DAYS),
    to: days.at(-1)!,
  };
}

/**
 * Pairs each refund with the purchase it returns: an earlier charge on the same
 * card and currency, from the same merchant, within the refund window and at
 * least as large as the refund. Partial and split refunds may share one
 * purchase. An exact amount wins, then the nearest earlier charge.
 *
 * @returns refund transaction id → purchase transaction id
 */
export function matchRefundsToPurchases(
  refunds: TransferMatchTransaction[],
  purchases: TransferMatchTransaction[],
): Map<string, string> {
  const purchaseCandidates = purchases.flatMap((purchase) => {
    const day = getAutomaticTransferDay(purchase);
    return purchase.accountType === "credit" &&
      Number.isFinite(purchase.amount) &&
      purchase.amount < 0 &&
      day
      ? [{ purchase, day, merchant: merchantKey(purchase) }]
      : [];
  });
  const matches = new Map<string, string>();

  for (const refund of refunds) {
    if (!isRefundCandidate(refund)) continue;
    const refundDay = getAutomaticTransferDay(refund)!;
    const merchant = merchantKey(refund);
    const currency = refund.currency.trim().toUpperCase();
    let best: { id: string; exact: boolean; age: number } | undefined;

    for (const {
      purchase,
      day,
      merchant: purchaseMerchant,
    } of purchaseCandidates) {
      const age = dayDifference(day, refundDay);
      if (
        purchase.id === refund.id ||
        purchase.accountId !== refund.accountId ||
        purchase.currency.trim().toUpperCase() !== currency ||
        -purchase.amount < refund.amount ||
        age < 0 ||
        age > REFUND_MATCH_WINDOW_DAYS ||
        !isSameMerchant(merchant, purchaseMerchant)
      )
        continue;
      const candidate = {
        id: purchase.id,
        exact: -purchase.amount === refund.amount,
        age,
      };
      if (
        !best ||
        (candidate.exact && !best.exact) ||
        (candidate.exact === best.exact &&
          (candidate.age < best.age ||
            (candidate.age === best.age && candidate.id < best.id)))
      )
        best = candidate;
    }
    if (best) matches.set(refund.id, best.id);
  }
  return matches;
}

function financialTime(transaction: TransferMatchTransaction) {
  return transaction.authorizedAt ?? transaction.postedDate ?? "";
}

/**
 * Pairs each full refund one to one with a purchase on the same card, day and
 * currency, from the same merchant and of the exact amount. Such a pair is
 * usually a cancelled order or a card verification hold that nets to zero, so
 * both sides leave the calculations.
 *
 * @returns ids of both sides of every pair
 */
export function findSameDayRefundOffsetTransactionIds(
  transactions: TransferMatchTransaction[],
): Set<string> {
  const byTime = (
    left: TransferMatchTransaction,
    right: TransferMatchTransaction,
  ) =>
    financialTime(left).localeCompare(financialTime(right)) ||
    left.id.localeCompare(right.id);
  const purchases = transactions
    .filter(
      (transaction) =>
        transaction.accountType === "credit" &&
        Number.isFinite(transaction.amount) &&
        transaction.amount < 0 &&
        getAutomaticTransferDay(transaction) !== undefined,
    )
    .sort(byTime);
  const ids = new Set<string>();

  for (const refund of transactions.filter(isRefundCandidate).sort(byTime)) {
    const day = getAutomaticTransferDay(refund);
    const merchant = merchantKey(refund);
    const currency = refund.currency.trim().toUpperCase();
    const purchase = purchases.find(
      (candidate) =>
        !ids.has(candidate.id) &&
        candidate.accountId === refund.accountId &&
        candidate.currency.trim().toUpperCase() === currency &&
        -candidate.amount === refund.amount &&
        getAutomaticTransferDay(candidate) === day &&
        isSameMerchant(merchant, merchantKey(candidate)),
    );
    if (!purchase) continue;
    ids.add(purchase.id);
    ids.add(refund.id);
  }
  return ids;
}
