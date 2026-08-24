import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { z } from "zod";

/** 新光銀行行動銀行 API 設定。所有欄位皆由 Worker 加密保存。 */
export const skbankConfigSchema = z.object({
  nationalId: z.string().min(1).max(32).optional(),
  alias: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
  deviceId: z.string().uuid().optional(),
});

export type SkbankConfig = z.infer<typeof skbankConfigSchema>;

export function parseSkbankConfig(config: unknown): SkbankConfig {
  return skbankConfigSchema.parse(config);
}

export type SkbankData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

/** A transaction response together with the account/currency used for its request. */
export type SkbankTransactionPayload = {
  accountNumber: string;
  currency: string;
  payload: unknown;
};

/** Internal account request identity used while querying transaction history. */
export type SkbankAccountQuery = {
  accountNumber: string;
  currency: string;
  sourceId: string;
};

export type SkbankParseOptions = {
  foreignCurrencyPayload?: unknown;
  transactionPayloads?: SkbankTransactionPayload[];
  now?: Date;
};

type JsonRecord = Record<string, unknown>;
type ParsedAccount = SkbankAccountQuery & {
  last4?: string;
  accountName: string;
  accountType: "checking" | "savings" | "time_deposit";
  balance: number;
  availableBalance?: number;
  displayGroups: string[];
  productCode?: string;
  productFullName?: string;
  accountProperty?: string;
};

export class SkbankProtocolError extends Error {
  constructor(message = "新光銀行回應格式已變更，暫時無法同步。") {
    super(message);
    this.name = "SkbankProtocolError";
  }
}

/**
 * Parse the account summary and, when supplied, the foreign-currency summary
 * and transaction pages. The two-argument `(payload, Date)` form remains
 * supported for callers that only need the original TWD account data.
 */
export function parseSkbankData(payload: unknown, now?: Date): SkbankData;
export function parseSkbankData(
  payload: unknown,
  options?: SkbankParseOptions,
): SkbankData;
export function parseSkbankData(
  payload: unknown,
  foreignCurrencyPayload: unknown,
  transactionPayloads: SkbankTransactionPayload[],
  now?: Date,
): SkbankData;
export function parseSkbankData(
  payload: unknown,
  second: Date | SkbankParseOptions | unknown = new Date(),
  third: SkbankTransactionPayload[] = [],
  fourth?: Date,
): SkbankData {
  let now = new Date();
  let foreignPayload: unknown;
  let transactionPayloads = third;

  if (second instanceof Date) {
    now = second;
  } else if (isParseOptions(second)) {
    now = second.now ?? now;
    foreignPayload = second.foreignCurrencyPayload;
    transactionPayloads = second.transactionPayloads ?? [];
  } else {
    foreignPayload = second;
    now = fourth ?? now;
  }

  const accounts = parseSkbankAccountRecords(payload, foreignPayload);
  const asOfAt = now.toISOString();
  const bankAccounts = accounts.map((account) => ({
    sourceId: account.sourceId,
    institutionName: "新光銀行",
    accountName: account.accountName,
    accountType: account.accountType,
    currency: account.currency,
    raw: sanitizeAccount(account),
  }));
  const bankBalanceSnapshots = accounts.map((account) => ({
    accountId: account.sourceId,
    sourceId: `${account.sourceId}:${asOfAt}`,
    balance: account.balance,
    availableBalance: account.availableBalance,
    currency: account.currency,
    asOfAt,
    raw: sanitizeAccount(account),
  }));

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions: parseSkbankTransactions(transactionPayloads, accounts),
  };
}

/** Return stable, private account identities for transaction requests. */
export function getSkbankAccountQueries(
  accountPayload: unknown,
  foreignCurrencyPayload?: unknown,
): SkbankAccountQuery[] {
  return parseSkbankAccountRecords(accountPayload, foreignCurrencyPayload)
    .filter(({ accountType }) => accountType !== "time_deposit")
    .map(({ accountNumber, currency, sourceId }) => ({
      accountNumber,
      currency,
      sourceId,
    }));
}

function parseSkbankAccountRecords(
  accountPayload: unknown,
  foreignCurrencyPayload?: unknown,
): ParsedAccount[] {
  const twdAccounts = parseAccountList(accountPayload, "TWD");
  const foreignAccounts = parseAccountList(foreignCurrencyPayload, "FX");
  return dedupeBySourceId([...twdAccounts, ...foreignAccounts]);
}

