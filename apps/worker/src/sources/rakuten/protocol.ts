import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import {
  parseRakutenDepositTransactions,
  type RakutenTransactionStats,
} from "./deposit-transactions";

/**
 * 樂天國際銀行網銀瀏覽器工作階段設定。
 *
 * 由於網銀 session 幾分鐘便會失效，每次同步皆獨立登入；`browserSessionId`／
 * `captcha` 僅用於人工輸入之一次性 challenge state，成功或失敗後皆會清除；
 * schema 刻意不宣告 `sessionCookies`／`sessionCreatedAt`／`captchaDigitCount`。
 */
export const rakutenConfigSchema = z.object({
  userId: z.string().min(1).max(10).optional(),
  account: z.string().min(1).max(12).optional(),
  password: z.string().min(1).max(12).optional(),
  browserSessionId: z.string().max(256).optional(),
  browserSessionExpiresAt: z.string().optional(),
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

export type RakutenConfig = z.infer<typeof rakutenConfigSchema>;

export function parseRakutenConfig(config: unknown): RakutenConfig {
  return rakutenConfigSchema.parse(config);
}

/** 解析器輸入：存款、貸款各自可用 API JSON 或頁面文字，JSON 優先。 */
export type RakutenPayloads = {
  /** 首頁 API（CHMQU0001）回應，含 depositInfo。 */
  dashboardPayload?: unknown;
  /** 貸款 API 回應，含 loanProjects／loanList。 */
  loanPayload?: unknown;
  /** 「臺幣存款」頁面文字，存款 JSON 取不到時的備援。 */
  depositPageText?: string;
  /** 貸款頁（我的貸款）的頁面文字，貸款 JSON 取不到時的備援。 */
  loanPageText?: string;
  /**
   * 臺幣活存明細 API（CTWQU0001/010 當月、CTWQU0001/011 指定月份）的回應，
   * 每個元素是一個月份的 rsData；沒有就不產生交易。
   */
  depositTxnPayloads?: unknown[];
};

export type RakutenLoan = {
  title: string;
  remainingAmount: number;
  initialAmount?: number;
  remainingPeriods?: number;
  totalPeriods?: number;
  annualRatePct?: number;
  paymentDay?: number;
  nextPaymentDate?: string;
  nextPaymentAmount?: number;
  /** 撥款日（起息日），YYYY-MM-DD；估算歷史餘額回溯用。 */
  drawdownDate?: string;
  /** API 的貸款編號（頁面文字沒有）。 */
  loanNo?: string;
};

export type RakutenData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  /** 交易解析的筆數統計（只有數字與原因代碼），供 connector 記錄 log。 */
  transactionStats: RakutenTransactionStats;
};

/**
 * 餘額快照 ID 帶上日期（UTC，與淨值歷史取日期的方式一致）：每天保留一筆，
 * 同一天多次同步只覆寫當天那筆，淨值歷史才有逐日的樂天餘額。
 */
function snapshotSourceId(base: string, asOfAt: string): string {
  return `${base}:${asOfAt.slice(0, 10)}`;
}

type AccountDraft = Omit<BankAccount, "id" | "connectorId">;
type SnapshotDraft = Omit<BankBalanceSnapshot, "id" | "connectorId">;
type ParsedAccount = {
  account: AccountDraft;
  snapshot: SnapshotDraft;
  /** 存款帳號（只用於比對活存明細屬於哪個帳戶，不寫入交易）。 */
  depositAccountNo?: string;
};

/**
 * 存款與貸款各自獨立解析：各自優先使用 JSON，JSON 沒有解析出資料才改用
 * 頁面文字，最後合併。任一方的 JSON 成功都不會讓另一方的文字被忽略。
 */
export function parseRakutenData(
  payloads: RakutenPayloads,
  now = new Date(),
): RakutenData {
  const asOfAt = now.toISOString();
  const depositsFromJson = depositAccountsFromPayload(
    payloads.dashboardPayload,
    asOfAt,
  );
  const deposits =
    depositsFromJson.length > 0
      ? depositsFromJson
      : depositAccountsFromText(payloads.depositPageText, asOfAt);
  const loansFromJson = loansFromPayload(payloads.loanPayload);
  const loansFromText = payloads.loanPageText
    ? parseLoanText(payloads.loanPageText)
    : [];
  const loans = loanAccounts(
    loansFromJson.length > 0
      ? withTermsFromText(loansFromJson, loansFromText)
      : loansFromText,
    asOfAt,
  );

  const parsed = [...deposits, ...loans];
  const { transactions, stats } = parseRakutenDepositTransactions(
    payloads.depositTxnPayloads ?? [],
    deposits.flatMap((item) =>
      item.depositAccountNo
        ? [
            {
              sourceId: item.account.sourceId,
              accountNo: item.depositAccountNo,
            },
          ]
        : [],
    ),
  );
  return {
    bankAccounts: parsed.map((item) => item.account),
    bankBalanceSnapshots: parsed.map((item) => item.snapshot),
    bankTransactions: transactions,
    transactionStats: stats,
  };
}

function depositAccountsFromPayload(
  payload: unknown,
  asOfAt: string,
): ParsedAccount[] {
  return parseDepositPayload(payload).map(({ accountNo, entry, balance }) => {
    const sourceId = `bank:rakuten:${accountNo}:TWD`;
    return {
      depositAccountNo: accountNo,
      account: {
        sourceId,
        institutionName: "樂天國際銀行",
        accountName: entry.showAcctNo
          ? `樂天活儲 (${String(entry.showAcctNo)})`
          : "樂天活儲",
        accountType: "savings",
        currency: "TWD",
        raw: {
          accountType: "savings",
          riskType: entry.riskType,
          rate: entry.rate,
        },
      },
      snapshot: {
        accountId: sourceId,
        sourceId: snapshotSourceId(`snapshot:rakuten:${accountNo}:TWD`, asOfAt),
        balance,
        currency: "TWD",
        asOfAt,
        raw: { balance, rateAmount: entry.rateAmount },
      },
    };
  });
}

function depositAccountsFromText(
  text: string | undefined,
  asOfAt: string,
): ParsedAccount[] {
  const deposit = text ? parseDepositText(text) : undefined;
  if (!deposit) return [];
  const sourceId = `bank:rakuten:${deposit.accountNo}:TWD`;
  return [
    {
      depositAccountNo: deposit.accountNo,
      account: {
        sourceId,
        institutionName: "樂天國際銀行",
        accountName: "樂天活儲",
        accountType: "savings",
        currency: "TWD",
        raw: { accountType: "savings" },
      },
      snapshot: {
        accountId: sourceId,
        sourceId: snapshotSourceId(
          `snapshot:rakuten:${deposit.accountNo}:TWD`,
          asOfAt,
        ),
        balance: deposit.balance,
        currency: "TWD",
        asOfAt,
        raw: { balance: deposit.balance },
      },
    },
  ];
}

function loansFromPayload(payload: unknown): RakutenLoan[] {
  if (!isRecord(payload)) return [];
  const projects = Array.isArray(payload.loanProjects)
    ? payload.loanProjects
    : Array.isArray(payload.loanList)
      ? payload.loanList
      : [];
  return projects
    .filter(isRecord)
    .map(loanFromProject)
    .filter((loan): loan is RakutenLoan => loan !== undefined);
}

const LOAN_TERM_KEYS = [
  "initialAmount",
  "remainingPeriods",
  "totalPeriods",
  "annualRatePct",
  "paymentDay",
  "nextPaymentDate",
  "nextPaymentAmount",
  "drawdownDate",
] as const;

/**
 * 首頁送出的精簡版貸款 API 每筆只有名稱與剩餘金額；貸款頁的完整版才有利率、
 * 期數、下次扣款等條件。JSON 缺少條件時，依名稱對到唯一一筆畫面文字的貸款
 * 補上（剩餘金額仍以 JSON 為準）；對不到或名稱重複就不補。
 */
function withTermsFromText(
  loans: RakutenLoan[],
  textLoans: RakutenLoan[],
): RakutenLoan[] {
  return loans.map((loan) => {
    const matches = textLoans.filter((text) => text.title === loan.title);
    if (matches.length !== 1) return loan;
    const text = matches[0]!;
    const merged: RakutenLoan = { ...loan };
    for (const key of LOAN_TERM_KEYS) {
      if (merged[key] === undefined && text[key] !== undefined) {
        (merged as Record<string, unknown>)[key] = text[key];
      }
    }
    return merged;
  });
}

// 樂天貸款頁面（clnqu0001 模組）使用的欄位名稱排在前面，其餘為備援候選；
// 找不到剩餘金額的項目直接略過（不記成 0），讓流程改走頁面文字。
const LOAN_TITLE_KEYS = ["marketingName", "loanName", "productName"];
const LOAN_REMAINING_KEYS = ["remainLoanAmount", "loanBal", "remainAmt"];
const LOAN_INITIAL_KEYS = [
  "initLoanAmount",
  "loanAmount",
  "contractAmt",
  "origLoanAmt",
];
const LOAN_REMAINING_PERIOD_KEYS = ["remainPeriod", "remainTerm"];
const LOAN_TOTAL_PERIOD_KEYS = [
  "initPeriod",
  "totalPeriod",
  "totalTerm",
  "loanTerm",
];
const LOAN_RATE_KEYS = ["currentRate", "loanRate", "interestRate", "rate"];
// 貸款頁「每月繳款日」顯示的是 monthlyRepayDay（實際自動扣款日）；monthlyPayDay 在正式
// 資料裡是另一個日期，不能排在前面。
const LOAN_PAYMENT_DAY_KEYS = [
  "monthlyRepayDay",
  "monthlyPayDay",
  "payDay",
  "paymentDay",
  "deductDay",
];
const LOAN_NEXT_DATE_KEYS = [
  "nextRepaymentDate",
  "nextPayDate",
  "nextPaymentDate",
];
const LOAN_NEXT_AMOUNT_KEYS = [
  "nextRepaymentAmount",
  "currentPeriodAmount",
  "nextPayAmt",
  "nextPaymentAmount",
];
const LOAN_NUMBER_KEYS = ["loanAcctNo", "loanNo", "acctNo", "contractNo"];
/** 貸款完整版 API（CLNQU0001/010）的撥款日／起息日欄位候選，格式 "YYYY/MM/DD"。 */
const LOAN_DRAWDOWN_DATE_KEYS = ["lastDrawdownDate", "effectiveDate"];

function firstNumber(
  record: JsonRecord,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed =
      typeof value === "string" ? parseAmount(value) : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstString(
  record: JsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = accountNoOf(record[key]);
    if (value) return value;
  }
  return undefined;
}

function loanFromProject(project: JsonRecord): RakutenLoan | undefined {
  const remainingAmount = firstNumber(project, LOAN_REMAINING_KEYS);
  if (remainingAmount === undefined) return undefined;
  const nextPaymentDate = firstString(project, LOAN_NEXT_DATE_KEYS);
  const drawdownDate = firstString(project, LOAN_DRAWDOWN_DATE_KEYS);
  return {
    title: firstString(project, LOAN_TITLE_KEYS) ?? "樂天信貸",
    remainingAmount,
    initialAmount: firstNumber(project, LOAN_INITIAL_KEYS),
    remainingPeriods: firstNumber(project, LOAN_REMAINING_PERIOD_KEYS),
    totalPeriods: firstNumber(project, LOAN_TOTAL_PERIOD_KEYS),
    annualRatePct: firstNumber(project, LOAN_RATE_KEYS),
    paymentDay: firstNumber(project, LOAN_PAYMENT_DAY_KEYS),
    nextPaymentDate: nextPaymentDate
      ? normalizeLoanDate(nextPaymentDate)
      : undefined,
    nextPaymentAmount: firstNumber(project, LOAN_NEXT_AMOUNT_KEYS),
    drawdownDate: drawdownDate ? normalizeLoanDate(drawdownDate) : undefined,
    loanNo: firstString(project, LOAN_NUMBER_KEYS),
  };
}

/**
 * 貸款 sourceId 的識別鍵：只用貸款名稱。
 *
 * 樂天貸款 API（CLNQU0001/010）的首頁精簡版只有名稱與剩餘金額，貸款頁完整版
 * 才有貸款編號、初始金額與期數；頁面文字也不一定解析得到。每條路徑都一定
 * 拿得到、且每期還款後不會變的只有名稱，用它各路徑才會對同一筆貸款產生相同
 * ID。格式沿用「名稱::」（與正式環境 JSON 路徑已建立的帳戶相同）；同名貸款
 * 在同一次同步內以序號區分。
 */
function loanIdentityKey(loan: RakutenLoan): string {
  return `${loan.title}::`;
}

function loanAccounts(loans: RakutenLoan[], asOfAt: string): ParsedAccount[] {
  const seen = new Map<string, number>();
  return loans.map((loan) => {
    const key = loanIdentityKey(loan);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    // 同一次同步內條件完全相同的貸款加上序號，避免互相覆蓋
    const hash = stableHash(key) + (occurrence > 1 ? `-${occurrence}` : "");
    const sourceId = `loan:rakuten:${hash}`;
    const balance = -Math.abs(loan.remainingAmount);
    return {
      account: {
        sourceId,
        institutionName: "樂天國際銀行",
        accountName: loan.title,
        accountType: "loan",
        loanCategory: "other",
        ...(loan.annualRatePct !== undefined
          ? { loanInterestRate: loan.annualRatePct }
          : {}),
        currency: "TWD",
        raw: {
          initialAmount: loan.initialAmount,
          remainingPeriods: loan.remainingPeriods,
          totalPeriods: loan.totalPeriods,
          annualRatePct: loan.annualRatePct,
          paymentDay: loan.paymentDay,
          nextPaymentDate: loan.nextPaymentDate,
          nextPaymentAmount: loan.nextPaymentAmount,
          drawdownDate: loan.drawdownDate,
          // 貸款編號只保留末四碼，raw 不存完整帳號。
          loanNoLast4: loan.loanNo ? loan.loanNo.slice(-4) : undefined,
        },
      },
      snapshot: {
        accountId: sourceId,
        sourceId: snapshotSourceId(`snapshot:loan:rakuten:${hash}`, asOfAt),
        balance,
        currency: "TWD",
        asOfAt,
        ...(loan.nextPaymentAmount !== undefined
          ? { loanPaymentAmount: loan.nextPaymentAmount }
          : {}),
        ...(loan.totalPeriods !== undefined &&
        loan.remainingPeriods !== undefined
          ? {
              loanInstallmentsPaid: loan.totalPeriods - loan.remainingPeriods,
              loanInstallmentsTotal: loan.totalPeriods,
            }
          : {}),
        raw: { balance },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 存款 JSON 解析（白名單）
// ---------------------------------------------------------------------------

/** 樂天國際商業銀行的金融機構代碼。 */
const RAKUTEN_BANK_CODE = "826";
const BALANCE_KEYS = [
  "balance",
  "ntdCurrBal",
  "acctBal",
  "currBal",
  "totalBal",
] as const;

type JsonRecord = Record<string, unknown>;

type RakutenDeposit = {
  accountNo: string;
  balance: number;
  entry: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountNoOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

/** 比對用：忽略帳號中的空白與連字號。 */
function comparableAccountNo(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function bankCodeOf(entry: JsonRecord): string {
  return accountNoOf(entry.bankNo ?? entry.bankCode);
}

/** 明確標示為樂天本行（銀行代碼 826 或銀行名稱含「樂天」）。 */
function isExplicitRakutenEntry(entry: JsonRecord): boolean {
  const bankCode = bankCodeOf(entry);
  const bankName = accountNoOf(entry.bankName);
  return (
    bankCode.startsWith(RAKUTEN_BANK_CODE) ||
    (bankName !== "" && bankName.includes("樂天"))
  );
}

/** 他行／轉入對手帳號標記：第二道防線，任何一項成立就排除。 */
function isForeignEntry(entry: JsonRecord): boolean {
  const bankCode = bankCodeOf(entry);
  if (
    bankCode &&
    !bankCode.startsWith(RAKUTEN_BANK_CODE) &&
    bankCode !== "0" &&
    bankCode !== "000"
  ) {
    return true;
  }
  const bankName = accountNoOf(entry.bankName);
  if (bankName && !bankName.includes("樂天")) return true;
  const currency = accountNoOf(
    entry.currency ?? entry.cur ?? entry.curr ?? entry.ccy,
  );
  if (currency && !/^(TWD|NTD)$/i.test(currency)) return true;
  return (
    entry.isOtherBank === true ||
    entry.isOther === true ||
    entry.otherBankFlag === true ||
    entry.otherBankFlag === "1" ||
    entry.otherBankFlag === "Y" ||
    entry.isCounterparty === true ||
    entry.isTxCounterparty === true ||
    entry.isTransferAccount === true
  );
}

/** 依序找第一個有效的有限數字餘額（接受千分位字串）；全部無效回傳 undefined。 */
function balanceOf(entry: JsonRecord): number | undefined {
  for (const key of BALANCE_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    const text =
      typeof value === "number"
        ? String(value)
        : String(value).replace(/[\s,]/g, "");
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) continue;
    const amount = Number(text);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
}

/**
 * 從首頁 dashboard payload 解析臺幣活存帳戶，採白名單：
 *
 * - payload 有主帳號（`depositInfo.acctNo` 或 `acctNo`）時，只接受該帳號，
 *   或明確標示為樂天本行（銀行代碼 826／名稱含「樂天」）的帳號。
 * - 沒有主帳號時，只接受明確標示為樂天本行的帳號；都沒有標示時，只有在
 *   恰好一筆候選帳號時才接受，多筆無法分辨就一律不收。
 * - 他行標記（銀行代碼、名稱、幣別、各種 flag）先行排除，作為第二道防線。
 */
function parseDepositPayload(payload: unknown): RakutenDeposit[] {
  if (!isRecord(payload)) return [];
  const depositInfo = isRecord(payload.depositInfo)
    ? payload.depositInfo
    : undefined;
  const primaryHolder = [depositInfo, payload].find(
    (holder): holder is JsonRecord =>
      holder !== undefined && accountNoOf(holder.acctNo) !== "",
  );
  const primaryAcctNo = primaryHolder
    ? comparableAccountNo(accountNoOf(primaryHolder.acctNo))
    : "";

  const listed = Array.isArray(depositInfo?.depAccounts)
    ? depositInfo.depAccounts
    : Array.isArray(payload.depAccounts)
      ? payload.depAccounts
      : [];
  let candidates = listed.filter(isRecord);
  if (candidates.length === 0) {
    const single = [depositInfo?.depAccount, payload.depAccount].find(isRecord);
    candidates = single ? [single] : primaryHolder ? [primaryHolder] : [];
  }

  const eligible = candidates.filter(
    (entry) => accountNoOf(entry.acctNo) !== "" && !isForeignEntry(entry),
  );
  let accepted: JsonRecord[];
  if (primaryAcctNo) {
    accepted = eligible.filter(
      (entry) =>
        comparableAccountNo(accountNoOf(entry.acctNo)) === primaryAcctNo ||
        isExplicitRakutenEntry(entry),
    );
    // 清單裡找不到主帳號時，改用帶有主帳號與餘額的那一層本身
    if (
      accepted.length === 0 &&
      primaryHolder &&
      balanceOf(primaryHolder) !== undefined
    ) {
      accepted = [primaryHolder];
    }
  } else {
    const explicit = eligible.filter(isExplicitRakutenEntry);
    accepted =
      explicit.length > 0 ? explicit : eligible.length === 1 ? eligible : [];
  }

  const deposits: RakutenDeposit[] = [];
  const seen = new Set<string>();
  for (const entry of accepted) {
    const accountNo = accountNoOf(entry.acctNo);
    const key = comparableAccountNo(accountNo);
    if (seen.has(key)) continue;
    // 沒有有效餘額就略過，不寫入 0 或 NaN 的錯誤快照；確認有效後才標記已處理，
    // 同一帳號後面若還有有效的候選資料仍會採用。
    const balance = balanceOf(entry);
    if (balance === undefined) continue;
    seen.add(key);
    deposits.push({ accountNo, balance, entry });
  }
  return deposits;
}

// ---------------------------------------------------------------------------
// 頁面文字解析（JSON 取不到時的備援）
// ---------------------------------------------------------------------------
function parseDepositText(
  text: string,
): { accountNo: string; balance: number } | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let labelIndex = lines.findIndex((line) => line.includes("活存總額"));
  if (labelIndex === -1) {
    labelIndex = lines.findIndex(
      (line) =>
        line === "活存" ||
        line.includes("活期儲蓄") ||
        line.includes("存款總額"),
    );
  }
  if (labelIndex === -1) return undefined;

  let balance: number | undefined;
  const searchEnd = Math.min(labelIndex + 5, lines.length);
  for (let i = labelIndex; i < searchEnd; i += 1) {
    const line = lines[i] ?? "";
    const amountMatch =
      line.match(/\$\s*(-?[\d,]+)/) ??
      (i > labelIndex ? line.match(/^(-?[\d,]+)$/) : null);
    if (amountMatch?.[1] !== undefined) {
      balance = parseAmount(amountMatch[1]);
      break;
    }
  }

  const accountNo = findDepositAccountNo(lines, labelIndex);
  if (!accountNo || balance === undefined) return undefined;
  return { accountNo, balance };
}

const ACCOUNT_SEARCH_RADIUS = 8;
/** 交易明細、轉帳等區塊的起點：帳號搜尋碰到就停，不跨進去找。 */
const SECTION_BOUNDARY = /明細|交易|轉入|轉出|受款|收款|他行|跨行|約定/;

function mentionsOtherBank(line: string): boolean {
  if (line.includes("樂天")) return false;
  return (
    /銀行|商銀|郵局|郵政|合作社|農會|漁會/.test(line) ||
    new RegExp(`\\((?!${RAKUTEN_BANK_CODE}\\))\\d{3}\\)`).test(line)
  );
}

/**
 * 只在「活存總額」等標籤附近找帳號（白名單思維）：由標籤往前、往後各掃
 * 描最多 8 行，碰到交易明細／轉帳區塊即停止；本行或上一行提到他行名稱
 * 或代碼的號碼一律略過。找不到就不猜，不再全文搜尋任意長數字，避免抓到
 * 轉入的他行對手帳號。
 */
function findDepositAccountNo(
  lines: string[],
  labelIndex: number,
): string | undefined {
  const found: Array<{ distance: number; accountNo: string }> = [];
  for (const step of [-1, 1]) {
    for (
      let distance = step === -1 ? 0 : 1;
      distance <= ACCOUNT_SEARCH_RADIUS;
      distance += 1
    ) {
      const index = labelIndex + step * distance;
      const line = lines[index];
      if (line === undefined) break;
      if (distance > 0 && SECTION_BOUNDARY.test(line)) break;
      if (
        mentionsOtherBank(line) ||
        mentionsOtherBank(lines[index - 1] ?? "")
      ) {
        continue;
      }
      const match = line.match(/(?<!\d)(\d{10,16})(?!\d)/);
      if (match?.[1]) {
        found.push({ distance, accountNo: match[1] });
        break;
      }
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  return found[0]?.accountNo;
}

function parseLoanText(text: string): RakutenLoan[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markerIndexes = lines
    .map((line, index) => (line === "剩餘貸款金額" ? index : -1))
    .filter((index) => index >= 0);

  const loans: RakutenLoan[] = [];
  for (let m = 0; m < markerIndexes.length; m += 1) {
    const idx = markerIndexes[m];
    if (idx === undefined) continue;
    const nextIdx = markerIndexes[m + 1] ?? lines.length;
    const title = idx > 0 ? lines[idx - 1] : undefined;
    if (!title || title === "貸款總覽" || title === "查看還款明細") continue;

    let remainingAmount: number | undefined;
    const amountSearchEnd = Math.min(idx + 3, nextIdx);
    for (let i = idx + 1; i < amountSearchEnd; i += 1) {
      const amountMatch = lines[i]?.match(/\$\s*(-?[\d,]+)/);
      if (amountMatch?.[1] !== undefined) {
        remainingAmount = parseAmount(amountMatch[1]);
        break;
      }
    }
    if (remainingAmount === undefined) continue;

    const block = lines.slice(idx, nextIdx).join("\n");
    const initialMatch = block.match(/初始貸款金額\s*\$?\s*([\d,]+)/);
    const periodsMatch = block.match(
      /剩餘[／/]初始期數\s*([\d]+)\s*[／/]\s*([\d]+)/,
    );
    const rateMatch = block.match(/當期年利率\s*([\d.]+)\s*%/);
    const paymentDayMatch = block.match(/每月繳款日\s*([\d]+)\s*日/);
    const nextPaymentMatch = block.match(
      /下次將於\s*([\d]{4}\/[\d]{1,2}\/[\d]{1,2})\s*扣款\s*\$?\s*([\d,]+)/,
    );

    loans.push({
      title,
      remainingAmount,
      initialAmount: initialMatch?.[1]
        ? parseAmount(initialMatch[1])
        : undefined,
      remainingPeriods: periodsMatch?.[1] ? Number(periodsMatch[1]) : undefined,
      totalPeriods: periodsMatch?.[2] ? Number(periodsMatch[2]) : undefined,
      annualRatePct: rateMatch?.[1] ? Number(rateMatch[1]) : undefined,
      paymentDay: paymentDayMatch?.[1] ? Number(paymentDayMatch[1]) : undefined,
      nextPaymentDate: nextPaymentMatch?.[1]
        ? normalizeSlashDate(nextPaymentMatch[1])
        : undefined,
      nextPaymentAmount: nextPaymentMatch?.[2]
        ? parseAmount(nextPaymentMatch[2])
        : undefined,
    });
  }
  return loans;
}

function parseAmount(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[$, ]/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

/** 2026/10/17、2026-10-17、20261017 → 2026-10-17；無法辨識就不記。 */
function normalizeLoanDate(value: string): string | undefined {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const normalized = normalizeSlashDate(value.replace(/-/g, "/"));
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function normalizeSlashDate(value: string): string {
  const parts = value.split("/");
  if (parts.length !== 3) return value;
  const [year, month, day] = parts;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
