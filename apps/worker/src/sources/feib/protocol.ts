import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "../financial-types";
import forge from "node-forge";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";

// 遠東商銀個人網路銀行（ebank.feib.com.tw/netbank，伺服器端 JSP）。
// 頁面結構依 2026-10 使用者提供的 HAR 去識別化後整理；未取得真實頁面的分支以
// TODO(feib-live) 標示，需以真實帳號驗收。

export const FEIB_BANK_CODE = "805";
export const FEIB_CAPTCHA_DIGIT_COUNT = 6;
export const FEIB_CREDIT_ACCOUNT_ID = "credit:feib:card";
export const FEIB_INSTITUTION_NAME = "遠東商銀";
/** 網銀「存款交易明細查詢」單次查詢期間上限（官方 checkDate2：迄日往前二個月的同一日）。 */
export const FEIB_MAX_RANGE_MONTHS = 2;
/** 網銀「帳單明細查詢」的帳單年月選單最多提供的期數；同步只取最近 BANK_SYNC_MONTHS 期。 */
export const FEIB_STATEMENT_MONTHS = BANK_SYNC_MONTHS;

export const feibConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  // 人工驗證碼：一次性 Browser session reference，成功或失敗後都清除。
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().optional(),
  captchaDigitCount: z.number().int().min(4).max(8).optional(),
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

export type FeibConfig = z.infer<typeof feibConfigSchema>;

export function parseFeibConfig(config: unknown): FeibConfig {
  return feibConfigSchema.parse(config);
}

export class FeibProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeibProtocolError";
  }
}

/** 單一資料列或欄位值不符預期；只略過該筆，不中止同步。 */
export class FeibRowRejectedError extends FeibProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "FeibRowRejectedError";
  }
}

// ---------------------------------------------------------------------------
// 部分失敗彙整
// ---------------------------------------------------------------------------

export const FEIB_SYNC_CATEGORIES = {
  deposits: "存款帳戶",
  depositTransactions: "存款交易明細",
  cardStatus: "信用卡額度與繳款",
  cardBills: "信用卡帳單",
  cardTransactions: "信用卡明細",
} as const;

export type FeibSyncCategory = keyof typeof FEIB_SYNC_CATEGORIES;

export type FeibSyncFailure = {
  category: FeibSyncCategory;
  /** 固定的階段代碼，例如 `fetch`、`parse`、`row`。 */
  stage: string;
  errorClass: string;
  /** 去識別化的錯誤訊息（帳號／卡號遮罩為末四碼、網址去除 query）。 */
  message: string;
};

const MAX_REPORTED_FAILURES = 12;

/** 錯誤類別與訊息去識別化：不含帳號、卡號、身分證字號或網址參數。 */
export function describeFeibError(error: unknown) {
  const name =
    error instanceof Error
      ? error.name || error.constructor?.name || "Error"
      : typeof error;
  const errorClass = /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(name) ? name : "Error";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = maskFeibText(
    raw
      .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
        try {
          const parsed = new URL(url);
          return `${parsed.host}${parsed.pathname}`;
        } catch {
          return "[url]";
        }
      })
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/\d{6,}/g, "[redacted]")
    .slice(0, 160);
  return { errorClass, message };
}

/** 同步過程逐類累計成功／失敗筆數；失敗只記錄去識別化原因。 */
export class FeibSyncReport {
  readonly counts: Record<
    FeibSyncCategory,
    { ok: number; failed: number; rowsRejected: number }
  >;
  readonly failures: FeibSyncFailure[] = [];
  private failureTotal = 0;

  constructor() {
    this.counts = Object.fromEntries(
      Object.keys(FEIB_SYNC_CATEGORIES).map((key) => [
        key,
        { ok: 0, failed: 0, rowsRejected: 0 },
      ]),
    ) as FeibSyncReport["counts"];
  }

  ok(category: FeibSyncCategory, count = 1) {
    this.counts[category].ok += count;
  }

  fail(category: FeibSyncCategory, stage: string, error: unknown, count = 1) {
    this.counts[category].failed += count;
    this.failureTotal += count;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({ category, stage, ...describeFeibError(error) });
    }
  }

  rejectRow(category: FeibSyncCategory, error: unknown) {
    this.counts[category].rowsRejected += 1;
    this.failureTotal += 1;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({
        category,
        stage: "row",
        ...describeFeibError(error),
      });
    }
  }

  get failedCount() {
    return this.failureTotal;
  }

  /** `feib_sync_summary` 記錄內容；只含筆數與去識別化原因。 */
  summary() {
    return {
      status: this.failureTotal > 0 ? "partial" : "complete",
      categories: this.counts,
      failureCount: this.failureTotal,
      failures: this.failures,
      failuresTruncated: this.failureTotal > this.failures.length,
    };
  }

  /** 給使用者看的部分失敗說明（不含帳號或金額）；沒有失敗時為 undefined。 */
  userMessage() {
    const failed = (Object.keys(this.counts) as FeibSyncCategory[])
      .filter(
        (key) => this.counts[key].failed + this.counts[key].rowsRejected > 0,
      )
      .map(
        (key) =>
          `${FEIB_SYNC_CATEGORIES[key]} ${this.counts[key].failed + this.counts[key].rowsRejected} 筆`,
      );
    return failed.length > 0
      ? `部分資料未能取得，已略過：${failed.join("、")}。`
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// 登入結果分類（頁面文字只在記憶體內比對，不寫入 log）
// ---------------------------------------------------------------------------

export type FeibLoginOutcome =
  | { kind: "success" }
  | { kind: "password_change_prompt" }
  | { kind: "captcha" }
  | { kind: "credential" }
  | { kind: "locked" }
  | { kind: "duplicate" }
  | { kind: "maintenance" }
  | { kind: "unknown" };

/**
 * 依登入送出後的提示文字（原生 alert 或錯誤頁文字）分類。帳密類錯誤優先判斷，
 * 避免同時提到驗證碼與密碼的訊息被當成可重試的驗證碼錯誤。
 * TODO(feib-live): 尚未取得帳密錯誤、鎖定、重複登入與維護時的真實頁面，
 * 以下關鍵字依官方登入頁的前端檢核文字與一般網銀用語推定。
 */
export function classifyFeibLoginMessage(text: string): FeibLoginOutcome {
  const message = text.replace(/\s+/g, "");
  if (!message) return { kind: "unknown" };
  if (
    /(鎖定|停用|暫停使用|凍結|註銷|已達\d*次|連續.{0,6}錯誤.{0,6}次)/.test(
      message,
    )
  )
    return { kind: "locked" };
  if (
    /(密碼|使用者代號|身分證|身份證|統一編號|帳號).{0,12}(錯誤|有誤|不符|不正確|不存在|無效)/.test(
      message,
    )
  )
    return { kind: "credential" };
  if (/(重複登入|已登入|其他.{0,8}登入|登入中)/.test(message))
    return { kind: "duplicate" };
  if (/驗證碼.{0,8}(錯誤|有誤|不符|不正確|逾時|失效|過期)/.test(message))
    return { kind: "captcha" };
  if (/(系統維護|維護中|暫停服務|系統忙碌|稍後再試)/.test(message))
    return { kind: "maintenance" };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// HTML helpers（JSP 頁面；不依賴 DOM）
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#160;": " ",
};

export function feibCellText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<select\b[\s\S]*?<\/select>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|#160);/g, (match) => {
      return ENTITY_MAP[match] ?? match;
    })
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 移除 HTML 註解與 script，避免註解掉的提示文字（例如無卡訊息）被當成頁面內容。 */
export function stripFeibNonContent(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ");
}

