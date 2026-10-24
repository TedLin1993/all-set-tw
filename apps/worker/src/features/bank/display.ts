import { connectorBankCode, type ConnectorId } from "@taiwan-fin-hub/shared";
import { parseDepositSourceId } from "../../sources/deposit-source-registry";
import { TAIWAN_BANK_NAMES } from "../../sources/taiwan-banks";

type BankDisplayRow = {
  sourceId?: string;
  accountSourceId?: string;
  connectorId?: string;
  institutionName?: string | null;
  accountName?: string | null;
  accountType?: string | null;
  bankCode?: string | null;
  accountLast4?: string | null;
};

export function deriveBankMatchKey(
  connectorId: ConnectorId,
  sourceId: string,
): { bankCode: string | null; last4: string | null } {
  const deposit = parseDepositSourceId(sourceId);
  if (deposit?.connectorId === connectorId) {
    const last4 = deposit.account.replace(/\D/g, "").slice(-4);
    return { bankCode: deposit.bankCode, last4: last4 || null };
  }
  const match = sourceId.match(/^settlement:([^:]+):([^:]+)/);
  const last4 = match?.[2]?.replace(/\D/g, "").slice(-4) ?? "";
  return match
    ? { bankCode: match[1], last4: last4 || null }
    : { bankCode: null, last4: null };
}

export function normalizeBankAccountDisplay<T extends BankDisplayRow>(
  row: T,
): T {
  return row.accountType === "credit" ? row : normalizeDepositDisplay(row);
}

export function normalizeBankTransactionDisplay<
  T extends BankDisplayRow & {
    cardLast4?: string | null;
    cardName?: string | null;
  },
>(row: T) {
  // Card identity is folded into the account label, keeping the API contract.
  const { cardLast4, cardName, ...display } = row;
  if (row.accountType !== "credit") return normalizeDepositDisplay(display);
  if (!cardLast4) return display;
  return {
    ...display,
    accountName: `${cardName ?? display.accountName ?? "信用卡"} · ${cardLast4}`,
  };
}

function normalizeDepositDisplay<T extends BankDisplayRow>(row: T): T {
  const sourceId = row.accountSourceId ?? row.sourceId ?? "";
  const settlement = parseBankAccountSource(sourceId);
  const bankCode =
    row.bankCode ??
    settlement.bankCode ??
    connectorBankCode(row.connectorId ?? "");
  const accountSuffix = accountSuffixFromSourceId(sourceId);
  // 連接器組好的「名稱 末四碼 xxxx」（見 sources/deposit-account-name.ts）直接保留。
  if (hasMatchingAccountSuffix(row.accountName, sourceId))
    return {
      ...row,
      institutionName:
        (bankCode && TAIWAN_BANK_NAMES[bankCode]) || row.institutionName,
    };
  return {
    ...row,
    institutionName:
      (bankCode && TAIWAN_BANK_NAMES[bankCode]) || row.institutionName,
    accountName:
      row.accountType === "time_deposit" && row.accountName
        ? accountSuffix
          ? `${row.accountName} · ${accountSuffix}`
          : row.accountName
        : accountSuffix || row.accountName,
  };
}

/** 名稱以「 末四碼 xxxx」或「 末五碼 xxxxx」結尾，且末碼與 sourceId 的帳號一致。 */
function hasMatchingAccountSuffix(
  name: string | null | undefined,
  sourceId: string,
) {
  const digits =
    parseBankAccountSource(sourceId).account?.replace(/\D/g, "") ?? "";
  const suffix = name?.match(/ 末[四五]碼 (\d{4,5})$/)?.[1];
  return Boolean(digits && suffix && digits.endsWith(suffix));
}

function parseBankAccountSource(sourceId: string): {
  bankCode?: string;
  account?: string;
} {
  const settlement = sourceId.match(/^settlement:([^:]+):([^:]+)/);
  if (settlement) return { bankCode: settlement[1], account: settlement[2] };
  const deposit = parseDepositSourceId(sourceId);
  return deposit
    ? { bankCode: deposit.bankCode, account: deposit.account }
    : {};
}

function accountSuffixFromSourceId(sourceId: string) {
  const account = parseBankAccountSource(sourceId).account;
  const digits = account?.replace(/\D/g, "") ?? "";
  if (!digits) return undefined;
  const suffix = digits.slice(-5);
  return `末${suffix.length <= 4 ? "四" : "五"}碼 ${suffix}`;
}
