import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { z } from "zod";

export const obankConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  pendingSession: z.string().optional(),
  pendingSessionExpiresAt: z.string().optional(),
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

export type ObankConfig = z.infer<typeof obankConfigSchema>;

export function parseObankConfig(config: unknown): ObankConfig {
  return obankConfigSchema.parse(config);
}

export type ObankPayloads = {
  demandDeposits: unknown;
  timeDeposits?: unknown;
  transactionResponses?: unknown[];
};

export type ObankData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;
type ParsedAccount = {
  sourceId: string;
  externalId: string;
  last4?: string;
  last5?: string;
  name: string;
  type: "savings" | "time_deposit";
  currency: string;
  balance: number;
  availableBalance?: number;
};

export function parseObankData(
  payloads: ObankPayloads,
  now = new Date(),
): ObankData {
  const demandAccounts = parseDemandDepositAccounts(payloads.demandDeposits);
  const timeDepositAccounts = parseTimeDepositAccounts(payloads.timeDeposits);
  const accounts = dedupeBySourceId([
    ...demandAccounts,
    ...timeDepositAccounts,
  ]);
  const accountSourceIds = new Map(
    demandAccounts.flatMap((account) => [
      [account.externalId, account.sourceId] as const,
      ...(account.last4
        ? ([
            [`${account.last4}:${account.currency}`, account.sourceId],
          ] as const)
        : []),
    ]),
  );
  const asOfAt = now.toISOString();

  const bankAccounts: ObankData["bankAccounts"] = accounts.map((account) => ({
    sourceId: account.sourceId,
    institutionName: "王道銀行",
    accountName:
      account.name ||
      (account.last5
        ? `${account.type === "time_deposit" ? "定存" : "存款"}末五碼 ${account.last5}`
        : account.type === "time_deposit"
          ? "王道銀行定存"
          : "王道銀行存款帳戶"),
    accountType: account.type,
    currency: account.currency,
    raw: sanitizeAccount(account),
  }));
  const bankBalanceSnapshots: ObankData["bankBalanceSnapshots"] = accounts.map(
    (account) => ({
      accountId: account.sourceId,
      sourceId: `${account.sourceId}:${asOfAt}`,
      balance: account.balance,
      availableBalance: account.availableBalance,
      currency: account.currency,
      asOfAt,
      raw: sanitizeAccount(account),
    }),
  );
  const bankTransactions = dedupeBySourceId(
    (payloads.transactionResponses ?? []).flatMap((payload) =>
      parseTransactionResponse(payload, accountSourceIds),
    ),
  );

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
  };
}

function parseDemandDepositAccounts(payload: unknown): ParsedAccount[] {
  const response = responseData(payload);
  const groups = firstArray(response, [
    "userAccounts",
    "cdAccounts",
    "accounts",
    "depositAccounts",
  ]);
  return groups.flatMap((groupValue) => {
    if (!isRecord(groupValue)) return [];
    const group = groupValue;
    const groupAccount = firstString(group, [
      "accountNo",
      "acctNo",
      "masterAccountNo",
    ]);
    const groupName = firstString(group, [
      "accountName",
      "aliasName",
      "accountNameWithAcctNo",
      "productName",
    ]);
    const items = firstArray(group, [
      "accountItems",
      "subAccounts",
      "currencyAccounts",
    ]);
    const candidates = items.length > 0 ? items : [group];
    return candidates.flatMap((itemValue) => {
      if (!isRecord(itemValue)) return [];
      const item = itemValue;
      const externalId =
        firstString(item, ["accountItemNo", "subAccountItemNo", "acctNo"]) ||
        firstString(group, ["accountItemNo", "masterAccountItemNo"]) ||
        groupAccount;
      const accountNumber =
        firstString(item, ["acctNo", "accountNo", "displayAccountNo"]) ||
        groupAccount;
      const currency = normalizeCurrency(
        firstString(item, ["curr", "currency", "curry"]),
      );
      const balance = firstNumber(item, [
        "actBal",
        "actualBalance",
        "workingBalance",
        "workBal",
        "displayActBalNoCurr",
        "displayWorkingBalance",
        "displayWorkBalNoCurr",
      ]);
      if (!externalId || !currency || balance == null) return [];
      const availableBalance = firstNumber(item, [
        "availableBalance",
        "availableBal",
        "workBal",
        "workingBalance",
        "displayWorkBalNoCurr",
      ]);
      const digits = digitsOnly(accountNumber);
      return [
        {
          sourceId: accountSourceId(
            "savings",
            externalId,
            digits.slice(-4),
            currency,
          ),
          externalId,
          last4: digits.slice(-4) || undefined,
          last5: digits.slice(-5) || undefined,
          name:
            firstString(item, ["aliasName", "accountName", "productName"]) ||
            stripAccountNumber(groupName),
          type: "savings" as const,
          currency,
          balance,
          availableBalance,
        },
      ];
    });
  });
}

