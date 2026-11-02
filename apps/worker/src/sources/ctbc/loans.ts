import { loanAccountName } from "../loan-account-name";
import forge from "node-forge";
import { CtbcVerificationRequiredError } from "./errors";
import { normalizeCtbcDate, parseCtbcAmount, type CtbcData } from "./protocol";

type Json = Record<string, unknown>;
type Request = (resource: string, data: Json) => Promise<Json>;
type Loans = Pick<CtbcData, "bankAccounts" | "bankBalanceSnapshots">;

/** 「我的貸款」頁（TWRBMInvestQU010）的初始化資源，Android 5.2.28 驗證。 */
export const CTBC_LOAN_SUMMARY_RESOURCE = "/twrbm-invest/qu010/010";

const LOAN_GROUPS = [
  { key: "ebLoanAcctSummaryP", category: "personal" },
  { key: "ebLoanAcctSummaryH", category: "housing" },
  { key: "ebLoanAcctSummaryLA", category: "other" },
  { key: "ebLoanAcctSummaryO", category: "other" },
] as const;

export type CtbcLoanSkipReason =
  | "loan_query_failed"
  | "loan_list_missing"
  | "loan_number_missing"
  | "loan_balance_missing";

export type CtbcLoanResult = Loans & { issue?: CtbcLoanSkipReason };

/**
 * 中信貸款是附加資料：查詢或解析失敗只略過貸款，不影響存款與信用卡。
 * 需要重新驗證的錯誤照常往外拋，讓整次同步進入驗證流程。
 */
export async function fetchCtbcLoans(
  request: Request,
  now = new Date(),
): Promise<CtbcLoanResult> {
  let response: Json;
  try {
    response = await request(CTBC_LOAN_SUMMARY_RESOURCE, {});
  } catch (error) {
    if (error instanceof CtbcVerificationRequiredError) throw error;
    return { ...empty(), issue: "loan_query_failed" };
  }
  return parseCtbcLoans(response, now);
}

/**
 * 解析 qu010/010：`ebLoanAcctSummaryP/H/LA/O` 各為（可能巢狀一層的）貸款陣列。
 * P 為信用貸款、H 為房屋貸款，其餘歸類 other。sourceId 為 `loan:ctbc:<hash>`，
 * raw 只留末四碼與貸款條件（扣款帳號欄位語意未確認，不寫 autopayAccount）；任何一筆缺帳號或餘額時整批略過，避免寫入半套資料。
 */
export function parseCtbcLoans(
  response: unknown,
  now = new Date(),
): CtbcLoanResult {
  const data = record(record(response).rsData);
  if (!LOAN_GROUPS.some((group) => Array.isArray(loanList(data[group.key]))))
    return { ...empty(), issue: "loan_list_missing" };
  const asOfAt = now.toISOString();
  const result = empty();
  const seen = new Set<string>();
  for (const group of LOAN_GROUPS) {
    for (const row of flatten(data[group.key])) {
      const loanAcctId = text(row.loanAcctId);
      if (!/\d{4}/.test(loanAcctId))
        return { ...empty(), issue: "loan_number_missing" };
      const balance = parseCtbcAmount(row.loanBalAmt);
      if (balance === undefined)
        return { ...empty(), issue: "loan_balance_missing" };
      const sourceId = `loan:ctbc:${hash(loanAcctId)}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const last4 = loanAcctId.match(/(\d{4})\D*$/)?.[1];
      const productName = text(row.prodType) || "中國信託貸款";
      const annualRatePct = parseCtbcAmount(row.intrstRate);
      const totalPeriods = positiveInt(row.loanTerm);
      const paidPeriods = nonNegativeInt(row.period);
      const remainingPeriods =
        nonNegativeInt(row.remTerm) ??
        (totalPeriods !== undefined && paidPeriods !== undefined
          ? Math.max(0, totalPeriods - paidPeriods)
          : undefined);
      const paymentAmount = parseCtbcAmount(row.pmtAmt);
      const nextPaymentDate = normalizeCtbcDate(row.repayDt);
      const remaining = -Math.abs(balance);
      result.bankAccounts.push({
        sourceId,
        institutionName: "中國信託商業銀行",
        accountName: loanAccountName(group.category, loanAcctId),
        accountType: "loan",
        loanCategory: group.category,
        ...(annualRatePct !== undefined
          ? { loanInterestRate: annualRatePct }
          : {}),
        currency: "TWD",
        raw: {
          last4,
          productName,
          initialAmount: parseCtbcAmount(row.approveBal),
          totalPeriods,
          remainingPeriods,
          annualRatePct,
          paymentDay: positiveInt(row.repayDay),
          nextPaymentDate,
          nextPaymentAmount: paymentAmount,
          drawdownDate: normalizeCtbcDate(row.loanDt),
          maturityDate: normalizeCtbcDate(row.expDt),
        },
      });
      const installmentsPaid =
        totalPeriods !== undefined && remainingPeriods !== undefined
          ? Math.max(0, totalPeriods - remainingPeriods)
          : paidPeriods;
      result.bankBalanceSnapshots.push({
        accountId: sourceId,
        sourceId: `snapshot:${sourceId}:${asOfAt.slice(0, 10)}`,
        balance: remaining,
        currency: "TWD",
        asOfAt,
        ...(nextPaymentDate ? { paymentDueDate: nextPaymentDate } : {}),
        ...(paymentAmount !== undefined
          ? { loanPaymentAmount: paymentAmount }
          : {}),
        ...(totalPeriods !== undefined && installmentsPaid !== undefined
          ? {
              loanInstallmentsPaid: installmentsPaid,
              loanInstallmentsTotal: totalPeriods,
            }
          : {}),
        raw: { balance: remaining },
      });
    }
  }
  return result;
}

function empty(): Loans {
  return { bankAccounts: [], bankBalanceSnapshots: [] };
}
function loanList(value: unknown): unknown {
  // 實機回應以 loanType 代碼為鍵包裝，例如 `{ "00": [{...}] }`；沒有貸款時為 `{}` 或 `[]`。
  if (!isRecord(value)) return value;
  const keys = Object.keys(value);
  return keys.every((key) => /^\d+$/.test(key))
    ? keys.sort((a, b) => Number(a) - Number(b)).map((key) => value[key])
    : value;
}
function flatten(value: unknown): Json[] {
  value = loanList(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const inner = loanList(item);
    return Array.isArray(inner)
      ? inner.filter(isRecord)
      : isRecord(inner)
        ? [inner]
        : [];
  });
}
function positiveInt(value: unknown) {
  const n = nonNegativeInt(value);
  return n !== undefined && n > 0 ? n : undefined;
}
function nonNegativeInt(value: unknown) {
  const raw = text(value);
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}
function text(value: unknown) {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
}
function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}
function hash(value: string) {
  return forge.md.sha256.create().update(value, "utf8").digest().toHex();
}
