import forge from "node-forge";
import { z } from "zod";
import type { BankAccount, BankBalanceSnapshot } from "../financial-types";
import { SinopacVerificationRequiredError } from "./verification-error";

type SinopacLoanAccount = Omit<BankAccount, "id" | "connectorId">;
type SinopacLoanSnapshot = Omit<BankBalanceSnapshot, "id" | "connectorId">;

type Request = (
  path: string,
  label: string,
  body: URLSearchParams,
) => Promise<unknown>;

type LoanAccountReference = {
  acctValue: string;
  acctValueFormat: string;
  sourceId: string;
  accountSuffix: string;
};

type LoanInfoFields = {
  BeginLoanDate?: unknown;
  Currency?: unknown;
  LoanAcctCName?: unknown;
  LoanAmt?: unknown;
  LoanBalance?: unknown;
  LoanDate?: unknown;
  LoanKind?: unknown;
  LoanRate?: unknown;
  MatureDate?: unknown;
  PayName?: unknown;
  Sub1_Sub2?: unknown;
};

type PayDetail = {
  paymentDueDate?: string;
  loanPaymentAmount?: number;
  raw: Record<string, unknown>;
  recognizedFieldCount: number;
};

export type SinopacLoanSyncResult = {
  bankAccounts: SinopacLoanAccount[];
  bankBalanceSnapshots: SinopacLoanSnapshot[];
  loanOverviewComplete: boolean;
  accountListFailures: number;
  accountDetailFailures: number;
  paymentDetailFailures: number;
  skippedAccounts: number;
};

const LOAN_ACCOUNT_PATH = "/ws/bank/loan/ws_loanaccount.ashx";
const LOAN_INFO_PATH = "/ws/bank/loan/ws_loaninfo.ashx";
const PAY_DETAIL_PATH = "/ws/bank/loan/ws_paydetail.ashx";

const envelopeSchema = z.array(
  z.object({
    Header: z.string(),
    Message: z.unknown().optional(),
    SubInfo: z.unknown(),
    RecordCount: z.union([z.string(), z.number()]).nullish(),
    TopInfo: z.unknown().optional(),
    HeadInfo: z.unknown().optional(),
    HeadInfo_2: z.unknown().optional(),
    SubInfo_2: z.unknown().optional(),
  }),
);
const accountReferenceSchema = z.object({
  AcctValue: z.string().min(1),
  AcctValueFormat: z.string().optional().default(""),
  AcctText: z.string().optional(),
});
const headerFieldSchema = z.object({
  FieldKey: z.string(),
  HeadText: z.string(),
});
const recordSchema = z.record(z.string(), z.unknown());

function sha256(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}

function plainText(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .trim();
  return normalized || undefined;
}

