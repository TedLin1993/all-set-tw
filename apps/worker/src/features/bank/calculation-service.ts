import {
  bankTransactionExists,
  upsertCalculationPreference,
} from "./calculation-repository";

export type CalculationTransaction = {
  transferPeerId?: string | null;
  accountType?: string | null;
  description?: string | null;
  counterparty?: string | null;
  calculationPreference?: number | null;
  classificationExcludedFromCalculation?: boolean | null;
};

export class BankTransactionNotFoundError extends Error {}

function calculationText(transaction: CalculationTransaction) {
  const normalized =
    `${transaction.description ?? ""} ${transaction.counterparty ?? ""}`
      .normalize("NFKC")
      .toLowerCase();
  return {
    compact: normalized.replace(/[\s\p{P}\p{S}]+/gu, ""),
    words: normalized.replace(/[^a-z0-9]+/g, " ").trim(),
  };
}

export function isDefaultCalculationExcluded(
  transaction: CalculationTransaction,
) {
  if (transaction.accountType === "time_deposit" && transaction.transferPeerId)
    return true;
  const { compact, words } = calculationText(transaction);
  const paddedWords = ` ${words} `;

  if (compact.includes("卡費") || compact.includes("繳卡款")) return true;
  if (compact.includes("繳信用卡")) return true;
  if (
    compact.includes("信用卡") &&
    ["繳款", "扣款", "還款", "自扣", "自動扣繳"].some((keyword) =>
      compact.includes(keyword),
    )
  )
    return true;
  if (paddedWords.includes(" card payment ")) return true;

  if (transaction.accountType === "credit") {
    if (compact.includes("繳款入帳") || compact.includes("自扣已入帳"))
      return true;
    if (paddedWords.includes(" payment received ")) return true;
  }

  return false;
}

export function resolveCalculationExclusion(
  transaction: CalculationTransaction,
) {
  if (
    transaction.calculationPreference === 0 ||
    transaction.calculationPreference === 1
  ) {
    return transaction.calculationPreference === 1;
  }
  if (transaction.classificationExcludedFromCalculation) return true;
  return isDefaultCalculationExcluded(transaction);
}

export async function setCalculationPreference(
  db: D1Database,
  transactionId: string,
  excludedFromCalculation: boolean,
) {
  if (!(await bankTransactionExists(db, transactionId))) {
    throw new BankTransactionNotFoundError();
  }
  await upsertCalculationPreference(
    db,
    transactionId,
    excludedFromCalculation,
    new Date().toISOString(),
  );
}
