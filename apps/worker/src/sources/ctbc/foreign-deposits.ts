import { CtbcVerificationRequiredError } from "./errors";
import forge from "node-forge";
import { normalizeCtbcDate, parseCtbcAmount, type CtbcData } from "./protocol";
import { BANK_SYNC_MONTHS } from "../sync-window";
type Json = Record<string, unknown>;
type Request = (resource: string, data: Json) => Promise<Json>;
type Deposits = Pick<
  CtbcData,
  "bankAccounts" | "bankBalanceSnapshots" | "bankTransactions"
>;
type Account = {
  accountId: string;
  currency: string;
  balance: number;
  name?: string;
};
const OVERVIEW = "/twrbm-fx/qu001/010";
const INIT = "/twrbm-fx/qu002/010";
const TRANSACTIONS = "/twrbm-fx/qu002/011";
type FailureReason =
  | "format_unconfirmed"
  | "response_status_unconfirmed"
  | "overview_status_unconfirmed"
  | "overview_list_invalid"
  | "account_identifier_invalid"
  | "currency_invalid"
  | "overview_balance_invalid"
  | "overview_balance_missing"
  | "duplicate_account_balance_conflict"
  | "overview_query_failed"
  | "initialization_query_failed"
  | "transactions_query_failed";

/** Fixed failures never contain provider error text or account values. */
export class CtbcForeignDepositError extends Error {
  constructor(
    readonly reason: FailureReason,
    message = "中國信託外幣存款資料格式或完整性無法確認。",
  ) {
    super(message);
    this.name = "CtbcForeignDepositError";
  }
}
const invalid = (reason: FailureReason = "format_unconfirmed") =>
  new CtbcForeignDepositError(reason);

/** Verified against public Android 5.2.26 fx-qu001/qu002 assets. No wire payload is persisted. */
export async function fetchCtbcForeignDeposits(
  request: Request,
  existingOverview: unknown,
  now = new Date(),
): Promise<Deposits> {
  const ranges = monthRanges(BANK_SYNC_MONTHS, now);
  const query = async (resource: string, data: Json) => {
    let response: Json;
    try {
      response = await request(resource, data);
    } catch (error) {
      if (error instanceof CtbcVerificationRequiredError) throw error;
      throw new CtbcForeignDepositError(
        resource === OVERVIEW
          ? "overview_query_failed"
          : resource === INIT
            ? "initialization_query_failed"
            : "transactions_query_failed",
        "中國信託外幣存款查詢未完成。",
      );
    }
    // fx-qu002's EMPTY_RESULT_ERROR_CODE is exactly ESB9201. Generic 8888
    // or the same numeric code from another subsystem is not an empty result.
    if (
      resource === TRANSACTIONS &&
      text(response.sys || response.systemId) === "ESB" &&
      text(response.code) === "9201"
    ) {
      const list = record(response.rsData).detailList;
      if (list != null && (!Array.isArray(list) || list.length !== 0))
        throw invalid();
      return { ...response, rsData: { detailList: [] } };
    }
    assertEnvelope(response);
    return response;
  };
  const existing = record(existingOverview).rsData;
  const overview = Object.hasOwn(record(existing), "fxAcctSummaryResponse")
    ? existingOverview
    : await query(OVERVIEW, {});
  const accounts = parseAccounts(overview);
  const result: Deposits = {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    bankTransactions: [],
  };
  for (const account of accounts) {
    const initial = await query(INIT, {
      accountId: account.accountId,
      curCode: account.currency,
    });
    const selections = record(initial.rsData).infoList;
    if (!Array.isArray(selections)) throw invalid();
    const matches = selections.filter((value) => {
      const row = record(value);
      return (
        text(row.accountId) === account.accountId &&
        text(row.curCode).toUpperCase() === account.currency
      );
    });
    if (matches.length !== 1) throw invalid();
    const selectedAccount = record(matches[0]);
    const availableBalance = optionalAmount(selectedAccount.avialBal);
    const balance = optionalAmount(selectedAccount.currentBal);
    if (balance == null) throw invalid();
    const last4 = account.accountId.match(/(\d{4})\D*$/)?.[1];
    const sourceId = `bank:ctbc:${last4 ?? "unknown"}:${hash(account.accountId)}:${account.currency}`;
    const safeRaw = {
      accountLast4: last4,
      currency: account.currency,
    };
    result.bankAccounts.push({
      sourceId,
      institutionName: "中國信託商業銀行",
      accountName: account.name || "中國信託外幣活存帳戶",
      accountType: "savings",
      currency: account.currency,
      raw: safeRaw,
    });
    result.bankBalanceSnapshots.push({
      accountId: sourceId,
      sourceId: `${sourceId}:${now.toISOString()}`,
      balance,
      availableBalance,
      currency: account.currency,
      asOfAt: now.toISOString(),
      raw: safeRaw,
    });
    for (const range of ranges) {
      const response = await query(TRANSACTIONS, {
        accountId: account.accountId,
        curCode: account.currency,
        ...range,
        keyWord: "",
        type: "custom",
        isFromEnterPrise: false,
      });
      const data = record(response.rsData);
      if (!Array.isArray(data.detailList)) throw invalid();
      // The official custom-date flow consumes the complete detailList, with
      // month/date navigation rather than a pageNum endpoint. Never slice it.
      const occurrences = new Map<string, number>();
      for (const value of data.detailList) {
        const row = record(value);
        const debit = optionalAmount(row.debitAmt) ?? 0;
        const credit = optionalAmount(row.creditAmt) ?? 0;
        if (
          (!Object.hasOwn(row, "debitAmt") &&
            !Object.hasOwn(row, "creditAmt")) ||
          (debit !== 0 && credit !== 0)
        )
          throw invalid();
        const transactionDate = normalizeCtbcDate(row.trnDtRaw);
        const postingDate = normalizeCtbcDate(row.actDtFull);
        if (text(row.actDtFull) && !postingDate) throw invalid();
        const postedDate = postingDate ?? transactionDate;
        if (!transactionDate || !postedDate) throw invalid();
        const amount = credit !== 0 ? Math.abs(credit) : -Math.abs(debit);
        if (amount === 0) continue;
        const balance = optionalAmount(row.balAmt);
        const description =
          text(row.userMemo) || text(row.memo1) || "中國信託外幣帳戶交易";
        const identity = JSON.stringify([
          sourceId,
          transactionDate,
          postedDate,
          amount,
          balance ?? null,
        ]);
        const occurrence = (occurrences.get(identity) ?? 0) + 1;
        occurrences.set(identity, occurrence);
        result.bankTransactions.push({
          accountId: sourceId,
          sourceId: `ctbc:fx:tx:${hash(identity)}:${occurrence}`,
          postedDate,
          authorizedAt: transactionDate,
          amount,
          currency: account.currency,
          description,
          status: "posted",
          raw: safeRaw,
        });
      }
    }
  }
  result.bankTransactions = [
    ...new Map(
      result.bankTransactions.map((row) => [row.sourceId, row]),
    ).values(),
  ];
  return result;
}