/** 只取主要內容區（`<div class="page">` 之後），避免選單文字干擾表頭比對。 */
function pageContent(html: string) {
  const start = html.search(/<div\b[^>]*class=["']page["']/);
  return start >= 0 ? html.slice(start) : html;
}

/** 全形數字與符號轉半形。 */
export function toHalfWidth(value: string) {
  return value
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(/，/g, ",")
    .replace(/．/g, ".")
    .replace(/[－﹣]/g, "-")
    .replace(/＋/g, "+")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/＊/g, "*")
    .replace(/／/g, "/");
}

const ROW_PATTERN =
  /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)(?:<\/tr>|(?=<tr\b)|(?=<\/tbody>)|(?=<\/table>))/gi;
const CELL_PATTERN = /<t([dh])\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;

export type FeibCell = { text: string; html: string };

/** 表格內每一列的儲存格（td 與 th 都計入）；不處理巢狀表格。 */
function tableRows(tableHtml: string): FeibCell[][] {
  const rows: FeibCell[][] = [];
  for (const match of tableHtml.matchAll(ROW_PATTERN)) {
    const cells: FeibCell[] = [];
    for (const cell of (match[1] ?? "").matchAll(CELL_PATTERN)) {
      const html = cell[3] ?? "";
      cells.push({ text: feibCellText(html), html });
    }
    rows.push(cells);
  }
  return rows;
}

/** 以表頭文字找到所在的 `<table>`（取表頭之前最近的 `<table` 至其後第一個 `</table>`）。 */
function tableContaining(
  html: string,
  marker: RegExp,
  from = 0,
): { html: string; end: number } | undefined {
  const sliced = html.slice(from);
  const match = marker.exec(sliced);
  if (!match) return undefined;
  const index = from + match.index;
  const tableStart = html.lastIndexOf("<table", index);
  const tableEnd = html.indexOf("</table>", index);
  if (tableStart < 0 || tableEnd < 0) return undefined;
  return {
    html: html.slice(tableStart, tableEnd + "</table>".length),
    end: tableEnd + "</table>".length,
  };
}

// ---------------------------------------------------------------------------
// 數字與日期
// ---------------------------------------------------------------------------

const BLANK_CELL = /^(?:|[-—–]{1,2}|N\/?A|無)$/i;
const AMOUNT_PATTERN = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** 單筆金額的合理上限（避免把帳號等長數字誤當金額）。 */
const MAX_AMOUNT = 1e12;

export function isFeibBlankCell(value: string | undefined) {
  return BLANK_CELL.test(
    toHalfWidth(value ?? "").replace(/[\s\u00a0\u3000]/g, ""),
  );
}

/**
 * 金額：`新臺幣 NTD$1,234元`、`NTD$0.00元`、`1,000.00`、`-500`、全形數字與括號負數。
 * 空白或 `-` 佔位符、千分位錯置、非數字與超出合理範圍的值回傳 undefined（不產生 NaN）。
 */
export function parseFeibAmount(value: string | undefined): number | undefined {
  if (value === undefined || isFeibBlankCell(value)) return undefined;
  let text = toHalfWidth(value)
    .replace(/[\s\u00a0\u3000]/g, "")
    .replace(/^(?:新臺幣|新台幣|臺幣|台幣)/, "")
    .replace(/^(?:NTD|NT|TWD|[A-Z]{3})?\$?/i, "")
    .replace(/元$/, "");
  let negative = false;
  const parenthesized = text.match(/^\((.*)\)$/);
  if (parenthesized) {
    negative = true;
    text = parenthesized[1] ?? "";
  } else if (/^[\d,.]+-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (!AMOUNT_PATTERN.test(text)) return undefined;
  if (negative && /^[-+]/.test(text)) return undefined;
  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_AMOUNT)
    return undefined;
  const signed = negative ? -parsed : parsed;
  return Object.is(signed, -0) ? 0 : signed;
}

const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