function parseTimeDepositAccounts(payload: unknown): ParsedAccount[] {
  const response = responseData(payload);
  const repeats = firstArray(response, [
    "repeats",
    "timeDeposits",
    "tdAccounts",
    "depositItems",
  ]);
  return repeats.flatMap((value) => {
    if (!isRecord(value)) return [];
    const detail = isRecord(value.tdDetail) ? value.tdDetail : value;
    const externalId = firstString(detail, [
      "tdAccountItemNo",
      "accountItemNo",
      "tdAccountNumber",
      "accountNo",
    ]);
    const accountNumber = firstString(detail, [
      "tdAccountNumber",
      "accountNo",
      "displayAccountNo",
    ]);
    const currency = normalizeCurrency(
      firstString(detail, ["currency", "curr", "curry"]),
    );
    const balance = firstNumber(detail, [
      "workingBalance",
      "principalAmount",
      "amount",
      "displayWorkingBalance",
      "displayAmount",
    ]);
    if (!externalId || !currency || balance == null) return [];
    const digits = digitsOnly(accountNumber || externalId);
    return [
      {
        sourceId: accountSourceId(
          "time-deposit",
          externalId,
          digits.slice(-4),
          currency,
        ),
        externalId,
        last4: digits.slice(-4) || undefined,
        last5: digits.slice(-5) || undefined,
        name:
          firstString(detail, [
            "productName",
            "depositName",
            "accountName",
            "displayProductType",
          ]) || "王道銀行定存",
        type: "time_deposit" as const,
        currency,
        balance,
      },
    ];
  });
}

function parseTransactionResponse(
  payload: unknown,
  accountSourceIds: Map<string, string>,
): ObankData["bankTransactions"] {
  const response = responseData(payload);
  const responseCurrency = normalizeCurrency(
    firstString(response, ["curry", "currency", "curr"]),
  );
  const responseExternalId = firstString(response, [
    "subAccountItemNo",
    "accountItemNo",
    "acctNo",
    "accountNo",
  ]);
  const responseLast4 = digitsOnly(
    firstString(response, ["acctNo", "accountNo", "displayAccountNo"]),
  ).slice(-4);
  const rows = firstArray(response, [
    "despositTxnDetails",
    "depositTxnDetails",
    "transactionDetails",
    "transactions",
    "details",
  ]);
  const occurrences = new Map<string, number>();

  return rows.flatMap((value) => {
    if (!isRecord(value)) return [];
    const currency =
      normalizeCurrency(firstString(value, ["acctCcy", "currency", "curr"])) ||
      responseCurrency;
    const externalId =
      firstString(value, ["subAccountItemNo", "accountItemNo"]) ||
      responseExternalId;
    const rowLast4 =
      digitsOnly(firstString(value, ["acctNo", "accountNo"])).slice(-4) ||
      responseLast4;
    const accountId =
      (externalId && accountSourceIds.get(externalId)) ||
      (rowLast4 && currency
        ? accountSourceIds.get(`${rowLast4}:${currency}`)
        : undefined);
    const postedDate = normalizeDate(
      firstString(value, ["txnDate", "postedDate", "transactionDate", "date"]),
    );
    const amount = firstNumber(value, [
      "txnAmount",
      "transactionAmount",
      "amount",
      "displayTxnAmount",
    ]);
    if (!accountId || !currency || !postedDate || amount == null) return [];
    const description =
      firstString(value, [
        "memo",
        "displayMemo",
        "description",
        "txnMemo",
        "transactionName",
      ]) || "王道銀行交易";
    const direction = firstString(value, [
      "debitCredit",
      "txnDirection",
      "sign",
    ]);
    const signedAmount = normalizeSignedAmount(amount, direction, value);
    const bankReference = firstString(value, [
      "txnSeqNo",
      "transactionId",
      "referenceNo",
      "traceNo",
    ]);
    const identity = [
      accountId,
      postedDate,
      signedAmount,
      description,
      bankReference,
    ].join(":");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return [
      {
        accountId,
        sourceId: `obank:deposit:tx:${stableHash(identity)}:${occurrence}`,
        postedDate,
        amount: signedAmount,
        currency,
        description,
        counterparty: firstString(value, [
          "counterparty",
          "counterpartyName",
          "payeeName",
        ]),
        status: "posted" as const,
        raw: sanitizeTransaction(value),
      },
    ];
  });
}