function parseAccountList(
  payload: unknown,
  currencyMode: "TWD" | "FX",
): ParsedAccount[] {
  const data = responseData(payload);
  if (!Array.isArray(data.AccountList)) {
    if (currencyMode === "TWD") throw new SkbankProtocolError();
    return [];
  }

  return data.AccountList.flatMap((value) => {
    if (!isRecord(value)) return [];
    const accountNumber = stringValue(value.AccountNumber).trim();
    if (!accountNumber) return [];
    const details = Array.isArray(value.Details) ? value.Details : [];
    return details.flatMap((detail) =>
      parseAccountDetail(value, accountNumber, detail, currencyMode),
    );
  });
}

function parseAccountDetail(
  account: JsonRecord,
  accountNumber: string,
  value: unknown,
  currencyMode: "TWD" | "FX",
): ParsedAccount[] {
  if (!isRecord(value)) return [];
  const currency = stringValue(value.CurrencyCode).trim().toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return [];
  if (currencyMode === "TWD" ? currency !== "TWD" : currency === "TWD") {
    return [];
  }

  const displayGroups = Array.isArray(value.DisplayGroup)
    ? value.DisplayGroup.filter(
        (group): group is string => typeof group === "string",
      )
    : [];
  const isTimeDeposit =
    displayGroups.includes("TimeDeposit") ||
    stringValue(account.ProductCode).trim() === "F500001";
  const balance = numberValue(
    isTimeDeposit ? value.TimeDepositBalance : value.AccountBalance,
  );
  if (balance == null) return [];

  const last4 = lastDigits(
    stringValue(value.AccountNumberDisplay) || accountNumber,
    4,
  );
  const productCode = optionalString(account.ProductCode);
  const productFullName = optionalString(account.ProductFullName);
  const accountProperty = optionalString(account.AccountProperty);
  const nickname = optionalString(account.Nickname);
  const accountType = isTimeDeposit
    ? "time_deposit"
    : productCode === "F500002"
      ? "savings"
      : /支票|checking/i.test(
            `${accountProperty ?? ""} ${productFullName ?? ""}`,
          )
        ? "checking"
        : "savings";
  const sourceId = `bank:skbank:${last4 || "unknown"}:${stableHash(accountNumber)}${currency === "TWD" ? "" : `:${currency}`}`;
  const baseName =
    nickname ||
    productFullName ||
    (last4 ? `新光銀行存款末四碼 ${last4}` : "新光銀行存款帳戶");
  const accountName =
    sanitizeText(baseName, accountNumber) +
    (currency === "TWD" ? "" : ` (${currency})`);

  return [
    {
      accountNumber,
      currency,
      sourceId,
      last4: last4 || undefined,
      accountName,
      accountType,
      balance,
      availableBalance: numberValue(value.AvailableBalance),
      displayGroups,
      productCode,
      productFullName,
      accountProperty,
    },
  ];
}

function parseSkbankTransactions(
  payloads: SkbankTransactionPayload[],
  accounts: ParsedAccount[],
): Array<Omit<BankTransaction, "id" | "connectorId">> {
  const accountIds = new Map(
    accounts.map((account) => [
      `${account.accountNumber}:${account.currency}`,
      account.sourceId,
    ]),
  );
  const transactions: Array<Omit<BankTransaction, "id" | "connectorId">> = [];
  const identityOccurrences = new Map<string, number>();

  for (const item of payloads) {
    const currency = item.currency.trim().toUpperCase();
    const accountId = accountIds.get(`${item.accountNumber}:${currency}`);
    if (!accountId) continue;
    const data = responseData(item.payload);
    if (!Array.isArray(data.Details)) continue;
    for (const detail of data.Details) {
      if (!isRecord(detail)) continue;
      const amount = numberValue(detail.Amount);
      const postedDate = normalizeTransactionDate(detail.TransactionDate);
      const transactionTimestamp = normalizeTransactionTimestamp(
        detail.TransactionDate,
      );
      if (amount == null || !postedDate) continue;
      const memo = sanitizeOptionalString(detail.Memo, item.accountNumber);
      const summary = sanitizeOptionalString(
        detail.Summary,
        item.accountNumber,
      );
      const remark =
        currency === "TWD"
          ? sanitizeOptionalString(detail.Remark, item.accountNumber)
          : undefined;
      const description = memo || remark || summary || "新光銀行交易";
      const balance = numberValue(detail.Balance);
      const identity = [
        accountId,
        transactionTimestamp ?? postedDate,
        amount,
        balance ?? "",
        memo ?? "",
        remark ?? "",
        summary ?? "",
      ].join("|");
      const occurrence = (identityOccurrences.get(identity) ?? 0) + 1;
      identityOccurrences.set(identity, occurrence);
      const sourceIdentity =
        occurrence === 1 ? identity : `${identity}|occurrence:${occurrence}`;
      transactions.push({
        accountId,
        sourceId: `skbank:${currency === "TWD" ? "deposit" : "foreign"}:tx:${stableHash(sourceIdentity)}`,
        postedDate,
        amount,
        currency,
        description,
        status: "posted",
        raw:
          currency === "TWD"
            ? sanitizeTwdTransaction(detail, accountId, item.accountNumber)
            : sanitizeForeignTransaction(detail, currency, item.accountNumber),
      });
    }
  }

  return dedupeBySourceId(transactions);
}

