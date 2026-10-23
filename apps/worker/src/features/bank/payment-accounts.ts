import type { BankAccountResponse } from "@taiwan-fin-hub/shared";
import type { listBankAccounts, listPaymentAccountSources } from "./repository";

type AccountRow = Awaited<ReturnType<typeof listBankAccounts>>[number];
type SourceRow = Awaited<ReturnType<typeof listPaymentAccountSources>>[number];

export type PaymentAccountFields = Required<
  Pick<
    BankAccountResponse,
    "paymentAccountId" | "paymentAccountSource" | "bankAutopay"
  >
>;

export class BankAccountNotFoundError extends Error {}
export class InvalidPaymentAccountError extends Error {}

const NON_PAYMENT_TYPES = new Set([
  "credit",
  "loan",
  "time_deposit",
  "stored_value",
]);

/**
 * 扣款帳戶須是活存類帳戶，且與款項同幣別或為台幣帳戶（外幣帳單常由台幣帳戶
 * 換匯自動扣繳）；信用卡、貸款、定存與儲值帳戶不能扣款。
 */
export function canPayFrom(
  payer: Pick<AccountRow, "accountType" | "currency">,
  target: Pick<AccountRow, "currency">,
) {
  return (
    !NON_PAYMENT_TYPES.has(payer.accountType ?? "") &&
    (payer.currency === target.currency || payer.currency === "TWD")
  );
}

export function isPaymentTarget(account: Pick<AccountRow, "accountType">) {
  return account.accountType === "credit" || account.accountType === "loan";
}

/**
 * 銀行提供的自動扣繳帳戶只在唯一對應時採用：有存款 sourceId 時精準比對，
 * 否則需同時符合銀行代碼與末四碼。對不到或不唯一時交由使用者手動指定。
 */
function matchAutopayAccount(source: SourceRow, candidates: AccountRow[]) {
  const matches = source.autopayAccountSourceId
    ? candidates.filter(
        (item) => item.sourceId === source.autopayAccountSourceId,
      )
    : source.autopayBankCode && source.autopayAccountLast4
      ? candidates.filter(
          (item) =>
            item.bankCode === source.autopayBankCode &&
            item.accountLast4 === source.autopayAccountLast4,
        )
      : [];
  return matches.length === 1 ? matches[0]!.id : null;
}

/** 手動設定優先；指定的帳戶已不存在或不再符合條件時，退回銀行提供的資料。 */
export function resolvePaymentAccounts(
  accounts: AccountRow[],
  sources: SourceRow[],
) {
  const byId = new Map(accounts.map((item) => [item.id, item]));
  const result = new Map<string, PaymentAccountFields>();
  for (const source of sources) {
    const target = byId.get(source.id);
    if (!target || !isPaymentTarget(target)) continue;
    const candidates = accounts.filter((item) => canPayFrom(item, target));
    const bankAccountId =
      source.autopayStatus === "enabled"
        ? matchAutopayAccount(source, candidates)
        : null;
    const bankAutopay: PaymentAccountFields["bankAutopay"] =
      source.autopayStatus === null
        ? null
        : {
            status: source.autopayStatus,
            last4:
              source.autopayStatus === "enabled"
                ? source.autopayAccountLast4
                : null,
            accountId: bankAccountId,
          };

    if (source.overrideAccountId !== null) {
      const manual = source.overridePaymentAccountId;
      if (manual === null || candidates.some((item) => item.id === manual)) {
        result.set(source.id, {
          paymentAccountId: manual,
          paymentAccountSource: "manual",
          bankAutopay,
        });
        continue;
      }
    }
    if (bankAccountId) {
      result.set(source.id, {
        paymentAccountId: bankAccountId,
        paymentAccountSource: "bank",
        bankAutopay,
      });
      continue;
    }
    // 銀行沒提供扣款資料時，以同一資料來源（同銀行）唯一的同幣別存款帳戶推測。
    // 銀行明確顯示未設定或扣款帳戶對不到時不推測，避免誤用其他帳戶的餘額。
    const sameBank =
      source.autopayStatus === null
        ? candidates.filter(
            (item) =>
              item.connectorId === target.connectorId &&
              item.currency === target.currency,
          )
        : [];
    result.set(source.id, {
      paymentAccountId: sameBank.length === 1 ? sameBank[0]!.id : null,
      paymentAccountSource: sameBank.length === 1 ? "inferred" : null,
      bankAutopay,
    });
  }
  return result;
}

/** 驗證手動指定的扣款帳戶；不符合時拋出對應錯誤。 */
export function assertPaymentAccount(
  accounts: AccountRow[],
  accountId: string,
  paymentAccountId: string | null,
) {
  const target = accounts.find((item) => item.id === accountId);
  if (!target || !isPaymentTarget(target))
    throw new BankAccountNotFoundError("Bank account not found.");
  if (paymentAccountId === null) return;
  const payer = accounts.find((item) => item.id === paymentAccountId);
  if (!payer || !canPayFrom(payer, target))
    throw new InvalidPaymentAccountError(
      "Payment account must be an active deposit account in the same currency or TWD.",
    );
}