function responseData(payload: unknown): JsonRecord {
  if (!isRecord(payload)) return {};
  if (isRecord(payload.rsData)) return payload.rsData;
  if (isRecord(payload.responseJSON) && isRecord(payload.responseJSON.rsData))
    return payload.responseJSON.rsData;
  return payload;
}

function accountSourceId(
  type: string,
  externalId: string,
  last4: string,
  currency: string,
) {
  return `bank:obank:${type}:${last4 || "unknown"}:${stableHash(externalId)}:${currency}`;
}

function sanitizeAccount(account: ParsedAccount) {
  return {
    bankCode: "048",
    accountLast4: account.last4,
    accountType: account.type,
  };
}

function sanitizeTransaction(value: JsonRecord) {
  return Object.fromEntries(
    [
      "txnDate",
      "postedDate",
      "transactionDate",
      "txnAmount",
      "transactionAmount",
      "amount",
      "displayTxnAmount",
      "memo",
      "displayMemo",
      "description",
      "txnMemo",
      "debitCredit",
      "txnDirection",
    ].flatMap((key) => (value[key] == null ? [] : [[key, value[key]]])),
  );
}

function normalizeSignedAmount(
  amount: number,
  direction: string,
  value: JsonRecord,
) {
  const normalized = direction.trim().toUpperCase();
  if (/^(D|DR|DEBIT|OUT|-)$/i.test(normalized)) return -Math.abs(amount);
  if (/^(C|CR|CREDIT|IN|\+)$/i.test(normalized)) return Math.abs(amount);
  const debit = firstNumber(value, ["debitAmount", "withdrawalAmount"]);
  if (debit != null && debit !== 0) return -Math.abs(debit);
  const credit = firstNumber(value, ["creditAmount", "depositAmount"]);
  if (credit != null && credit !== 0) return Math.abs(credit);
  return amount;
}

function firstArray(record: JsonRecord, keys: string[]) {
  for (const key of keys) if (Array.isArray(record[key])) return record[key];
  return [];
}

function firstString(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return "";
}

function firstNumber(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = numberValue(record[key]);
    if (value != null) return value;
  }
  return undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[,\s$]/g, "").replace(/[()]/g, "");
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return undefined;
  return value.includes("(") ? -Math.abs(parsed) : parsed;
}

function normalizeCurrency(value: string) {
  const match = value.toUpperCase().match(/[A-Z]{3}/);
  return match?.[0] ?? "";
}

function normalizeDate(value: string) {
  const match = value.match(/(\d{2,4})[/.\-](\d{1,2})[/.\-](\d{1,2})/);
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  return `${year}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
}

function stripAccountNumber(value: string) {
  return value
    .replace(/\d{6,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function stableHash(value: string) {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