function isoDate(year: number, month: number, day: number) {
  if (year < MIN_YEAR || year > MAX_YEAR) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * 西元 `2026/08/18` 或民國 `115/10/03`（2～3 位數年份）轉為 `YYYY-MM-DD`。
 * 不存在的日期與 1990～2100 年以外的值回傳 undefined。
 */
export function parseFeibDate(value: string | undefined): string | undefined {
  if (value === undefined || isFeibBlankCell(value)) return undefined;
  const match = toHalfWidth(value)
    .trim()
    .match(/^(\d{2,4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  if (raw.length === 4 && Number(raw) < 1911) return undefined;
  const year = raw.length <= 3 ? Number(raw) + 1911 : Number(raw);
  return isoDate(year, Number(match[2]), Number(match[3]));
}

/**
 * 帳單明細的 `mm/dd` 依結帳日推得年份：同年日期晚於結帳日時視為前一年
 * （例如 1 月帳單中的 12/28，或分期第 N 期的原始消費日）。
 */
export function inferFeibStatementDate(
  value: string | undefined,
  statementClosingDate: string,
): string | undefined {
  if (value === undefined || isFeibBlankCell(value)) return undefined;
  const match = toHalfWidth(value)
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return undefined;
  const closingYear = Number(statementClosingDate.slice(0, 4));
  const month = Number(match[1]);
  const day = Number(match[2]);
  const sameYear = isoDate(closingYear, month, day);
  if (sameYear && sameYear <= statementClosingDate) return sameYear;
  // 2/29 等只存在於前一年的日期也會落到這裡。
  return isoDate(closingYear - 1, month, day);
}

const CURRENCY_NAMES: Record<string, string> = {
  臺幣: "TWD",
  台幣: "TWD",
  新臺幣: "TWD",
  新台幣: "TWD",
  美金: "USD",
  美元: "USD",
  人民幣: "CNY",
  日圓: "JPY",
  日幣: "JPY",
  歐元: "EUR",
  港幣: "HKD",
  澳幣: "AUD",
  南非幣: "ZAR",
  加拿大幣: "CAD",
  英鎊: "GBP",
  新加坡幣: "SGD",
  瑞士法郎: "CHF",
  紐西蘭幣: "NZD",
  瑞典幣: "SEK",
  泰銖: "THB",
};

/** 幣別名稱或 ISO 代碼轉為大寫代碼；無法辨識時回傳 undefined。 */
export function feibCurrency(value: string): string | undefined {
  const trimmed = value.replace(/[\s\u00a0\u3000]/g, "");
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return (
    CURRENCY_NAMES[trimmed] ?? CURRENCY_NAMES[trimmed.replace(/\(.*\)$/, "")]
  );
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

export function normalizeFeibAccountNo(value: string) {
  return digitsOnly(toHalfWidth(value));
}

function stableHash(value: string) {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

/** 文字中可能出現的帳號、卡號、身分證字號遮罩為末四碼。 */
export function maskFeibText(value: string) {
  return toHalfWidth(value)
    .replace(/\b[A-Z][12]\d{8}\b/g, "**********")
    .replace(/\d[\d*\s-]{6,}\d/g, (match) => {
      const digits = digitsOnly(match);
      return digits.length >= 6 ? `****${digits.slice(-4)}` : match;
    });
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function taipeiDate(now: Date) {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 存款總覽（我的存款 Logon/SvDeposit.jsp）
// ---------------------------------------------------------------------------

export type FeibDepositAccount = {
  accountNo: string;
  sourceId: string;
  typeName: string;
  currency: string;
  /** 交易明細查詢使用的網銀幣別代碼（新臺幣為 `00`）。 */
  currencyCode?: string;
  balance: number;
};

export function feibDepositSourceId(accountNo: string, currency: string) {
  const normalized = normalizeFeibAccountNo(accountNo);
  return `bank:feib:${normalized.slice(-4)}:${stableHash(`feib:${normalized}`)}:${currency}`;
}

/**
 * 活期性存款表：所屬分行 | 帳戶類別 | 帳號 | 幣別 | 帳戶餘額 | 我要查詢／申請。
 * 定期性存款表（往來單位）不納入：定存不在本次範圍。
 * TODO(feib-live): 外幣活存列的幣別與餘額格式（例如 `USD$`）尚未取得真實頁面。
 */
export function parseFeibDepositOverview(html: string): {
  accounts: FeibDepositAccount[];
  rejected: string[];
  timeDepositRows: number;
} {
  const content = stripFeibNonContent(html);
  const demandStart = content.search(/<h2[^>]*>\s*活期性存款\s*<\/h2>/);
  if (demandStart < 0) {
    throw new FeibProtocolError("遠東商銀存款總覽頁面格式不符。");
  }
  const timeStart = content.search(/<h2[^>]*>\s*定期性存款\s*<\/h2>/);
  const demandHtml = content.slice(
    demandStart,
    timeStart > demandStart ? timeStart : undefined,
  );
  const table = tableContaining(demandHtml, /<th[^>]*>\s*帳號\s*<\/th>/);
  if (!table) {
    throw new FeibProtocolError("遠東商銀存款總覽缺少活期性存款表格。");
  }
  const rows = tableRows(table.html);
  const header = rows.find((row) => row.some((cell) => cell.text === "帳號"));
  const index = (label: string) =>
    header?.findIndex((cell) => cell.text === label) ?? -1;
  const accountIndex = index("帳號");
  const typeIndex = index("帳戶類別");
  const currencyIndex = index("幣別");
  const balanceIndex = index("帳戶餘額");
  if (accountIndex < 0 || currencyIndex < 0 || balanceIndex < 0) {
    throw new FeibProtocolError("遠東商銀存款總覽欄位已變更。");
  }
  const accounts: FeibDepositAccount[] = [];
  const rejected: string[] = [];
  for (const row of rows) {
    if (row === header || row.length <= balanceIndex) continue;
    const accountNo = normalizeFeibAccountNo(row[accountIndex]?.text ?? "");
    if (accountNo.length < 10 || accountNo.length > 16) {
      rejected.push("存款總覽帳號格式不符。");
      continue;
    }
    const currency = feibCurrency(row[currencyIndex]?.text ?? "");
    if (!currency) {
      rejected.push("存款總覽幣別無法辨識。");
      continue;
    }
    const balance = parseFeibAmount(row[balanceIndex]?.text);
    if (balance === undefined) {
      rejected.push("存款總覽餘額格式不符。");
      continue;
    }
    // selFun1(fun, acct, ccycd, accttype, ckFinAcctcd)
    const rowHtml = row.map((cell) => cell.html).join("");
    const selFun = rowHtml.match(
      /selFun1\(\s*this\.value\s*,\s*'(\d+)'\s*,\s*'([0-9A-Za-z]*)'/,
    );
    const currencyCode =
      selFun && normalizeFeibAccountNo(selFun[1] ?? "") === accountNo
        ? selFun[2] || undefined
        : undefined;
    accounts.push({
      accountNo,
      sourceId: feibDepositSourceId(accountNo, currency),
      typeName: typeIndex >= 0 ? (row[typeIndex]?.text ?? "") : "",
      currency,
      currencyCode,
      balance,
    });
  }
  let timeDepositRows = 0;
  if (timeStart > demandStart) {
    const timeTable = tableContaining(
      content.slice(timeStart),
      /<th[^>]*>\s*帳號\s*<\/th>/,
    );
    if (timeTable) {
      timeDepositRows = tableRows(timeTable.html).filter(
        (row) => row.length > 0 && !row.some((cell) => cell.text === "帳號"),
      ).length;
    }
  }
  return { accounts, rejected, timeDepositRows };
}

// ---------------------------------------------------------------------------
// 存款交易明細（SavAcctTxDtlInq/SavAcctTxDtlInqPrompt.jsp）
// ---------------------------------------------------------------------------

export type FeibTransactionQuery = {
  accountNo: string;
  /** `YYYY/MM/DD` */
  start: string;
  /** `YYYY/MM/DD` */
  end: string;
};

export type FeibDepositTransactionRow = {
  transactionDate: string;
  bookingDate: string;
  summary: string;
  amount: number;
  balanceAfter?: number;
  memo: string;
};

export type FeibDepositTransactionPage = {
  rows: FeibDepositTransactionRow[];
  rejected: string[];
  /** 查詢成功但沒有交易（頁面沒有結果表格）。 */
  empty: boolean;
};

function selectedOptionValue(html: string, selectId: string) {
  const select = html.match(
    new RegExp(
      `<select\\b[^>]*\\bid=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`,
      "i",
    ),
  );
  if (!select) return undefined;
  const options = [
    ...(select[1] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi),
  ];
  const selected = options.find((option) =>
    /\bselected\b/i.test(option[1] ?? ""),
  );
  const chosen = selected ?? options[0];
  if (!chosen) return undefined;
  const value = (chosen[1] ?? "").match(/\bvalue\s*=\s*["']([^"']*)["']/i);
  return {
    value: value?.[1] ?? "",
    label: feibCellText(chosen[2] ?? ""),
    explicit: Boolean(selected),
  };
}

function inputValue(html: string, name: string) {
  const input = html.match(
    new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*>`, "i"),
  );
  return input?.[0].match(/\bvalue\s*=\s*["']([^"']*)["']/i)?.[1];
}

/** 交易明細查詢頁帳號選單中的帳號（14 碼）。 */
export function parseFeibTransactionAccountOptions(html: string): string[] {
  const select = html.match(
    /<select\b[^>]*\bid=["']acct["'][^>]*>([\s\S]*?)<\/select>/i,
  );
  if (!select) return [];
  return [...(select[1] ?? "").matchAll(/\bvalue\s*=\s*["']([^"']*)["']/gi)]
    .map((match) => normalizeFeibAccountNo(match[1] ?? ""))
    .filter((value) => value.length >= 10);
}

/**
 * 解析查詢結果並核對頁面回顯的帳號與起迄日。結果表：
 * 交易日期 | 帳務日期 | 摘要 | 支出金額 | 存入金額 | 帳戶餘額 | 備註 | 用途（下拉選單，忽略）。
 * 查無交易時頁面不顯示結果表格，視為 0 筆（不是錯誤）。
 * TODO(feib-live): 單次查詢筆數上限與分頁尚未觀察到（實測 5 筆無分頁）。
 */
export function parseFeibDepositTransactionsPage(
  html: string,
  query: FeibTransactionQuery,
): FeibDepositTransactionPage {
  const content = stripFeibNonContent(html);
  if (
    !/name=["']inqForm["']/.test(content) ||
    !/com\.lb\.wibc\.trx\.SavAcctTxDtlInq/.test(content)
  ) {
    throw new FeibProtocolError("遠東商銀交易明細頁面格式不符。");
  }
  const expectedAccount = normalizeFeibAccountNo(query.accountNo);
  const selected = selectedOptionValue(content, "acct");
  if (!selected || normalizeFeibAccountNo(selected.value) !== expectedAccount) {
    throw new FeibProtocolError("遠東商銀交易明細回應的帳號與查詢不符。");
  }
  if (
    inputValue(content, "sdate") !== query.start ||
    inputValue(content, "edate") !== query.end
  ) {
    throw new FeibProtocolError("遠東商銀交易明細回應的查詢期間與查詢不符。");
  }
  const table = tableContaining(
    content,
    /<th[^>]*>\s*交易日期\s*<\/th>[\s\S]*?帳戶餘額/,
  );
  if (!table) return { rows: [], rejected: [], empty: true };

  // 結果標題「活存帳號：…」「查詢期間：起~迄」也須與查詢一致。
  const tableIndex = content.indexOf(table.html);
  const captionStart = content.lastIndexOf("table-caption", tableIndex);
  const captionText =
    captionStart >= 0
      ? feibCellText(content.slice(captionStart, tableIndex))
      : "";
  const captionAccount = captionText.match(/活存帳號\s*[:：]\s*([\d-]+)/);
  if (
    captionAccount &&
    normalizeFeibAccountNo(captionAccount[1] ?? "") !== expectedAccount
  ) {
    throw new FeibProtocolError("遠東商銀交易明細結果帳號與查詢不符。");
  }
  const captionRange = captionText.match(
    /查詢期間\s*[:：]\s*(\d{4}\/\d{2}\/\d{2})\s*[~～]\s*(\d{4}\/\d{2}\/\d{2})/,
  );
  if (
    captionRange &&
    (captionRange[1] !== query.start || captionRange[2] !== query.end)
  ) {
    throw new FeibProtocolError("遠東商銀交易明細結果期間與查詢不符。");
  }

  const rows = tableRows(table.html);
  const header = rows.find((row) =>
    row.some((cell) => cell.text === "交易日期"),
  );
  const column = (label: string) =>
    header?.findIndex((cell) => cell.text === label) ?? -1;
  const columns = {
    transactionDate: column("交易日期"),
    bookingDate: column("帳務日期"),
    summary: column("摘要"),
    debit: column("支出金額"),
    credit: column("存入金額"),
    balance: column("帳戶餘額"),
    memo: column("備註"),
  };
  if (Object.values(columns).some((value) => value < 0)) {
    throw new FeibProtocolError("遠東商銀交易明細欄位已變更。");
  }
  const parsed: FeibDepositTransactionRow[] = [];
  const rejected: string[] = [];
  for (const row of rows) {
    if (row === header || row.length === 0) continue;
    const cell = (index: number) => row[index]?.text ?? "";
    const transactionDate = parseFeibDate(cell(columns.transactionDate));
    const bookingDate = parseFeibDate(cell(columns.bookingDate));
    if (!transactionDate || !bookingDate) {
      rejected.push("存款交易日期格式不符。");
      continue;
    }
    const debitText = cell(columns.debit);
    const creditText = cell(columns.credit);
    const debit = isFeibBlankCell(debitText) ? 0 : parseFeibAmount(debitText);
    const credit = isFeibBlankCell(creditText)
      ? 0
      : parseFeibAmount(creditText);
    if (debit === undefined || credit === undefined) {
      rejected.push("存款交易金額格式不符。");
      continue;
    }
    if ((debit !== 0) === (credit !== 0)) {
      rejected.push("存款交易支出與存入金額必須恰有一欄。");
      continue;
    }
    const balanceText = cell(columns.balance);
    const balanceAfter = isFeibBlankCell(balanceText)
      ? undefined
      : parseFeibAmount(balanceText);
    if (!isFeibBlankCell(balanceText) && balanceAfter === undefined) {
      rejected.push("存款交易餘額格式不符。");
      continue;
    }
    parsed.push({
      transactionDate,
      bookingDate,
      summary: cell(columns.summary),
      amount: roundCurrency(credit !== 0 ? Math.abs(credit) : -Math.abs(debit)),
      balanceAfter,
      memo: cell(columns.memo),
    });
  }
  return { rows: parsed, rejected, empty: false };
}

export function formatSlashDate(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "/");
}

function parseSlashDate(value: string) {
  const [y, m, d] = value.split("/").map(Number);
  return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/** 同步期間：近 BANK_SYNC_MONTHS 個月（含今日），台灣日期，`YYYY/MM/DD`。 */
export function feibTransactionRange(now: Date) {
  const taipei = new Date(now.getTime() + 8 * 3_600_000);
  const end = new Date(
    Date.UTC(
      taipei.getUTCFullYear(),
      taipei.getUTCMonth(),
      taipei.getUTCDate(),
    ),
  );
  const targetMonth = taipei.getUTCMonth() - BANK_SYNC_MONTHS;
  const lastDay = new Date(
    Date.UTC(taipei.getUTCFullYear(), targetMonth + 1, 0),
  ).getUTCDate();
  const start = new Date(
    Date.UTC(
      taipei.getUTCFullYear(),
      targetMonth,
      Math.min(taipei.getUTCDate(), lastDay),
    ),
  );
  return { start: formatSlashDate(start), end: formatSlashDate(end) };
}

/**
 * 官方 `checkDate2`：起日字串不可早於「迄日往前二個月的同一日」字串（可能是 4/31
 * 這類不存在的日期）。回傳符合此規則的最早實際日期。
 */
export function feibEarliestQueryStart(end: string) {
  const [year, month, day] = end.split("/").map(Number) as [
    number,
    number,
    number,
  ];
  let targetYear = year;
  let targetMonth = month - FEIB_MAX_RANGE_MONTHS;
  if (targetMonth < 1) {
    targetMonth += 12;
    targetYear -= 1;
  }
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  if (day <= lastDay) {
    return formatSlashDate(
      new Date(Date.UTC(targetYear, targetMonth - 1, day)),
    );
  }
  // 例如 6/30 往前二個月為「4/31」：4/30 的字串小於 4/31，最早只能從 5/1 起。
  return formatSlashDate(new Date(Date.UTC(targetYear, targetMonth, 1)));
}

/**
 * 將同步期間由近到遠切成每段不超過網銀上限的不重疊期間（整日切割）。
 * 同一日的交易必落在同一段，序號在不同同步之間保持一致。
 */
export function splitFeibRange(range: { start: string; end: string }) {
  const chunks: Array<{ start: string; end: string }> = [];
  const rangeStart = parseSlashDate(range.start);
  let end = range.end;
  for (let guard = 0; guard < 48; guard += 1) {
    if (parseSlashDate(end) < rangeStart) break;
    const earliest = feibEarliestQueryStart(end);
    const start =
      parseSlashDate(earliest) > rangeStart ? earliest : range.start;
    chunks.push({ start, end });
    if (start === range.start) break;
    end = formatSlashDate(new Date(parseSlashDate(start) - 86_400_000));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 信用卡可用額度與本期繳款（CCMember/queryCardLimit.jsp）
// ---------------------------------------------------------------------------

export type FeibCardStatus =
  | { hasCreditCard: false }
  | {
      hasCreditCard: true;
      statementClosingDate?: string;
      statementAmount?: number;
      minimumPayment?: number;
      paidAmount?: number;
      paymentDueDate?: string;
      lastPaymentDate?: string;
      creditLimit?: number;
      usedCredit?: number;
      availableCredit?: number;
    };

/**
 * 只有明確的「未持本行有效卡片」提示才視為無卡（官方頁面以註解保留同一段文字，
 * 解析前先移除 HTML 註解）。缺少額度表且沒有無卡提示時拋出錯誤，不當成無卡。
 * TODO(feib-live): 無卡提示僅依頁面註解中的文案以合成 fixture 驗證。
 */
export function parseFeibCardStatus(html: string): FeibCardStatus {
  const content = pageContent(stripFeibNonContent(html));
  const text = feibCellText(content);
  const summary = tableContaining(content, /<th[^>]*>\s*帳單結帳日\s*<\/th>/);
  if (!summary) {
    if (
      /未持(?:有)?本行有效(?:信用)?卡|未持有本行信用卡|尚未持有本行信用卡/.test(
        text,
      )
    ) {
      return { hasCreditCard: false };
    }
    throw new FeibProtocolError("遠東商銀信用卡額度頁面格式不符。");
  }
  const rows = tableRows(summary.html);
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => cell.text === "帳單結帳日"),
  );
  const header = rows[headerIndex] ?? [];
  const values =
    rows.slice(headerIndex + 1).find((row) => row.length > 0) ?? [];
  const valueOf = (label: string) => {
    const index = header.findIndex((cell) => cell.text === label);
    return index < 0 ? undefined : values[index]?.text;
  };
  // 額度區塊：每格是一個「表頭一列、值一列」的小表格。
  const amountAfterHeader = (label: string) => {
    const table = tableContaining(
      content,
      new RegExp(`<th[^>]*>\\s*(?:<p>)?\\s*${label}\\s*(?:</p>)?\\s*</th>`),
    );
    if (!table) return undefined;
    const tableValues = tableRows(table.html).filter(
      (row) => row.length > 0 && !row.some((cell) => cell.text === label),
    );
    return parseFeibAmount(tableValues[0]?.[0]?.text);
  };
  return {
    hasCreditCard: true,
    statementClosingDate: parseFeibDate(valueOf("帳單結帳日")),
    statementAmount: parseFeibAmount(valueOf("本期應繳總額")),
    minimumPayment: parseFeibAmount(valueOf("最低應繳金額")),
    paidAmount: parseFeibAmount(valueOf("本期累積已繳金額")),
    paymentDueDate: parseFeibDate(valueOf("本期繳款截止日")),
    lastPaymentDate: parseFeibDate(valueOf("最近繳款日期")),
    creditLimit: amountAfterHeader("您的信用卡額度"),
    usedCredit: amountAfterHeader("已使用額度"),
    availableCredit: amountAfterHeader("可使用額度"),
  };
}

// ---------------------------------------------------------------------------
// 帳單明細（CCMember/eStatementQry_success.jsp）
// ---------------------------------------------------------------------------

export type FeibStatementOption = {
  /** 表單送出的 `yyyyMm` 值（實測為帳單月份的前一個月）。 */
  value: string;
  /** 畫面顯示的帳單年月 `YYYYMM`（與結帳日月份相同）。 */
  label: string;
  selected: boolean;
};

/** 帳單年月選單；依畫面順序（新到舊）。 */
export function parseFeibStatementOptions(html: string): FeibStatementOption[] {
  const select = html.match(
    /<select\b[^>]*\bid=["']yyyyMm["'][^>]*>([\s\S]*?)<\/select>/i,
  );
  if (!select) return [];
  return [
    ...(select[1] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi),
  ]
    .map((option) => ({
      value:
        (option[1] ?? "").match(/\bvalue\s*=\s*["']?\s*(\d{6})/i)?.[1] ?? "",
      label: feibCellText(option[2] ?? ""),
      selected: /\bselected\b/i.test(option[1] ?? ""),
    }))
    .filter(
      (option) => /^\d{6}$/.test(option.value) && /^\d{6}$/.test(option.label),
    );
}

export type FeibCardTransaction = {
  cardLast4?: string;
  transactionDate: string;
  postedDate?: string;
  description: string;
  /** 銀行顯示的臺幣金額：正數為消費，負數為繳款／退款／回饋。 */
  bankAmount: number;
  foreignAmount?: number;
  foreignCurrency?: string;
};

export type FeibStatement = {
  /** `YYYY-MM`，取自結帳日。 */
  period: string;
  statementClosingDate: string;
  paymentDueDate?: string;
  creditLimit?: number;
  revolvingBalance?: number;
  autopay: boolean;
  previousBalance?: number;
  paymentsAndRefunds?: number;
  newCharges?: number;
  interest?: number;
  lateFee?: number;
  statementAmount: number;
  minimumPayment?: number;
  transactions: FeibCardTransaction[];
  rejected: string[];
};

/**
 * 帳單明細。結帳日／繳款截止日為民國年；消費明細的日期只有 `mm/dd`，依結帳日推得年份。
 * 卡片列「卡號：…末四碼」（全形數字）切換之後明細的卡號；之前的列（繳款、帳戶層級手續費）
 * 不帶卡號。沒有消費日的摘要列（上期應繳總金額、上期結欠款項、消費小計等）略過。
 * TODO(feib-live): 只有單卡帳單樣本；附卡、多卡與外幣交易的欄位語意仍待確認。
 */
export function parseFeibStatement(html: string): FeibStatement {
  const content = pageContent(stripFeibNonContent(html));
  const summary = tableContaining(content, /<th[^>]*>\s*結帳日\s*<\/th>/);
  if (!summary) {
    throw new FeibProtocolError("遠東商銀帳單明細缺少帳單摘要。");
  }
  const keyValues = (tableHtml: string) => {
    const rows = tableRows(tableHtml).filter((row) => row.length > 0);
    const header = rows[0] ?? [];
    const values = rows[1] ?? [];
    const map = new Map<string, string>();
    header.forEach((cell, index) =>
      map.set(cell.text, values[index]?.text ?? ""),
    );
    return map;
  };
  const first = keyValues(summary.html);
  const statementClosingDate = parseFeibDate(first.get("結帳日"));
  if (!statementClosingDate) {
    throw new FeibProtocolError("遠東商銀帳單結帳日格式不符。");
  }
  const amounts = tableContaining(
    content,
    /<th[^>]*>\s*本期應繳總額\s*<\/th>/,
    summary.end,
  );
  const second = amounts ? keyValues(amounts.html) : new Map<string, string>();
  const statementAmount = parseFeibAmount(second.get("本期應繳總額"));
  if (statementAmount === undefined) {
    throw new FeibProtocolError("遠東商銀帳單應繳總額格式不符。");
  }
  const autopayAccount = digitsOnly(first.get("指定之自動轉帳帳號") ?? "");

  const transactions: FeibCardTransaction[] = [];
  const rejected: string[] = [];
  const detail = tableContaining(content, /<th[^>]*>\s*消費日\s*<\/th>/);
  if (detail) {
    const rows = tableRows(detail.html);
    const header = rows.find((row) =>
      row.some((cell) => cell.text === "消費日"),
    );
    const column = (label: RegExp) =>
      header?.findIndex((cell) => label.test(cell.text)) ?? -1;
    const columns = {
      transactionDate: column(/^消費日$/),
      postedDate: column(/^入帳日$/),
      description: column(/^消費明細$/),
      twdAmount: column(/^臺幣金額$/),
      foreignAmount: column(/^外幣金額$/),
      country: column(/^國家-幣別$/),
    };
    if (
      columns.transactionDate < 0 ||
      columns.description < 0 ||
      columns.twdAmount < 0
    ) {
      throw new FeibProtocolError("遠東商銀帳單明細欄位已變更。");
    }
    let cardLast4: string | undefined;
    for (const row of rows) {
      if (row === header || row.length === 0) continue;
      const cell = (index: number) =>
        index < 0 ? "" : (row[index]?.text ?? "");
      const description = toHalfWidth(cell(columns.description));
      const cardHeader = description.match(/卡號\s*[:：]\s*([\d*\s-]+)/);
      if (cardHeader) {
        const digits = digitsOnly(cardHeader[1] ?? "");
        cardLast4 = digits.length >= 4 ? digits.slice(-4) : undefined;
        continue;
      }
      const rawDate = cell(columns.transactionDate);
      if (isFeibBlankCell(rawDate)) continue; // 摘要列
      const transactionDate = inferFeibStatementDate(
        rawDate,
        statementClosingDate,
      );
      const rawPosted = cell(columns.postedDate);
      const postedDate = isFeibBlankCell(rawPosted)
        ? undefined
        : inferFeibStatementDate(rawPosted, statementClosingDate);
      if (!transactionDate || (!isFeibBlankCell(rawPosted) && !postedDate)) {
        rejected.push("信用卡明細日期格式不符。");
        continue;
      }
      const bankAmount = parseFeibAmount(cell(columns.twdAmount));
      if (bankAmount === undefined) {
        rejected.push("信用卡明細金額格式不符。");
        continue;
      }
      const foreignText = cell(columns.foreignAmount);
      const foreignAmount = isFeibBlankCell(foreignText)
        ? undefined
        : parseFeibAmount(foreignText);
      const country = cell(columns.country).trim();
      transactions.push({
        cardLast4,
        transactionDate,
        postedDate,
        description: description.trim(),
        bankAmount,
        foreignAmount,
        // 國家-幣別如 `USA-USD`；只保留幣別代碼。
        foreignCurrency: country.match(/-([A-Z]{3})$/)?.[1],
      });
    }
  }
  return {
    period: statementClosingDate.slice(0, 7),
    statementClosingDate,
    paymentDueDate: parseFeibDate(first.get("繳款截止日")),
    creditLimit: parseFeibAmount(first.get("您的循環額度")),
    revolvingBalance: parseFeibAmount(first.get("循環信用本金餘額")),
    autopay: autopayAccount.length >= 6,
    previousBalance: parseFeibAmount(second.get("上期應繳總額")),
    paymentsAndRefunds: parseFeibAmount(second.get("已繳款/退款金額")),
    newCharges: parseFeibAmount(second.get("本期新增款項")),
    interest: parseFeibAmount(second.get("利息")),
    lateFee: parseFeibAmount(second.get("違約金")),
    statementAmount,
    minimumPayment: parseFeibAmount(second.get("最低應繳總額")),
    transactions,
    rejected,
  };
}

/** 帳單頁顯示的帳單年月（選取中的選項標籤）須與結帳日月份一致。 */
export function feibStatementLabel(html: string) {
  return selectedOptionValue(html, "yyyyMm")?.label;
}

// ---------------------------------------------------------------------------
// 繳款狀態
// ---------------------------------------------------------------------------

/**
 * - `paid`：已繳金額達應繳總額。
 * - `no_payment_needed`：應繳 0；`credit_balance`：應繳為負（溢繳）。
 * - `autopay_pending`：已設定自動轉帳且未過繳款截止日。
 * - `unpaid`／`partial`／`below_minimum`／`overdue`：未繳清（台灣日期比較截止日）。
 * - `unknown`：缺少足以判斷的金額。
 */
export type FeibPaymentState =
  | "paid"
  | "no_payment_needed"
  | "credit_balance"
  | "autopay_pending"
  | "unpaid"
  | "partial"
  | "below_minimum"
  | "overdue"
  | "unknown";

const PAID_STATES = new Set<FeibPaymentState>([
  "paid",
  "no_payment_needed",
  "credit_balance",
]);
const UNPAID_STATES = new Set<FeibPaymentState>([
  "autopay_pending",
  "unpaid",
  "partial",
  "below_minimum",
  "overdue",
]);

export function feibPaymentStateToIsPaid(
  state: FeibPaymentState,
): boolean | undefined {
  if (PAID_STATES.has(state)) return true;
  if (UNPAID_STATES.has(state)) return false;
  return undefined;
}

export function deriveFeibPaymentState(
  input: {
    statementAmount: number;
    minimumPayment?: number;
    paidAmount?: number;
    paymentDueDate?: string;
    autopay?: boolean;
  },
  now = new Date(),
): FeibPaymentState {
  const statement = input.statementAmount;
  if (statement < 0) return "credit_balance";
  if (statement === 0) return "no_payment_needed";
  const paid = input.paidAmount;
  if (paid === undefined) return "unknown";
  if (paid >= statement) return "paid";
  if (
    input.paymentDueDate !== undefined &&
    taipeiDate(now) > input.paymentDueDate
  )
    return "overdue";
  if (paid > 0) {
    if (input.minimumPayment !== undefined && paid < input.minimumPayment)
      return "below_minimum";
    return "partial";
  }
  if (input.autopay) return "autopay_pending";
  return "unpaid";
}

/**
 * 較早期別：以下一期帳單的「上期應繳總額」與「已繳款/退款金額」推得。只有下一期的
 * 上期應繳總額等於本期應繳總額時才採用；退款同樣抵減應繳，視為已繳的一部分。
 */
export function deriveFeibPreviousBillPayment(
  bill: Pick<
    FeibStatement,
    "statementAmount" | "minimumPayment" | "paymentDueDate"
  >,
  next:
    Pick<FeibStatement, "previousBalance" | "paymentsAndRefunds"> | undefined,
  now = new Date(),
): { state: FeibPaymentState; paidAmount?: number } {
  if (bill.statementAmount <= 0) {
    return {
      state: deriveFeibPaymentState({ statementAmount: bill.statementAmount }),
    };
  }
  if (
    !next ||
    next.previousBalance === undefined ||
    next.paymentsAndRefunds === undefined ||
    roundCurrency(next.previousBalance) !== roundCurrency(bill.statementAmount)
  ) {
    return { state: "unknown" };
  }
  const paidAmount = roundCurrency(Math.abs(next.paymentsAndRefunds));
  return {
    state: deriveFeibPaymentState(
      {
        statementAmount: bill.statementAmount,
        minimumPayment: bill.minimumPayment,
        paidAmount,
        paymentDueDate: bill.paymentDueDate,
      },
      now,
    ),
    paidAmount,
  };
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

export type FeibPayloads = {
  depositOverviewHtml?: string;
  depositTransactions: Array<{
    accountNo: string;
    currency: string;
    /** 每段查詢期間一頁。 */
    pages: Array<{ html: string; query: FeibTransactionQuery }>;
  }>;
  card?:
    | { hasCreditCard: false }
    | {
        hasCreditCard: true;
        statusHtml?: string;
        statementHtmls: string[];
      };
};

export type FeibData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
  hasCreditCard?: boolean;
};

function accountTypeOf(typeName: string): BankAccount["accountType"] {
  if (/支票/.test(typeName)) return "checking";
  return "savings";
}

/**
 * 正規化。任一帳戶、交易明細期間、帳單期別或明細列無法解析時只略過該項並記入
 * `report`，其餘資料照常回傳。
 */
export function parseFeibData(
  payloads: FeibPayloads,
  now = new Date(),
  report = new FeibSyncReport(),
): FeibData {
  const asOfAt = now.toISOString();
  const snapshotDate = taipeiDate(now);
  let accounts: FeibDepositAccount[] = [];
  if (payloads.depositOverviewHtml !== undefined) {
    try {
      const overview = parseFeibDepositOverview(payloads.depositOverviewHtml);
      accounts = overview.accounts;
      for (const reason of overview.rejected) {
        report.rejectRow("deposits", new FeibRowRejectedError(reason));
      }
    } catch (error) {
      report.fail("deposits", "parse", error);
    }
  }
  const bankAccounts: FeibData["bankAccounts"] = [];
  const bankBalanceSnapshots: FeibData["bankBalanceSnapshots"] = [];
  const bankTransactions: FeibData["bankTransactions"] = [];
  const creditCardBills: FeibData["creditCardBills"] = [];

  for (const account of accounts) {
    report.ok("deposits");
    const last4 = account.accountNo.slice(-4);
    const raw = {
      bankCode: FEIB_BANK_CODE,
      accountLast4: last4,
      accountTypeName: account.typeName || undefined,
      currency: account.currency,
    };
    bankAccounts.push({
      sourceId: account.sourceId,
      institutionName: FEIB_INSTITUTION_NAME,
      accountName: `${account.typeName || "活期存款"} 末四碼 ${last4}`,
      accountType: accountTypeOf(account.typeName),
      currency: account.currency,
      raw,
    });
    bankBalanceSnapshots.push({
      accountId: account.sourceId,
      sourceId: `snapshot:feib:${account.sourceId.split(":").slice(2).join(":")}:${snapshotDate}`,
      balance: account.balance,
      currency: account.currency,
      asOfAt,
      raw: { ...raw, balance: account.balance },
    });
  }

  for (const entry of payloads.depositTransactions) {
    const sourceId = feibDepositSourceId(entry.accountNo, entry.currency);
    if (!accounts.some((account) => account.sourceId === sourceId)) {
      report.fail(
        "depositTransactions",
        "parse",
        new FeibProtocolError("遠東商銀交易明細帳號不在存款總覽中。"),
      );
      continue;
    }
    for (const page of entry.pages) {
      try {
        const parsed = parseFeibDepositTransactionsPage(page.html, page.query);
        for (const reason of parsed.rejected) {
          report.rejectRow(
            "depositTransactions",
            new FeibRowRejectedError(reason),
          );
        }
        bankTransactions.push(
          ...feibDepositTransactions(
            sourceId,
            entry.accountNo,
            entry.currency,
            parsed.rows,
          ),
        );
        report.ok("depositTransactions");
      } catch (error) {
        report.fail("depositTransactions", "parse", error);
      }
    }
  }

  let hasCreditCard: boolean | undefined;
  if (payloads.card) {
    if (!payloads.card.hasCreditCard) {
      hasCreditCard = false;
    } else {
      const card = parseCreditCard(
        payloads.card,
        asOfAt,
        snapshotDate,
        now,
        report,
      );
      if (card.kind === "no_card") {
        hasCreditCard = false;
      } else if (card.kind === "data") {
        hasCreditCard = true;
        bankAccounts.push(card.account);
        if (card.snapshot) bankBalanceSnapshots.push(card.snapshot);
        bankTransactions.push(...card.transactions);
        creditCardBills.push(...card.bills);
      }
    }
  }

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions: dedupeBySourceId(bankTransactions),
    creditCardBills,
    hasCreditCard,
  };
}

/**
 * 存款交易 ID：`sha256(帳號|幣別|交易日期|帳務日期|帶正負號金額|交易後餘額|摘要)` 前 16 碼
 * 加上同一查詢期間內相同識別的序號。查詢期間以整日切割，同一日的交易必在同一頁，
 * 序號在不同同步之間一致。備註不納入識別（可能含遮罩或截斷）。
 */
export function feibDepositTransactions(
  accountId: string,
  accountNo: string,
  currency: string,
  rows: FeibDepositTransactionRow[],
): FeibData["bankTransactions"] {
  const normalized = normalizeFeibAccountNo(accountNo);
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const identity = [
      normalized,
      currency,
      row.transactionDate,
      row.bookingDate,
      row.amount.toFixed(2),
      row.balanceAfter === undefined ? "" : row.balanceAfter.toFixed(2),
      row.summary.replace(/\s+/g, " ").trim(),
    ].join("|");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const summary = maskFeibText(row.summary);
    const memo = maskFeibText(row.memo);
    return {
      accountId,
      sourceId: `feib:deposit:tx:v1:${stableHash(identity)}:${occurrence}`,
      postedDate: row.bookingDate,
      authorizedAt: row.transactionDate,
      amount: row.amount,
      currency,
      description: summary || memo || "遠東商銀交易",
      counterparty: memo || undefined,
      status: "posted" as const,
      raw: {
        summary: summary || undefined,
        memo: memo || undefined,
        balanceAfter: row.balanceAfter,
      },
    };
  });
}

type FeibCardParseResult =
  | { kind: "no_card" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      account: FeibData["bankAccounts"][number];
      snapshot?: FeibData["bankBalanceSnapshots"][number];
      transactions: FeibData["bankTransactions"];
      bills: FeibData["creditCardBills"];
    };

function parseCreditCard(
  payload: Extract<NonNullable<FeibPayloads["card"]>, { hasCreditCard: true }>,
  asOfAt: string,
  snapshotDate: string,
  now: Date,
  report: FeibSyncReport,
): FeibCardParseResult {
  let status: Extract<FeibCardStatus, { hasCreditCard: true }> | undefined;
  if (payload.statusHtml !== undefined) {
    try {
      const parsed = parseFeibCardStatus(payload.statusHtml);
      if (!parsed.hasCreditCard) return { kind: "no_card" };
      status = parsed;
      report.ok("cardStatus");
    } catch (error) {
      report.fail("cardStatus", "parse", error);
    }
  }

  const parsedStatements: FeibStatement[] = [];
  for (const html of payload.statementHtmls) {
    try {
      const statement = parseFeibStatement(html);
      const label = feibStatementLabel(html);
      if (label && label !== statement.period.replace("-", "")) {
        throw new FeibProtocolError("遠東商銀帳單年月與結帳日不一致。");
      }
      parsedStatements.push(statement);
      report.ok("cardBills");
    } catch (error) {
      report.fail("cardBills", "parse", error);
    }
  }
  const statements = Array.from(
    new Map(parsedStatements.map((bill) => [bill.period, bill])).values(),
  )
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, FEIB_STATEMENT_MONTHS);

  if (!status && statements.length === 0) return { kind: "unavailable" };

  for (const reason of statements.flatMap((bill) => bill.rejected)) {
    report.rejectRow("cardTransactions", new FeibRowRejectedError(reason));
  }

  const bills: FeibData["creditCardBills"] = statements.map((bill, index) => {
    const current =
      status?.statementClosingDate !== undefined &&
      bill.statementClosingDate === status.statementClosingDate;
    const payment = current
      ? {
          state: deriveFeibPaymentState(
            {
              statementAmount: bill.statementAmount,
              minimumPayment: bill.minimumPayment,
              paidAmount: status!.paidAmount,
              paymentDueDate: bill.paymentDueDate,
              autopay: bill.autopay,
            },
            now,
          ),
          paidAmount: status!.paidAmount,
          source: "card_limit_page" as const,
        }
      : {
          ...deriveFeibPreviousBillPayment(bill, statements[index - 1], now),
          source: "next_statement" as const,
        };
    return {
      accountId: FEIB_CREDIT_ACCOUNT_ID,
      sourceId: `feib:card:bill:${bill.period}`,
      billingPeriod: bill.period,
      statementAmount: bill.statementAmount,
      minimumPayment: bill.minimumPayment,
      statementClosingDate: bill.statementClosingDate,
      paymentDueDate: bill.paymentDueDate,
      paidAmount: payment.paidAmount,
      isPaid: feibPaymentStateToIsPaid(payment.state),
      currency: "TWD",
      raw: {
        period: bill.period,
        previousBalance: bill.previousBalance,
        paymentsAndRefunds: bill.paymentsAndRefunds,
        newCharges: bill.newCharges,
        interest: bill.interest,
        lateFee: bill.lateFee,
        autopay: bill.autopay,
        paymentState: payment.state,
        paymentStateSource:
          payment.state === "unknown" ? undefined : payment.source,
      },
    };
  });

  // 帳單明細一律為已入帳；未出帳消費（uncutoverStatementQry）尚未接入。
  // TODO(feib-live): 未出帳明細頁面尚未取得，接入後以 pending 狀態並沿用相同 ID 規則。
  const occurrences = new Map<string, number>();
  const allTransactions: FeibData["bankTransactions"] = [];
  for (const bill of [...statements].reverse()) {
    for (const row of bill.transactions) {
      const amount = roundCurrency(-row.bankAmount);
      const card = row.cardLast4 ?? "account";
      const identity = `${card}:${row.transactionDate}:${amount}`;
      // 序號只在同一期帳單內累計：分期各期的卡號、原始消費日與金額相同，
      // 跨期累計會在帳單窗口位移時改變序號與 sourceId，造成重複入帳。
      const occurrenceKey = `${bill.period}:${identity}`;
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      allTransactions.push({
        accountId: FEIB_CREDIT_ACCOUNT_ID,
        sourceId: `feib:card:tx:v1:${bill.period}:${identity}:${occurrence}`,
        authorizedAt: row.transactionDate,
        postedDate: row.postedDate,
        amount,
        currency: "TWD",
        description: maskFeibText(row.description) || "遠東商銀信用卡",
        status: "posted",
        cardLast4: row.cardLast4,
        raw: {
          cardLast4: row.cardLast4,
          statementPeriod: bill.period,
          bankPostedDate: row.postedDate,
          foreignCurrency: row.foreignCurrency,
          foreignAmount: row.foreignAmount,
        },
      });
    }
  }
  const transactions = dedupeBySourceId(allTransactions);
  report.ok("cardTransactions", transactions.length);

  // 負債快照採額度頁「已使用額度」（含已出帳未繳與未出帳消費）。
  // TODO(feib-live): 確認已使用額度是否含分期未到期金額與預借現金，必要時改用帳單剩餘應繳 + 未出帳。
  const remaining =
    status?.statementAmount !== undefined
      ? roundCurrency(status.statementAmount - (status.paidAmount ?? 0))
      : undefined;
  const snapshot =
    status && status.usedCredit !== undefined
      ? {
          accountId: FEIB_CREDIT_ACCOUNT_ID,
          sourceId: `snapshot:feib:credit:${snapshotDate}`,
          balance: roundCurrency(-status.usedCredit),
          statementBalance: status.statementAmount,
          statementClosingDate: status.statementClosingDate,
          paymentDueDate: status.paymentDueDate,
          noPaymentNeeded: remaining !== undefined ? remaining <= 0 : undefined,
          currency: "TWD",
          asOfAt,
          raw: {
            usedCredit: status.usedCredit,
            availableCredit: status.availableCredit,
            paidAmount: status.paidAmount,
            remainingAmount: remaining,
          },
        }
      : undefined;

  return {
    kind: "data",
    account: {
      sourceId: FEIB_CREDIT_ACCOUNT_ID,
      institutionName: FEIB_INSTITUTION_NAME,
      accountName: "遠東商銀信用卡",
      accountType: "credit" as const,
      currency: "TWD",
      creditLimit: status?.creditLimit ?? statements[0]?.creditLimit,
    },
    snapshot,
    transactions,
    bills,
  };
}

/**
 * `feib_sync_result`：同步結束的一行總結（只含筆數與幣別，不含帳號或金額）。
 */
export function summarizeFeibResult(data: FeibData, report: FeibSyncReport) {
  const deposits = data.bankAccounts.filter(
    (account) => account.accountType !== "credit",
  );
  const creditIds = new Set(
    data.bankAccounts
      .filter((account) => account.accountType === "credit")
      .map((account) => account.sourceId),
  );
  const cardTransactions = data.bankTransactions.filter((txn) =>
    creditIds.has(txn.accountId),
  ).length;
  const failed = report.failedCount;
  const status = failed > 0 ? "partial" : "complete";
  return {
    message:
      `feib[sync] ${status === "complete" ? "success" : "partial"} - ` +
      `depositAccounts:${deposits.length}, cards:${creditIds.size}, ` +
      `cardBills:${data.creditCardBills.length}` +
      (failed > 0 ? `, failed:${failed}` : ""),
    status,
    depositAccounts: deposits.length,
    currencies: [...new Set(deposits.map((account) => account.currency))],
    creditCards: creditIds.size,
    depositTransactions: data.bankTransactions.length - cardTransactions,
    cardBills: data.creditCardBills.length,
    cardTransactions,
    failed,
  };
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}
