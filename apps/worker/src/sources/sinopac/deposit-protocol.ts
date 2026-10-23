import { depositAccountName } from "../deposit-account-name";
import forge from "node-forge";
import { z } from "zod";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "../financial-types";
import { BANK_SYNC_MONTHS } from "../sync-window";

const envelopeSchema = z
  .array(
    z.object({
      Header: z.string(),
      Message: z.string().optional(),
      SubInfo: z.array(z.unknown()),
      RecordCount: z.union([z.string(), z.number()]).nullish(),
    }),
  )
  .length(1);
const moneySchema = z.union([z.string(), z.number()]);
const accountSchema = z.object({
  AcctValue: z.string().min(1),
  AcctText: z.string(),
  Curr: z.string().regex(/^[A-Z]{3}$/),
  AvailBalInt: moneySchema,
  MaxAvail: moneySchema.optional(),
});
const transactionSchema = z.object({
  DataText1: z.string(),
  DataText2: z.string(),
  DataText3: z.string(),
  DataText4: moneySchema,
  DataText5: moneySchema,
  DataText6: z.string().optional(),
  DataText8: z.string().optional(),
});
type DepositAccount = z.infer<typeof accountSchema>;
type DepositRequest = (
  path: string,
  label: string,
  body: URLSearchParams,
) => Promise<unknown>;
export type SinopacDepositData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
};

export class SinopacDepositProtocolError extends Error {
  constructor(
    message: string,
    readonly incomplete = false,
  ) {
    super(message);
    this.name = "SinopacDepositProtocolError";
  }
}

function hash(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function text(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim();
}

function redact(value: string) {
  return text(value)
    .replace(/[A-Z][12]\d{8}/gi, "[身分證已遮罩]")
    .replace(
      /\d(?:[ -]?\d){7,}/g,
      (match) => `****${match.replace(/\D/g, "").slice(-4)}`,
    );
}

function amount(value: string | number) {
  const normalized =
    typeof value === "number" ? String(value) : text(value).replace(/,/g, "");
  if (
    !/^[+-]?\d+(?:\.\d+)?$/.test(normalized) ||
    !Number.isFinite(Number(normalized))
  ) {
    throw new SinopacDepositProtocolError("永豐存款金額格式已改變。");
  }
  return Number(normalized);
}

function envelope(payload: unknown) {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data[0].Header !== "SUCCESS") {
    throw new SinopacDepositProtocolError("永豐存款回應缺少完整清單。");
  }
  return parsed.data[0];
}

function accounts(payload: unknown) {
  const parsed = z.array(accountSchema).safeParse(envelope(payload).SubInfo);
  if (!parsed.success)
    throw new SinopacDepositProtocolError("永豐存款帳戶格式已改變。");
  return parsed.data;
}

export function isSinopacDepositEmptyTransactions(payload: unknown) {
  const parsed = envelopeSchema.safeParse(payload);
  return (
    parsed.success &&
    parsed.data[0].Header === "FAIL" &&
    parsed.data[0].Message === "查無資料" &&
    parsed.data[0].SubInfo.length === 0
  );
}

function accountId(accountNumber: string, currency: string) {
  const digits = accountNumber.replace(/[ -]/g, "");
  if (!/^\d{8,}$/.test(digits))
    throw new SinopacDepositProtocolError("永豐存款帳戶識別格式已改變。");
  return `bank:sinopac:${digits.slice(-4)}:${hash(digits)}:${currency}`;
}

function dateTime(value: string) {
  const match = text(value).match(
    /^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match)
    throw new SinopacDepositProtocolError("永豐存款交易日期格式已改變。");
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  if (
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  ) {
    throw new SinopacDepositProtocolError("永豐存款交易日期無效。");
  }
  if (!match[4]) return day;
  if (
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6] ?? 0) > 59
  ) {
    throw new SinopacDepositProtocolError("永豐存款交易時間無效。");
  }
  return `${day}T${match[4]}:${match[5]}:${match[6] ?? "00"}+08:00`;
}

export function parseSinopacDepositAccounts(
  payload: unknown,
  now = new Date(),
): SinopacDepositData {
  const bankAccounts: SinopacDepositData["bankAccounts"] = [];
  const bankBalanceSnapshots: SinopacDepositData["bankBalanceSnapshots"] = [];
  const day = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  for (const account of accounts(payload)) {
    const id = accountId(account.AcctValue, account.Curr);
    const last4 = account.AcctValue.replace(/\D/g, "").slice(-4);
    bankAccounts.push({
      sourceId: id,
      institutionName: "永豐銀行",
      // 銀行提供的帳戶種類（例如「活期儲蓄存款」）作為顯示名稱前綴。
      accountName: depositAccountName(
        account.AcctText,
        last4,
        `末四碼 ${last4}`,
      ),
      accountType: /支票|支存/.test(account.AcctText) ? "checking" : "savings",
      currency: account.Curr,
    });
    bankBalanceSnapshots.push({
      accountId: id,
      sourceId: `${id}:balance:${day}`,
      balance: amount(account.AvailBalInt),
      availableBalance:
        account.MaxAvail == null ? undefined : amount(account.MaxAvail),
      currency: account.Curr,
      asOfAt: now.toISOString(),
    });
  }
  return { bankAccounts, bankBalanceSnapshots, bankTransactions: [] };
}

