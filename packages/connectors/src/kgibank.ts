import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { z } from "zod";

export const KGIBANK_CAPTCHA_DIGIT_COUNT = 6;

export const kgibankConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().optional(),
  captchaDigitCount: z.number().int().min(4).max(8).optional(),
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

export type KgibankConfig = z.infer<typeof kgibankConfigSchema>;

export function parseKgibankConfig(config: unknown): KgibankConfig {
  return kgibankConfigSchema.parse(config);
}

/** 凱基網銀 `Deposit/TwdDemandDepositDetail/AcctQuery` 與 `TxnQuery` 的原始 JSON。 */
export type KgibankPayloads = {
  accountsResponse: unknown;
  transactionResponses: Array<{ accountNo: string; response: unknown }>;
};

export type KgibankData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;

type ParsedAccount = {
  accountNo: string;
  sourceId: string;
  typeName: string;
  nickName: string;
  balance: number;
  availableBalance?: number;
};

export class KgibankProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KgibankProtocolError";
  }
}

export function kgibankAccountSourceId(accountNo: string) {
  return `bank:kgibank:${accountNo}:TWD`;
}

export function parseKgibankAccounts(payload: unknown): ParsedAccount[] {
  const items = responseItems(payload, "AcctQuery");
  return items.flatMap((item) => {
    const accountNo = digitsOnly(stringValue(item.acctNo));
    const balance = numberValue(item.acctBal);
    if (!accountNo || balance === undefined) return [];
    return [
      {
        accountNo,
        sourceId: kgibankAccountSourceId(accountNo),
        typeName: stringValue(item.acctTypeName),
        nickName: stringValue(item.acctNickName),
        balance,
        availableBalance: numberValue(item.availBal),
      },
    ];
  });
}

export function parseKgibankData(
  payloads: KgibankPayloads,
  now = new Date(),
): KgibankData {
  const asOfAt = now.toISOString();
  const accounts = parseKgibankAccounts(payloads.accountsResponse);
  const accountsByNo = new Map(
    accounts.map((account) => [account.accountNo, account]),
  );

  const bankAccounts: KgibankData["bankAccounts"] = accounts.map((account) => ({
    sourceId: account.sourceId,
    institutionName: "凱基銀行",
    accountName:
      account.nickName ||
      `${account.typeName || "臺幣活存"} 末四碼 ${account.accountNo.slice(-4)}`,
    accountType: "savings",
    currency: "TWD",
    raw: sanitizeAccount(account),
  }));

  const bankBalanceSnapshots: KgibankData["bankBalanceSnapshots"] =
    accounts.map((account) => ({
      accountId: account.sourceId,
      sourceId: `snapshot:kgibank:${account.accountNo}:TWD`,
      balance: account.balance,
      availableBalance: account.availableBalance,
      currency: "TWD",
      asOfAt,
      raw: sanitizeAccount(account),
    }));

  const bankTransactions = dedupeBySourceId(
    payloads.transactionResponses.flatMap(({ accountNo, response }) => {
      const account = accountsByNo.get(digitsOnly(accountNo));
      if (!account) return [];
      return parseTransactions(account, response);
    }),
  );

  return { bankAccounts, bankBalanceSnapshots, bankTransactions };
}

function parseTransactions(
  account: ParsedAccount,
  payload: unknown,
): KgibankData["bankTransactions"] {
  const occurrences = new Map<string, number>();
  return responseItems(payload, "TxnQuery").flatMap((item) => {
    const authorizedAt = normalizeTimestamp(stringValue(item.txnDateTime));
    const amount = numberValue(item.txnAmt);
    if (!authorizedAt || amount === undefined) {
      throw new KgibankProtocolError("凱基交易明細缺少交易時間或金額。");
    }
    const postedDate =
      dateOnly(stringValue(item.effectDateTime)) ?? dateOnly(authorizedAt);
    const balanceAfter = numberValue(item.acctBal);
    const description =
      stringValue(item.desc).trim() ||
      stringValue(item.txnTypeName).trim() ||
      "凱基銀行交易";
    // 交易時間精確到秒且含時區；加上金額與交易後餘額即可在重複同步間穩定識別同一筆交易。
    const identity = [
      account.accountNo,
      authorizedAt,
      amount,
      balanceAfter ?? "",
    ].join(":");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return [
      {
        accountId: account.sourceId,
        sourceId: `kgibank:deposit:tx:${stableHash(identity)}:${occurrence}`,
        postedDate,
        authorizedAt,
        amount,
        currency: "TWD",
        description,
        status: "posted" as const,
        raw: {
          txnTypeName: stringValue(item.txnTypeName) || undefined,
          desc: stringValue(item.desc) || undefined,
          balanceAfter,
        },
      },
    ];
  });
}

function responseItems(payload: unknown, label: string): JsonRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new KgibankProtocolError(`凱基 ${label} 回應格式無法辨識。`);
  }
  return payload.items.filter(isRecord);
}

/** 將 `2026-08-13T16:06:50.43+08:00` 正規化為秒精度，避免小數位差異造成重複交易。 */
function normalizeTimestamp(value: string): string | undefined {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return undefined;
  return `${match[1]}${match[2] === "Z" ? "+00:00" : match[2]}`;
}

function dateOnly(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1];
}

function sanitizeAccount(account: ParsedAccount) {
  return {
    bankCode: "809",
    accountLast4: account.accountNo.slice(-4),
    accountTypeName: account.typeName || undefined,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
