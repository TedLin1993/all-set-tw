// 國泰世華貸款總覽 API（L_ACCT_Q_OverView）：頁面內查詢與 Worker 端欄位對應。
// 對應結果與 DOM 解析（loan-overview.ts）產生的 CathayLoanRecord 相同；
// log 只能記錄代碼與筆數，不可記錄帳號、金額、日期或 session。

import type { CathayApiSession } from "./loan-detail";
import type { CathayLoanRecord } from "./loan-overview";

export const CATHAY_LOAN_OVERVIEW_API_PATH =
  "/OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverView";

/**
 * 官方前端（utils-BaW-5-FP.js）的 loanType 列舉與分組：trustLoan、houseLoan、
 * otherLoan 三組，總覽頁依此分成「理財型貸款／房屋貸款／其他貸款」三個區塊。
 */
export const CATHAY_LOAN_TYPE_GROUPS = {
  ElasticityLoanMonthly: "trustLoan",
  ElasticityLoanAmortized: "trustLoan",
  TrustLoan: "trustLoan",
  CycleHouseLoan: "houseLoan",
  SecondPlaceLoan: "houseLoan",
  HouseLoan: "houseLoan",
  NetValueLoan: "houseLoan",
  CycleFinancialLoan: "otherLoan",
  TurnOverLoan: "otherLoan",
  CapitalExpenditureLoan: "otherLoan",
  ConstructionFinancingLoan: "otherLoan",
  CarLoan: "otherLoan",
  CashCardLoan: "otherLoan",
  OtherLoan: "otherLoan",
} as const;

type CathayLoanType = keyof typeof CATHAY_LOAN_TYPE_GROUPS;

/** 官方前端不顯示「已繳 n 期，共 m 期」的循環／理財型貸款（顯示為 -）。 */
const LOAN_TYPES_WITHOUT_INSTALLMENTS: ReadonlySet<string> = new Set([
  "ElasticityLoanMonthly",
  "ElasticityLoanAmortized",
  "CycleHouseLoan",
  "CycleFinancialLoan",
]);

export type CathayLoanOverviewApiItem = {
  account: unknown;
  loanType: unknown;
  interestRate: unknown;
  nextDeductionDate: unknown;
  loanBalance: unknown;
  loanTerm: unknown;
  alreadyPayPeriod: unknown;
  overTimePeriod: unknown;
  isBadDebt: unknown;
  amountPayable: unknown;
};

export type CathayLoanOverviewApiResponse = {
  /** 最後一次請求的 HTTP 狀態；未收到回應為 0。 */
  httpStatus: number;
  /** 回應的 returnCode（截短），或 no_response／invalid／not_called。 */
  returnCode: string;
  success: boolean | null;
  /** content.status（Normal／MaintainTime…）；非字串時為 null。 */
  status: string | null;
  /** content.accountList 只保留對應需要的欄位；不是陣列時為 null。 */
  accountList: CathayLoanOverviewApiItem[] | null;
  attempts: number;
};

/**
 * 在已登入的 cathaybk.com.tw OnlineBanking 頁面內，以 `getCathayApiSession`
 * 取得的 session 呼叫 `L_ACCT_Q_OverView`（`content` 為 `customerId`，有
 * idType 時附 `idType`，與官方前端相同）。未收到回應或回應不是 JSON 時，
 * 等待約 300ms 後重試一次；有 returnCode 的業務錯誤不重試。只回傳對應需要的
 * 欄位。此函式在瀏覽器內執行，不可引用外部變數；回傳值不可寫入 log。
 */