export function parseSinopacDepositTransactions(
  payload: unknown,
  accountNumber: string,
  currency: string,
): SinopacDepositData["bankTransactions"] {
  if (isSinopacDepositEmptyTransactions(payload)) return [];
  const response = envelope(payload);
  const parsed = z.array(transactionSchema).safeParse(response.SubInfo);
  if (!parsed.success)
    throw new SinopacDepositProtocolError("永豐存款交易格式已改變。");
  // The bank's RecordCount is the last row index, also used by its detail-page navigation.
  const lastIndex = Number(response.RecordCount);
  if (
    response.RecordCount == null ||
    String(response.RecordCount).trim() === "" ||
    !Number.isInteger(lastIndex) ||
    lastIndex < -1
  ) {
    throw new SinopacDepositProtocolError("永豐存款交易缺少有效筆數。");
  }
  if (
    parsed.data.length > 0
      ? lastIndex !== parsed.data.length - 1
      : lastIndex > 0
  ) {
    throw new SinopacDepositProtocolError(
      "永豐存款交易清單不完整，請縮小查詢區間。",
      true,
    );
  }
  const id = accountId(accountNumber, currency);
  const occurrences = new Map<string, number>();
  return parsed.data.map((record) => {
    const authorizedAt = dateTime(record.DataText1);
    const signedAmount = amount(record.DataText4);
    const balance = amount(record.DataText5);
    // Keep identity independent of memo changes and later improvements to time precision.
    const identity = hash(
      JSON.stringify([
        id,
        authorizedAt.slice(0, 10),
        signedAmount,
        balance,
        text(record.DataText6 ?? ""),
      ]),
    );
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const description = redact(record.DataText3);
    const memo = redact(record.DataText8 ?? "");
    return {
      accountId: id,
      sourceId: `sinopac:deposit:tx:${identity}:${occurrence}`,
      postedDate: authorizedAt.slice(0, 10),
      authorizedAt,
      amount: signedAmount,
      currency,
      description:
        memo && memo.length <= 100 ? `${description} · ${memo}` : description,
      status: "posted" as const,
      // DataText2 is the interest value date, not the transaction's posting date.
      raw: {
        balance,
        valueDate: record.DataText2 ? dateTime(record.DataText2) : undefined,
      },
    };
  });
}

export async function fetchSinopacDeposits(
  request: DepositRequest,
  now = new Date(),
): Promise<SinopacDepositData> {
  const payload = await request(
    "/ws/bank/bankbal/ws_bankbal.ashx",
    "存款總覽",
    new URLSearchParams(),
  );
  const result = parseSinopacDepositAccounts(payload, now);
  const end = new Date(now.getTime() + 8 * 3600_000);
  const endDay = end.toISOString().slice(0, 10);
  // Clamp the day before subtracting months, so May 31 does not overflow into March.
  const start = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - BANK_SYNC_MONTHS, 1),
  );
  const lastDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), lastDay));
  const startDay = start.toISOString().slice(0, 10);

  async function transactions(
    account: DepositAccount,
    from: string,
    to: string,
  ): Promise<SinopacDepositData["bankTransactions"]> {
    const body = new URLSearchParams({
      AcctValue: account.AcctValue,
      Curr: account.Curr,
      QueryType: "3",
      StartDate: from.replaceAll("-", ""),
      EndDate: to.replaceAll("-", ""),
    });
    const response = await request(
      "/ws/bank/transdetail/ws_transdetailMerge.ashx",
      "存款交易",
      body,
    );
    try {
      return parseSinopacDepositTransactions(
        response,
        account.AcctValue,
        account.Curr,
      );
    } catch (error) {
      if (
        !(error instanceof SinopacDepositProtocolError) ||
        !error.incomplete ||
        from === to
      )
        throw error;
      const middle = new Date(
        Math.floor((Date.parse(from) + Date.parse(to)) / 2 / 86400_000) *
          86400_000,
      );
      const next = new Date(middle.getTime() + 86400_000);
      return [
        ...(await transactions(
          account,
          from,
          middle.toISOString().slice(0, 10),
        )),
        ...(await transactions(account, next.toISOString().slice(0, 10), to)),
      ];
    }
  }
  for (const account of accounts(payload)) {
    result.bankTransactions.push(
      ...(await transactions(account, startDay, endDay)),
    );
  }
  return result;
}