function parseNumber(value: unknown): number | undefined {
  const normalized = plainText(value)?.replace(/[\s,]/g, "").replace(/%$/, "");
  if (!normalized || !/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCurrency(value: unknown): string | undefined {
  const currency = plainText(value)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function parseDate(value: unknown): string | undefined {
  const normalized = plainText(value);
  const match = normalized?.match(/^(\d{2,4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return undefined;
  let year = Number(match[1]);
  if (match[1]!.length <= 3) year += 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateParts(value: unknown): string[] {
  const normalized = plainText(value)?.replace(/\s+/g, " ");
  if (!normalized) return [];
  const matches = normalized.match(/\d{2,4}[/-]\d{1,2}[/-]\d{1,2}/g) ?? [];
  return matches.flatMap((match) => {
    const parsed = parseDate(match);
    return parsed ? [parsed] : [];
  });
}

function parseTopInfoTotalAmount(value: unknown): number | undefined {
  const text = plainText(value);
  const label = "應繳金額";
  if (!text) return undefined;
  const labelIndex = text.indexOf(label);
  if (labelIndex < 0 || text.indexOf(label, labelIndex + label.length) >= 0)
    return undefined;

  const remainder = text.slice(labelIndex + label.length);
  const match = remainder.match(
    /^\s*[:：=＝\-+﹕]*(?:(?:總計|合計)\s*)?(?:(?:NTD|TWD|NT\$|新臺幣|新台幣|臺幣|台幣)\s*)?[:：=＝\-+﹕]*\s*([+-]?\d[\d,]*(?:\.\d+)?)/i,
  );
  return match ? parseNumber(match[1]) : undefined;
}

function normalizedHeader(value: string) {
  return plainText(value)?.replace(/\s+/g, "") ?? "";
}

function headerFields(value: unknown) {
  const parsed = z.array(headerFieldSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

function envelope(payload: unknown) {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success || parsed.data.length !== 1) return undefined;
  const response = parsed.data[0];
  if (!response || response.Header !== "SUCCESS") return undefined;
  return response;
}

function accountReference(value: unknown): LoanAccountReference | undefined {
  const parsed = accountReferenceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const digits = parsed.data.AcctValue.replace(/\D/g, "");
  if (digits.length < 8) return undefined;
  return {
    acctValue: parsed.data.AcctValue,
    acctValueFormat: parsed.data.AcctValueFormat,
    sourceId: `loan:sinopac:${sha256(digits)}`,
    accountSuffix: digits.slice(-4),
  };
}

function recordCountMatches(
  response: { RecordCount?: unknown },
  rowCount: number,
) {
  // The related deposit endpoint uses RecordCount as a zero-based last-row
  // index, but the observed ws_loanaccount response omits it. Missing metadata
  // cannot prove that this loan overview is complete.
  if (response.RecordCount == null) return false;
  const raw = response.RecordCount;
  const lastIndex =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(lastIndex) || lastIndex < 0) return false;
  return lastIndex === Math.max(0, rowCount - 1);
}

export function parseSinopacLoanAccountList(payload: unknown): {
  accounts: LoanAccountReference[];
  complete: boolean;
  failureCount: number;
} {
  const response = envelope(payload);
  if (!response || !Array.isArray(response.SubInfo))
    return { accounts: [], complete: false, failureCount: 1 };

  const accounts: LoanAccountReference[] = [];
  let invalidRows = 0;
  for (const row of response.SubInfo) {
    const account = accountReference(row);
    if (account) accounts.push(account);
    else invalidRows += 1;
  }
  const recordCountValid = recordCountMatches(
    response,
    response.SubInfo.length,
  );
  return {
    accounts,
    complete: invalidRows === 0 && recordCountValid,
    // Missing count metadata leaves completeness unproven, but is normal for
    // this endpoint and must not be reported as a list/API parsing failure.
    failureCount:
      invalidRows + Number(response.RecordCount != null && !recordCountValid),
  };
}

function loanCategory(
  value: unknown,
): "housing" | "personal" | "other" | undefined {
  const kind = plainText(value);
  if (!kind) return undefined;
  if (kind.includes("房屋")) return "housing";
  if (kind.includes("信用")) return "personal";
  if (kind.includes("其他")) return "other";
  return undefined;
}

function rawSourceFields(info: LoanInfoFields) {
  const fields = {
    LoanAcctCName: plainText(info.LoanAcctCName),
    LoanAmt: plainText(info.LoanAmt),
    LoanDate: plainText(info.LoanDate),
    MatureDate: plainText(info.MatureDate),
    Sub1_Sub2: plainText(info.Sub1_Sub2),
    ...(loanCategory(info.LoanKind)
      ? {}
      : { LoanKind: plainText(info.LoanKind) }),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

function parseLoanInfoRow(payload: unknown): LoanInfoFields | undefined {
  const response = envelope(payload);
  if (
    !response ||
    !Array.isArray(response.SubInfo) ||
    response.SubInfo.length !== 1
  )
    return undefined;
  const parsed = recordSchema.safeParse(response.SubInfo[0]);
  return parsed.success ? (parsed.data as LoanInfoFields) : undefined;
}

export function parseSinopacLoanInfo(
  account: LoanAccountReference,
  payload: unknown,
  now = new Date(),
):
  | {
      account: SinopacLoanAccount;
      snapshot?: SinopacLoanSnapshot;
      requestFields: LoanInfoFields;
      currencyValid: boolean;
    }
  | undefined {
  const info = parseLoanInfoRow(payload);
  if (!info) {
    return undefined;
  }
  const currency = parseCurrency(info.Currency);
  const loanRate = parseNumber(info.LoanRate);

  const category = loanCategory(info.LoanKind);
  const categoryLabel =
    category === "housing"
      ? "房屋貸款"
      : category === "personal"
        ? "信用貸款"
        : category === "other"
          ? "其他貸款"
          : "貸款帳戶";
  const accountRecord: SinopacLoanAccount = {
    sourceId: account.sourceId,
    institutionName: "永豐銀行",
    accountName: `${categoryLabel} · 末四碼 ${account.accountSuffix}`,
    accountType: "loan",
    ...(category ? { loanCategory: category } : {}),
    ...(loanRate != null ? { loanInterestRate: loanRate } : {}),
    ...(parseDate(info.BeginLoanDate)
      ? { openedDate: parseDate(info.BeginLoanDate) }
      : {}),
    currency: currency ?? "",
    raw: {
      sinopacLoan: {
        accountSuffix: account.accountSuffix,
        ...(currency ? {} : { currencyParseFailed: true }),
        sourceFields: rawSourceFields(info),
      },
    },
  };

  const balance = parseNumber(info.LoanBalance);

  const snapshot: SinopacLoanSnapshot | undefined =
    balance == null || !currency
      ? undefined
      : {
          accountId: account.sourceId,
          sourceId: `${account.sourceId}:current`,
          balance: -Math.abs(balance),
          currency,
          asOfAt: now.toISOString(),
          raw: {
            sinopacLoan: {
              accountSuffix: account.accountSuffix,
              sourceFields: rawSourceFields(info),
            },
          },
        };

  return {
    account: accountRecord,
    snapshot,
    requestFields: info,
    currencyValid: currency != null,
  };
}

function parsePayDetail(payload: unknown): PayDetail | undefined {
  const response = envelope(payload);
  if (!response || !Array.isArray(response.SubInfo)) return undefined;

  const mainHeaders = headerFields(response.HeadInfo);
  const secondaryHeaders = headerFields(response.HeadInfo_2);
  const loanPaymentAmount = parseTopInfoTotalAmount(response.TopInfo);

  const dueHeader = mainHeaders.find(
    (field) =>
      field.FieldKey === "DataValue3" &&
      normalizedHeader(field.HeadText) === "計息起日計息止日",
  );
  const interestHeader = mainHeaders.find(
    (field) =>
      field.FieldKey === "DataValue5" &&
      normalizedHeader(field.HeadText) === "繳息金額",
  );
  const principalHeader = secondaryHeaders.find(
    (field) =>
      field.FieldKey === "DataValue6" &&
      normalizedHeader(field.HeadText) === "現有本金餘額",
  );

  const row = response.SubInfo.length
    ? recordSchema.safeParse(response.SubInfo[0])
    : undefined;
  const currentRow = row?.success ? row.data : undefined;
  const dates = dueHeader ? dateParts(currentRow?.DataValue3) : [];
  const startDate = dates[0];
  const dueDate = dates.length >= 2 ? dates[1] : undefined;

  const secondaryRows = Array.isArray(response.SubInfo_2)
    ? response.SubInfo_2
    : [];
  const secondaryRow = secondaryRows.length
    ? recordSchema.safeParse(secondaryRows[0])
    : undefined;
  const currentSecondaryRow = secondaryRow?.success
    ? secondaryRow.data
    : undefined;

  const interestPaymentAmount = interestHeader
    ? parseNumber(currentRow?.DataValue5)
    : undefined;

  const currentPrincipalBalance = principalHeader
    ? parseNumber(currentSecondaryRow?.DataValue6)
    : undefined;

  const raw = {
    ...(startDate ? { interestAccrualStartDate: startDate } : {}),
    ...(dueDate ? { interestAccrualEndDate: dueDate } : {}),
    ...(interestPaymentAmount != null ? { interestPaymentAmount } : {}),
    ...(currentPrincipalBalance != null ? { currentPrincipalBalance } : {}),
    ...(loanPaymentAmount != null ? { loanPaymentAmount } : {}),
    ...(dueHeader ? { interestAccrualDateFieldKey: dueHeader.FieldKey } : {}),
    ...(interestHeader
      ? { interestAmountFieldKey: interestHeader.FieldKey }
      : {}),
    ...(principalHeader
      ? { principalBalanceFieldKey: principalHeader.FieldKey }
      : {}),
  };

  return {
    ...(dueDate ? { paymentDueDate: dueDate } : {}),
    ...(loanPaymentAmount != null ? { loanPaymentAmount } : {}),
    raw,
    recognizedFieldCount:
      Number(Boolean(dueHeader)) +
      Number(Boolean(interestHeader)) +
      Number(Boolean(principalHeader)),
  };
}

function payDetailRequest(
  account: LoanAccountReference,
  info: LoanInfoFields,
): URLSearchParams {
  const value = (field: unknown) => plainText(field) ?? "";
  return new URLSearchParams({
    AcctValue: account.acctValue,
    AcctValueFormat: account.acctValueFormat,
    LoanAmt: value(info.LoanAmt),
    LoanBalance: value(info.LoanBalance),
    Sub1_Sub2: value(info.Sub1_Sub2),
    LoanKind: value(info.LoanKind),
    PayName: value(info.PayName),
    LNMAINACNO: account.acctValue,
    LNALTNO: value(info.Sub1_Sub2),
    CURRENCY: value(info.Currency),
  });
}

function emptyResult(): SinopacLoanSyncResult {
  return {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    loanOverviewComplete: false,
    accountListFailures: 0,
    accountDetailFailures: 0,
    paymentDetailFailures: 0,
    skippedAccounts: 0,
  };
}

export async function fetchSinopacLoans(
  request: Request,
  now = new Date(),
): Promise<SinopacLoanSyncResult> {
  const result = emptyResult();
  let listPayload: unknown;
  try {
    listPayload = await request(
      LOAN_ACCOUNT_PATH,
      "貸款帳戶清單",
      new URLSearchParams(),
    );
  } catch (error) {
    if (error instanceof SinopacVerificationRequiredError) throw error;
    result.accountListFailures = 1;
    return result;
  }

  const listing = parseSinopacLoanAccountList(listPayload);
  result.loanOverviewComplete = listing.complete;
  result.accountListFailures += listing.failureCount;
  if (listing.accounts.length === 0) return result;

  for (const account of listing.accounts) {
    let infoPayload: unknown;
    try {
      infoPayload = await request(
        LOAN_INFO_PATH,
        "貸款資料",
        new URLSearchParams({
          AcctValue: account.acctValue,
          AcctValueFormat: account.acctValueFormat,
        }),
      );
    } catch (error) {
      if (error instanceof SinopacVerificationRequiredError) throw error;
      result.accountDetailFailures += 1;
      result.loanOverviewComplete = false;
      continue;
    }

    const info = parseSinopacLoanInfo(account, infoPayload, now);
    if (!info) {
      result.accountDetailFailures += 1;
      result.skippedAccounts += 1;
      result.loanOverviewComplete = false;
      continue;
    }
    if (!info.currencyValid) {
      result.accountDetailFailures += 1;
      result.loanOverviewComplete = false;
    }

    let payDetail: PayDetail | undefined;
    try {
      const payload = await request(
        PAY_DETAIL_PATH,
        "貸款應繳資料",
        payDetailRequest(account, info.requestFields),
      );
      payDetail = parsePayDetail(payload);
      if (
        !payDetail ||
        payDetail.recognizedFieldCount !== 3 ||
        !payDetail.paymentDueDate ||
        payDetail.loanPaymentAmount == null
      ) {
        result.paymentDetailFailures += 1;
        result.loanOverviewComplete = false;
      }
    } catch (error) {
      if (error instanceof SinopacVerificationRequiredError) throw error;
      result.paymentDetailFailures += 1;
      result.loanOverviewComplete = false;
    }

    if (payDetail) {
      const accountRaw = info.account.raw as {
        sinopacLoan: Record<string, unknown>;
      };
      accountRaw.sinopacLoan.paymentDetail = payDetail.raw;
      if (info.snapshot) {
        const snapshotRaw = info.snapshot.raw as {
          sinopacLoan: Record<string, unknown>;
        };
        snapshotRaw.sinopacLoan.paymentDetail = payDetail.raw;
        if (payDetail.paymentDueDate)
          info.snapshot.paymentDueDate = payDetail.paymentDueDate;
        if (payDetail.loanPaymentAmount != null)
          info.snapshot.loanPaymentAmount = payDetail.loanPaymentAmount;
      }
    }

    result.bankAccounts.push(info.account);
    if (info.snapshot) result.bankBalanceSnapshots.push(info.snapshot);
  }

  return result;
}