function parseAccounts(payload: unknown): Account[] {
  assertEnvelope(record(payload));
  const data = record(
    record(record(payload).rsData).fxAcctSummaryResponse,
  ).demDepBalSummaryResponse;
  const summary = record(data);
  const code = text(summary.rspCode);
  const list = summary.infoList;
  // The official UI classifies 9002/9004 as no demand-deposit account. Do not
  // accept contradictory rows, unknown errors, or a missing success list.
  if (["9002", "9004"].includes(code)) {
    if (list != null && (!Array.isArray(list) || list.length > 0))
      throw invalid("overview_list_invalid");
    return [];
  }
  if (code !== "0000") throw invalid("overview_status_unconfirmed");
  if (!Array.isArray(list)) throw invalid("overview_list_invalid");
  const accounts = new Map<string, Account>();
  for (const value of list) {
    const row = record(value);
    const accountId = text(row.accountId);
    const currency = text(row.curCode).toUpperCase();
    if (!accountId || /[*Ｘx#•]/.test(accountId))
      throw invalid("account_identifier_invalid");
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      ["TWD", "NTD", "NAN"].includes(currency)
    )
      throw invalid("currency_invalid");
    let balance: number | undefined;
    try {
      balance = optionalAmount(row.currentBal);
    } catch {
      throw invalid("overview_balance_invalid");
    }
    if (balance == null) throw invalid("overview_balance_missing");
    const key = `${accountId}:${currency}`;
    const previous = accounts.get(key);
    if (previous && previous.balance !== balance)
      throw invalid("duplicate_account_balance_conflict");
    accounts.set(key, {
      accountId,
      currency,
      balance,
      name: text(row.accountNickName) || undefined,
    });
  }
  return [...accounts.values()];
}

function assertEnvelope(response: Json) {
  if (
    (text(response.code) && text(response.code) !== "0000") ||
    (text(response.statusCode) && text(response.statusCode) !== "0000") ||
    response.success === false
  )
    throw invalid("response_status_unconfirmed");
}

function optionalAmount(value: unknown) {
  if (value == null || (typeof value === "string" && value.trim() === ""))
    return undefined;
  const amount = parseCtbcAmount(value);
  if (amount == null || Math.abs(amount) > Number.MAX_SAFE_INTEGER)
    throw invalid();
  return amount;
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function hash(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}
function monthRanges(count: number, now: Date) {
  if (!Number.isInteger(count) || count < 1 || count > 6) throw invalid();
  const taipei = new Date(now.getTime() + 8 * 3600_000);
  const compact = (date: Date) =>
    date.toISOString().slice(0, 10).replaceAll("-", "");
  return Array.from({ length: count }, (_, offset) => ({
    startDate: compact(
      new Date(
        Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth() - offset, 1),
      ),
    ),
    endDate: compact(
      offset === 0
        ? taipei
        : new Date(
            Date.UTC(
              taipei.getUTCFullYear(),
              taipei.getUTCMonth() - offset + 1,
              0,
            ),
          ),
    ),
  }));
}