function sanitizeAccount(account: ParsedAccount) {
  return {
    accountLast4: account.last4,
    currency: account.currency,
    displayGroups: account.displayGroups,
    productCode: account.productCode,
    productFullName: account.productFullName
      ? sanitizeText(account.productFullName, account.accountNumber)
      : undefined,
    accountProperty: account.accountProperty
      ? sanitizeText(account.accountProperty, account.accountNumber)
      : undefined,
  };
}

function sanitizeTwdTransaction(
  detail: JsonRecord,
  accountId: string,
  accountNumber: string,
) {
  return {
    accountLast4: accountLast4FromSourceId(accountId),
    amount: numberValue(detail.Amount),
    balance: numberValue(detail.Balance),
    memo: sanitizeOptionalString(detail.Memo, accountNumber),
    remark: sanitizeOptionalString(detail.Remark, accountNumber),
    summary: sanitizeOptionalString(detail.Summary, accountNumber),
    transactionDate: normalizeTransactionDate(detail.TransactionDate),
  };
}

function sanitizeForeignTransaction(
  detail: JsonRecord,
  currency: string,
  accountNumber: string,
) {
  return {
    currency,
    amount: numberValue(detail.Amount),
    balance: numberValue(detail.Balance),
    exchangeRate: numberValue(detail.ExchangeRate),
    memo: sanitizeOptionalString(detail.Memo, accountNumber),
    summary: sanitizeOptionalString(detail.Summary, accountNumber),
    transactionDate: normalizeTransactionDate(detail.TransactionDate),
  };
}

function accountLast4FromSourceId(sourceId: string) {
  return sourceId.match(/^bank:skbank:([^:]+)/)?.[1];
}

function responseData(payload: unknown): JsonRecord {
  if (!isRecord(payload)) return {};
  return isRecord(payload.Data) ? payload.Data : payload;
}

function normalizeTransactionDate(value: unknown) {
  const text = stringValue(value).trim().replace(/\./g, "/");
  const match = /^(\d{3,4})\/(\d{1,2})\/(\d{1,2})/.exec(text);
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTransactionTimestamp(value: unknown) {
  const text = stringValue(value).trim().replace(/\./g, "/");
  const match =
    /^(\d{3,4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return [
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  ].join("T");
}

function sanitizeText(value: string, accountNumber: string) {
  return maskLongDigitSequences(value.replaceAll(accountNumber, "")).trim();
}

function stableHash(value: string) {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

function lastDigits(value: string, count: number) {
  return value.replace(/\D/g, "").slice(-count);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  const result = stringValue(value).trim();
  return result || undefined;
}

function sanitizeOptionalString(value: unknown, accountNumber: string) {
  const result = optionalString(value);
  return result
    ? sanitizeLongDigitRuns(sanitizeText(result, accountNumber)) || undefined
    : undefined;
}

function sanitizeLongDigitRuns(value: string) {
  return maskLongDigitSequences(value);
}

function maskLongDigitSequences(value: string) {
  return value.replace(/\d(?:[\s-]*\d){4,}/g, (matched) => {
    const digits = matched.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  });
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[,$\s]/g, "").trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

function isParseOptions(value: unknown): value is SkbankParseOptions {
  return (
    isRecord(value) &&
    ("foreignCurrencyPayload" in value ||
      "transactionPayloads" in value ||
      "now" in value)
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
