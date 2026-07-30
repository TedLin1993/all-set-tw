import type { ConnectorId } from "@taiwan-fin-hub/core";

const ESUN_BANK_CODE = "808";
const CATHAYBK_BANK_CODE = "013";
const CTBC_BANK_CODE = "822";
const TAIWAN_BANK_NAMES: Record<string, string> = {
  "004": "台灣銀行",
  "005": "土地銀行",
  "006": "合作金庫銀行",
  "007": "第一銀行",
  "008": "華南銀行",
  "009": "彰化銀行",
  "011": "上海商銀",
  "012": "台北富邦銀行",
  "013": "國泰世華銀行",
  "016": "高雄銀行",
  "017": "兆豐銀行",
  "048": "王道銀行",
  "050": "台灣企銀",
  "052": "渣打銀行",
  "053": "台中銀行",
  "054": "京城銀行",
  "081": "匯豐銀行",
  "103": "新光銀行",
  "108": "陽信銀行",
  "700": "中華郵政",
  "803": "聯邦銀行",
  "805": "遠東銀行",
  "806": "元大銀行",
  "807": "永豐銀行",
  "808": "玉山銀行",
  "809": "凱基銀行",
  "810": "星展銀行",
  "812": "台新銀行",
  "816": "安泰銀行",
  "822": "中國信託銀行",
  "823": "將來銀行",
  "824": "連線銀行",
  "826": "樂天銀行",
};

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
  if (connectorId === "esun" && sourceId.startsWith("bank:esun:")) {
    const last4 = sourceId.split(":")[2]?.replace(/\D/g, "").slice(-4) ?? "";
    return { bankCode: ESUN_BANK_CODE, last4: last4 || null };
  }
  if (connectorId === "cathaybk" && sourceId.startsWith("bank:cathaybk:")) {
    const last4 = sourceId.split(":")[2]?.replace(/\D/g, "").slice(-4) ?? "";
    return { bankCode: CATHAYBK_BANK_CODE, last4: last4 || null };
  }
  if (connectorId === "sinopac" && sourceId.startsWith("bank:sinopac:")) {
    const last4 = sourceId.split(":")[2]?.replace(/\D/g, "").slice(-4) ?? "";
    return { bankCode: "807", last4: last4 || null };
  }
  if (connectorId === "ctbc" && sourceId.startsWith("bank:ctbc:")) {
    const last4 = sourceId.split(":")[2]?.replace(/\D/g, "").slice(-4) ?? "";
    return { bankCode: CTBC_BANK_CODE, last4: last4 || null };
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

export function normalizeBankTransactionDisplay<T extends BankDisplayRow>(
  row: T,
): T {
  return row.accountType === "credit" ? row : normalizeDepositDisplay(row);
}

function normalizeDepositDisplay<T extends BankDisplayRow>(row: T): T {
  const sourceId = row.accountSourceId ?? row.sourceId ?? "";
  const settlement = parseBankAccountSource(sourceId);
  const bankCode =
    row.bankCode ??
    settlement.bankCode ??
    (row.connectorId === "esun"
      ? ESUN_BANK_CODE
      : row.connectorId === "cathaybk"
        ? CATHAYBK_BANK_CODE
        : row.connectorId === "ctbc"
          ? CTBC_BANK_CODE
          : undefined);
  const accountLast5 = accountLast5FromSourceId(sourceId);
  return {
    ...row,
    institutionName:
      (bankCode && TAIWAN_BANK_NAMES[bankCode]) || row.institutionName,
    accountName: accountLast5 ? `末五碼 ${accountLast5}` : row.accountName,
  };
}

function parseBankAccountSource(sourceId: string): {
  bankCode?: string;
  account?: string;
} {
  const settlement = sourceId.match(/^settlement:([^:]+):([^:]+)/);
  if (settlement) return { bankCode: settlement[1], account: settlement[2] };
  const esun = sourceId.match(/^bank:esun:([^:]+)/);
  if (esun) return { bankCode: ESUN_BANK_CODE, account: esun[1] };
  const cathaybk = sourceId.match(/^bank:cathaybk:([^:]+)/);
  if (cathaybk) return { bankCode: CATHAYBK_BANK_CODE, account: cathaybk[1] };
  const sinopac = sourceId.match(/^bank:sinopac:([^:]+)/);
  if (sinopac) return { bankCode: "807", account: sinopac[1] };
  const ctbc = sourceId.match(/^bank:ctbc:([^:]+)/);
  if (ctbc) return { bankCode: CTBC_BANK_CODE, account: ctbc[1] };
  return {};
}

function accountLast5FromSourceId(sourceId: string) {
  const account = parseBankAccountSource(sourceId).account;
  const digits = account?.replace(/\D/g, "") ?? "";
  return digits ? digits.slice(-5) : undefined;
}