export async function queryCathayLoanOverviewApi(input: {
  session: CathayApiSession | null;
}): Promise<CathayLoanOverviewApiResponse> {
  const result: CathayLoanOverviewApiResponse = {
    httpStatus: 0,
    returnCode: "not_called",
    success: null,
    status: null,
    accountList: null,
    attempts: 0,
  };
  if (!input || typeof XMLHttpRequest === "undefined") return result;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const session = isRecord(input.session) ? input.session : null;
  const token =
    session && typeof session.token === "string" ? session.token : "";
  const customerId =
    session && typeof session.customerId === "string" ? session.customerId : "";
  const idType =
    session &&
    typeof session.idType === "string" &&
    session.idType.trim() !== ""
      ? session.idType.trim()
      : null;
  if (!token || !customerId) return result;

  const post = (body: string): Promise<{ status: number; json: unknown }> =>
    new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open(
          "POST",
          "/OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverView",
        );
        xhr.withCredentials = true;
        xhr.timeout = 15_000;
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.onload = () => {
          try {
            resolve({ status: xhr.status, json: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ status: xhr.status, json: null });
          }
        };
        xhr.onerror = () => resolve({ status: 0, json: null });
        xhr.ontimeout = () => resolve({ status: 0, json: null });
        xhr.send(body);
      } catch {
        resolve({ status: 0, json: null });
      }
    });
  const pad = (n: number) => String(n).padStart(2, "0");
  // 每次請求（含重試）各自產生 functionSeqNo，避免重送被視為重複交易。
  const newBody = () => {
    const now = new Date();
    const functionSeqNo = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${crypto.randomUUID()}`;
    return JSON.stringify({
      functionSeqNo,
      content: { customerId, ...(idType ? { idType } : {}) },
    });
  };

  result.attempts = 1;
  let reply = await post(newBody());
  if (!isRecord(reply.json)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    result.attempts = 2;
    reply = await post(newBody());
  }
  result.httpStatus = reply.status;
  const response = reply.json;
  if (!isRecord(response)) {
    result.returnCode = "no_response";
    return result;
  }
  const rawCode = response.returnCode;
  result.returnCode =
    typeof rawCode === "string" && /^[A-Za-z0-9_]{1,12}$/.test(rawCode)
      ? rawCode
      : "invalid";
  result.success =
    typeof response.success === "boolean" ? response.success : null;
  const content = isRecord(response.content) ? response.content : null;
  if (!content) return result;
  result.status = typeof content.status === "string" ? content.status : null;
  if (Array.isArray(content.accountList)) {
    result.accountList = content.accountList.map((item) => {
      const record = isRecord(item) ? item : {};
      return {
        account: record.account,
        loanType: record.loanType,
        interestRate: record.interestRate,
        nextDeductionDate: record.nextDeductionDate,
        loanBalance: record.loanBalance,
        loanTerm: record.loanTerm,
        alreadyPayPeriod: record.alreadyPayPeriod,
        overTimePeriod: record.overTimePeriod,
        isBadDebt: record.isBadDebt,
        amountPayable: record.amountPayable,
      };
    });
  }
  return result;
}

export type CathayLoanOverviewApiFailureReason =
  "no_response" | "non_0000" | "maintenance" | "schema_mismatch";

export type CathayLoanOverviewApiParseResult =
  | {
      ok: true;
      loanRecords: CathayLoanRecord[];
      /** false 表示有官方不顯示金額的呆帳（isBadDebt）被略過，與 DOM 路徑相同。 */
      complete: boolean;
    }
  | { ok: false; reason: CathayLoanOverviewApiFailureReason };

/**
 * 將 `L_ACCT_Q_OverView` 回應轉為與 DOM 解析相同的 `CathayLoanRecord`。
 * 依官方總覽頁的顯示規則：
 * - 類別：loanType 分組 houseLoan → housing、otherLoan → other；trustLoan
 *   （理財型）與 DOM 相同不設類別。
 * - overTimePeriod > 0 時官方顯示「未完成扣款」：paymentStatus 為
 *   collection_incomplete、不設 paymentDueDate；否則 nextDeductionDate 取日期
 *   部分（YYYY-MM-DD）並為 scheduled。
 * - isBadDebt 時官方金額與餘額顯示為 -，DOM 無法解析而略過該筆；此處同樣略過
 *   並標記不完整，不讓同步停用其他貸款。
 * - 期數只在官方會顯示時（非呆帳、非循環／理財型）帶入。
 * - 幣別：官方總覽頁固定顯示「幣別：TWD」，API 沒有幣別欄位，固定為 TWD。
 * 結構不符（未知 loanType、缺必要欄位、帳號格式不符或重複）時回傳
 * schema_mismatch，由呼叫端改走 DOM 路徑。
 */
export function parseCathayLoanOverviewApi(
  response: CathayLoanOverviewApiResponse | null | undefined,
): CathayLoanOverviewApiParseResult {
  if (!response || response.returnCode === "no_response") {
    return { ok: false, reason: "no_response" };
  }
  if (response.returnCode !== "0000" || response.success === false) {
    return { ok: false, reason: "non_0000" };
  }
  if (response.status === "MaintainTime") {
    return { ok: false, reason: "maintenance" };
  }
  if (typeof response.status !== "string" || !response.accountList) {
    return { ok: false, reason: "schema_mismatch" };
  }
  // 官方只有 status 為 Normal 時才把空清單顯示為「目前無貸款資料」。
  if (response.accountList.length === 0) {
    return response.status === "Normal"
      ? { ok: true, loanRecords: [], complete: true }
      : { ok: false, reason: "schema_mismatch" };
  }

  const finiteNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const nonNegative = (value: unknown): number | null => {
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
  };
  const count = (value: unknown): number | null => {
    const number = nonNegative(value);
    return number !== null && Number.isInteger(number) ? number : null;
  };

  const loanRecords: CathayLoanRecord[] = [];
  const seenAccounts = new Set<string>();
  let skippedBadDebt = false;
  for (const item of response.accountList) {
    const accountNumber =
      typeof item.account === "string" ? item.account.trim() : "";
    if (!/^\d{8,20}$/.test(accountNumber) || seenAccounts.has(accountNumber)) {
      return { ok: false, reason: "schema_mismatch" };
    }
    seenAccounts.add(accountNumber);
    const loanType =
      typeof item.loanType === "string" &&
      Object.prototype.hasOwnProperty.call(
        CATHAY_LOAN_TYPE_GROUPS,
        item.loanType,
      )
        ? (item.loanType as CathayLoanType)
        : null;
    if (!loanType || typeof item.isBadDebt !== "boolean") {
      return { ok: false, reason: "schema_mismatch" };
    }
    const overTimePeriod = count(item.overTimePeriod);
    if (overTimePeriod === null) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (item.isBadDebt) {
      skippedBadDebt = true;
      continue;
    }
    const currentPaymentAmount = nonNegative(item.amountPayable);
    const balance = nonNegative(item.loanBalance);
    if (currentPaymentAmount === null || balance === null) {
      return { ok: false, reason: "schema_mismatch" };
    }
    if (
      item.interestRate !== undefined &&
      item.interestRate !== null &&
      finiteNumber(item.interestRate) === null
    ) {
      return { ok: false, reason: "schema_mismatch" };
    }
    const interestRate = finiteNumber(item.interestRate) ?? undefined;

    let paymentDueDate: string | undefined;
    let paymentStatus: CathayLoanRecord["paymentStatus"];
    if (overTimePeriod > 0) {
      paymentStatus = "collection_incomplete";
    } else {
      const dateMatch =
        typeof item.nextDeductionDate === "string"
          ? item.nextDeductionDate
              .trim()
              .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/)
          : null;
      if (!dateMatch) return { ok: false, reason: "schema_mismatch" };
      paymentDueDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      paymentStatus = "scheduled";
    }

    const installmentsPaid = count(item.alreadyPayPeriod);
    const installmentsTotal = count(item.loanTerm);
    const showInstallments =
      !LOAN_TYPES_WITHOUT_INSTALLMENTS.has(loanType) &&
      installmentsPaid !== null &&
      installmentsTotal !== null;
    const group = CATHAY_LOAN_TYPE_GROUPS[loanType];
    const loanCategory =
      group === "houseLoan"
        ? "housing"
        : group === "otherLoan"
          ? "other"
          : undefined;

    loanRecords.push({
      accountNumber,
      ...(loanCategory ? { loanCategory } : {}),
      ...(interestRate !== undefined ? { interestRate } : {}),
      currentPaymentAmount,
      ...(paymentDueDate ? { paymentDueDate } : {}),
      paymentStatus,
      balance,
      ...(showInstallments
        ? {
            installmentsPaid: installmentsPaid!,
            installmentsTotal: installmentsTotal!,
          }
        : {}),
      currency: "TWD",
    });
  }
  return { ok: true, loanRecords, complete: !skippedBadDebt };
}
