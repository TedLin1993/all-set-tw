import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "../financial-types";
import forge from "node-forge";
import { z } from "zod";
import { isNoCreditCardMessage } from "../credit-card-status";
import { BANK_SYNC_MONTHS } from "../sync-window";
import { creditCardLiabilityBalance } from "../credit-card-liability";

export const FUBON_BANK_CODE = "012";
export const FUBON_CAPTCHA_DIGIT_COUNT = 6;
export const FUBON_CREDIT_ACCOUNT_ID = "credit:fubon:card";

export const fubonConfigSchema = z.object({
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
  // 雙重驗證（簡訊／Email OTP）：等待使用者輸入時保留的 Browser session，短暫且加密保存。
  otpBrowserSessionId: z.string().optional(),
  otpExpiresAt: z.string().optional(),
  otp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export type FubonConfig = z.infer<typeof fubonConfigSchema>;

export function parseFubonConfig(config: unknown): FubonConfig {
  return fubonConfigSchema.parse(config);
}

export class FubonProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FubonProtocolError";
  }
}

/** 單一資料列或欄位值不符預期；只略過該筆，不中止同步。 */
export class FubonRowRejectedError extends FubonProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "FubonRowRejectedError";
  }
}

// ---------------------------------------------------------------------------
// 部分失敗彙整（各類資料成功／失敗筆數與去識別化錯誤原因）
// ---------------------------------------------------------------------------

export const FUBON_SYNC_CATEGORIES = {
  twdDeposits: "台幣存款",
  foreignDeposits: "外幣存款",
  twdTransactions: "台幣交易明細",
  cardStatus: "信用卡額度與繳款",
  cardBills: "信用卡帳單",
  cardTransactions: "信用卡明細",
  cardUnbilled: "信用卡未出帳",
} as const;

export type FubonSyncCategory = keyof typeof FUBON_SYNC_CATEGORIES;

export type FubonSyncFailure = {
  category: FubonSyncCategory;
  /** 固定的階段代碼，例如 `fetch`、`parse`、`row`。 */
  stage: string;
  errorClass: string;
  /** 去識別化的錯誤訊息（帳號／卡號遮罩為末四碼、網址去除 query）。 */
  message: string;
};

const MAX_REPORTED_FAILURES = 12;

/** 錯誤類別與訊息去識別化：不含帳號、卡號、身分證字號或網址參數。 */
export function describeFubonError(error: unknown) {
  const name =
    error instanceof Error
      ? error.name || error.constructor?.name || "Error"
      : typeof error;
  const errorClass = /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(name) ? name : "Error";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = maskFubonText(
    raw
      .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
        try {
          const parsed = new URL(url);
          return `${parsed.host}${parsed.pathname}`;
        } catch {
          return "[url]";
        }
      })
      .replace(/\b[A-Z][12]\d{8}\b/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/\d{6,}/g, "[redacted]")
    .slice(0, 160);
  return { errorClass, message };
}

/** 同步過程逐類累計成功／失敗筆數；失敗只記錄去識別化原因。 */
export class FubonSyncReport {
  readonly counts: Record<
    FubonSyncCategory,
    { ok: number; failed: number; rowsRejected: number }
  >;
  readonly failures: FubonSyncFailure[] = [];
  /** 同一次同步內重複出現（例如分段期間重疊）而合併的交易筆數。 */
  readonly duplicatesRemoved = { twdTransactions: 0, cardTransactions: 0 };
  private failureTotal = 0;

  constructor() {
    this.counts = Object.fromEntries(
      Object.keys(FUBON_SYNC_CATEGORIES).map((key) => [
        key,
        { ok: 0, failed: 0, rowsRejected: 0 },
      ]),
    ) as FubonSyncReport["counts"];
  }

  ok(category: FubonSyncCategory, count = 1) {
    this.counts[category].ok += count;
  }

  fail(category: FubonSyncCategory, stage: string, error: unknown, count = 1) {
    this.counts[category].failed += count;
    this.failureTotal += count;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({ category, stage, ...describeFubonError(error) });
    }
  }

  /** 單一資料列格式不符而略過（帳戶／帳單本身仍保留）。 */
  duplicates(
    category: keyof FubonSyncReport["duplicatesRemoved"],
    count: number,
  ) {
    this.duplicatesRemoved[category] += count;
  }

  rejectRow(category: FubonSyncCategory, error: unknown) {
    this.counts[category].rowsRejected += 1;
    this.failureTotal += 1;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({
        category,
        stage: "row",
        ...describeFubonError(error),
      });
    }
  }

  get failedCount() {
    return this.failureTotal;
  }

  /** `fubon_sync_summary` 記錄內容；只含筆數與去識別化原因。 */
  summary() {
    return {
      status: this.failureTotal > 0 ? "partial" : "complete",
      categories: this.counts,
      failureCount: this.failureTotal,
      failures: this.failures,
      failuresTruncated: this.failureTotal > this.failures.length,
      duplicatesRemoved: { ...this.duplicatesRemoved },
    };
  }

  /** 給使用者看的部分失敗說明（不含帳號或金額）；沒有失敗時為 undefined。 */
  userMessage() {
    const failed = (Object.keys(this.counts) as FubonSyncCategory[])
      .filter(
        (key) => this.counts[key].failed + this.counts[key].rowsRejected > 0,
      )
      .map(
        (key) =>
          `${FUBON_SYNC_CATEGORIES[key]} ${this.counts[key].failed + this.counts[key].rowsRejected} 筆`,
      );
    return failed.length > 0
      ? `部分資料未能取得，已略過：${failed.join("、")}。`
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// 登入回應（/B2C/B2CLoginServlet action=login）
// ---------------------------------------------------------------------------

export type FubonLoginOutcome =
  | { kind: "success" }
  | { kind: "captcha"; code: string }
  | { kind: "credential"; code: string }
  | { kind: "locked"; code: string }
  | { kind: "duplicate"; code: string }
  | { kind: "two_factor"; code: string; channel: "otp" | "device" }
  | { kind: "session_timeout"; code: string }
  | { kind: "unknown"; code: string };

/**
 * 依官方登入頁 `doLogin()` 的 success handler 分類登入回應：
 * `result=true` 成功；`0290` 圖形驗證碼錯誤；`EP32`/`EP40` 帳號或代碼錯誤；
 * `0212` 重複登入；`0213` 登入次數限制；`0240` 頁面閒置；`0241` 雙重驗證
 * （`otp=Y` 走簡訊／Email OTP，其餘走 Fubon+ App 推播）。
 */
export function classifyFubonLoginResponse(body: unknown): FubonLoginOutcome {
  if (!isRecord(body)) return { kind: "unknown", code: "invalid_response" };
  if (body.result === true) return { kind: "success" };
  const code = typeof body.errorCode === "string" ? body.errorCode.trim() : "";
  const safeCode = /^[A-Z0-9]{1,8}$/i.test(code) ? code : "unknown";
  if (code === "0290") return { kind: "captcha", code };
  if (code === "EP32" || code === "EP40") return { kind: "credential", code };
  if (code === "EP34X" || code === "WP34X" || code === "WP39X")
    return { kind: "locked", code };
  if (code === "0213") return { kind: "locked", code };
  if (code === "0212") return { kind: "duplicate", code };
  if (code === "0240") return { kind: "session_timeout", code };
  if (code === "0241")
    return {
      kind: "two_factor",
      code,
      channel: body.otp === "Y" ? "otp" : "device",
    };
  const description = typeof body.errorDesc === "string" ? body.errorDesc : "";
  if (/密碼.*(錯誤|不符)|代碼.*錯誤|身分證.*錯誤/.test(description))
    return { kind: "credential", code: safeCode };
  if (/鎖定|停用|暫停使用|暫時無法登入/.test(description))
    return { kind: "locked", code: safeCode };
  return { kind: "unknown", code: safeCode };
}

// ---------------------------------------------------------------------------
// HTML helpers（JSF 頁面；不依賴 DOM）
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

export function fubonCellText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|#160);/g, (match) => {
      return ENTITY_MAP[match] ?? match;
    })
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 全形數字轉半形（帳單卡片列「末４碼」使用全形數字）。 */
export function toHalfWidthDigits(value: string) {
  return value.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
}

/** 取得 innermost `<tr>` 的儲存格文字；巢狀表格的外層列不會被當成資料列。 */
const ROW_PATTERN = /<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi;
const CELL_PATTERN = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;

// 同一頁會以多個欄位標題反覆查表；保留最近一次的解析結果，避免重複掃描整頁。
let lastRowsHtml: string | undefined;
let lastRows: string[][] = [];

function innermostRows(html: string): string[][] {
  if (html === lastRowsHtml) return lastRows;
  const rows: string[][] = [];
  for (const match of html.matchAll(ROW_PATTERN)) {
    const cells: string[] = [];
    for (const cell of (match[1] ?? "").matchAll(CELL_PATTERN)) {
      cells.push(fubonCellText(cell[1] ?? ""));
    }
    rows.push(cells);
  }
  lastRowsHtml = html;
  lastRows = rows;
  return rows;
}

function tableById(html: string, id: string): string | undefined {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return undefined;
  const tableStart = html.lastIndexOf("<table", start);
  const tableEnd = html.indexOf("</table>", start);
  if (tableStart < 0 || tableEnd < 0) return undefined;
  return html.slice(tableStart, tableEnd + "</table>".length);
}

/** 以表頭文字找到所在的最內層表格。 */
function tableContaining(html: string, marker: RegExp): string | undefined {
  const match = marker.exec(html);
  if (!match) return undefined;
  const tableStart = html.lastIndexOf("<table", match.index);
  const tableEnd = html.indexOf("</table>", match.index);
  if (tableStart < 0 || tableEnd < 0) return undefined;
  return html.slice(tableStart, tableEnd + "</table>".length);
}

/** 表頭列下一列為值的 key-value 表格（JSF card_detail 版面）。 */
function headerValues(
  html: string,
  firstHeader: RegExp,
): Map<string, string> | undefined {
  const rows = innermostRows(html);
  const index = rows.findIndex((row) => firstHeader.test(row[0] ?? ""));
  if (index < 0) return undefined;
  const headers = rows[index] ?? [];
  const values = rows[index + 1] ?? [];
  const result = new Map<string, string>();
  headers.forEach((header, column) => {
    if (header) result.set(header, values[column] ?? "");
  });
  return result;
}

function valueByPrefix(map: Map<string, string>, prefix: string) {
  for (const [key, value] of map) {
    if (key.startsWith(prefix)) return value;
  }
  return undefined;
}

/** 第一欄為標題、第二欄為值的表格列。 */
function labeledValue(html: string, label: string): string | undefined {
  for (const row of innermostRows(html)) {
    if ((row[0] ?? "") === label) return row[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 數字與日期（每個值獨立驗證；格式不符回傳 undefined，由呼叫端決定略過該筆）
// ---------------------------------------------------------------------------

/** 銀行以 `-`、`--`、全形 `－` 等表示「無資料」的儲存格。 */
const BLANK_CELL = /^(?:|[-－—–]{1,2}|N\/?A|無)$/i;
const FULL_WIDTH_NUMERIC = /[０-９，．－＋（）]/g;
const FULL_WIDTH_NUMERIC_MAP: Record<string, string> = {
  "，": ",",
  "．": ".",
  "－": "-",
  "＋": "+",
  "（": "(",
  "）": ")",
};
const AMOUNT_DECORATION =
  /^(?:NT\$|NTD|TWD|US\$|\$|[A-Z]{3}\s)|(?:元|\s[A-Z]{3})$/gi;
const AMOUNT_PATTERN = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** 單筆金額的合理上限（避免把帳號等長數字誤當金額）。 */
const MAX_AMOUNT = 1e12;

/** 儲存格是否為空白或「無資料」佔位符。 */
export function isFubonBlankCell(value: string | undefined) {
  return BLANK_CELL.test((value ?? "").replace(/[\s\u00a0\u3000]/g, ""));
}

function normalizeNumericText(value: string) {
  return value
    .replace(/[０-９]/g, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    )
    .replace(FULL_WIDTH_NUMERIC, (char) => FULL_WIDTH_NUMERIC_MAP[char] ?? char)
    .replace(/[\u00a0\u3000]/g, " ")
    .trim();
}

/**
 * 金額：千分位逗號、小數、前置正負號、括號負數 `(1,234)`、後置負號 `1,234-`、
 * 全形數字與符號、`NT$`／`元`／幣別代碼等前後綴。空白或 `-` 佔位符、千分位錯置、
 * 非數字與超出合理範圍的值回傳 undefined（不產生 NaN）。
 */
export function parseFubonAmount(
  value: string | undefined,
): number | undefined {
  if (value === undefined || isFubonBlankCell(value)) return undefined;
  let text = normalizeNumericText(value).replace(AMOUNT_DECORATION, "").trim();
  let negative = false;
  const parenthesized = text.match(/^\((.*)\)$/);
  if (parenthesized) {
    negative = true;
    text = (parenthesized[1] ?? "").trim();
  } else if (/^[\d,.]+-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  text = text.replace(/\s+/g, "");
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

function westernYear(raw: string) {
  const year = Number(raw);
  // 2～3 位數為民國年；4 位數為西元年。
  return raw.length <= 3 ? year + 1911 : year;
}

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

const DATE_PATTERN =
  /^(?:民國\s*)?(\d{2,4})\s*(?:[/.-]|年)\s*(\d{1,2})\s*(?:[/.-]|月)\s*(\d{1,2})\s*日?$/;

/**
 * `2026/09/26`（西元）、`115/09/26`、`115.09.26` 或 `民國115年9月26日`（民國）轉為
 * `YYYY-MM-DD`。不存在的日期（如 2 月 30 日）與 1990～2100 年以外的值回傳 undefined。
 */
export function parseFubonDate(value: string | undefined): string | undefined {
  if (value === undefined || isFubonBlankCell(value)) return undefined;
  const match = normalizeNumericText(value).match(DATE_PATTERN);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  if (raw.length === 4 && Number(raw) < 1911) return undefined;
  return isoDate(westernYear(raw), Number(match[2]), Number(match[3]));
}

/** `115/09`、`2026/09` 或 `115年09月` 轉為 `YYYY-MM`。 */
export function parseFubonMonth(value: string | undefined): string | undefined {
  if (value === undefined || isFubonBlankCell(value)) return undefined;
  const match = normalizeNumericText(value).match(
    /^(?:民國\s*)?(\d{2,4})\s*(?:[/.-]|年)\s*(\d{1,2})\s*月?$/,
  );
  if (!match) return undefined;
  const raw = match[1] ?? "";
  if (raw.length === 4 && Number(raw) < 1911) return undefined;
  return isoDate(westernYear(raw), Number(match[2]), 1)?.slice(0, 7);
}

const TIMESTAMP_PATTERN = /^(.+?)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `2026/08/10 16:26:59`（或民國年日期）→ `2026-08-10T16:26:59+08:00`。
 * 銀行顯示台灣時間，未標時區一律以 +08:00 保存；只有日期或時間超出範圍時回傳 undefined。
 */
export function parseFubonTimestamp(value: string | undefined) {
  if (value === undefined || isFubonBlankCell(value)) return undefined;
  const match = normalizeNumericText(value).match(TIMESTAMP_PATTERN);
  if (!match) return undefined;
  const date = parseFubonDate(match[1]);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  if (!date || hour > 23 || minute > 59 || second > 59) return undefined;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`;
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
export function fubonCurrency(value: string): string | undefined {
  const trimmed = value.replace(/[\s\u00a0\u3000]/g, "");
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return (
    CURRENCY_NAMES[trimmed] ?? CURRENCY_NAMES[trimmed.replace(/\(.*\)$/, "")]
  );
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

/** 比對帳號時去除網銀前置補零（總覽 14 碼、明細選單 16 碼）。 */
export function normalizeFubonAccountNo(value: string) {
  return digitsOnly(value).replace(/^0+/, "");
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
export function maskFubonText(value: string) {
  return value
    .replace(/\b[A-Z][12]\d{8}\b/g, "**********")
    .replace(/\d[\d*-]{6,}\d/g, (match) => {
      const digits = digitsOnly(match);
      return digits.length >= 6 ? `****${digits.slice(-4)}` : match;
    });
}

// ---------------------------------------------------------------------------
// 存款總覽 CBOQU003
// ---------------------------------------------------------------------------

export type FubonDepositAccount = {
  accountNo: string;
  sourceId: string;
  typeName: string;
  currency: string;
  balance: number;
  availableBalance?: number;
};

export function fubonDepositSourceId(accountNo: string, currency: string) {
  const normalized = normalizeFubonAccountNo(accountNo);
  return `bank:fubon:${normalized.slice(-4)}:${stableHash(`fubon:${normalized}`)}:${currency}`;
}

export type FubonRejectedDepositRow = {
  /** 依幣別欄判斷；幣別無法辨識時依文字是否為臺幣歸類。 */
  foreign: boolean;
  reason: string;
};

export function parseFubonDepositOverview(html: string): {
  accounts: FubonDepositAccount[];
  skippedTypes: string[];
  rejected: FubonRejectedDepositRow[];
} {
  const table = tableById(html, "form1:resultGrid_DataGridBody");
  if (!table) {
    throw new FubonProtocolError("台北富邦存款總覽頁面格式無法辨識。");
  }
  const rows = innermostRows(table);
  const header = rows[0] ?? [];
  if (header[0] !== "帳號" || !header.includes("即時餘額")) {
    throw new FubonProtocolError("台北富邦存款總覽欄位已變更。");
  }
  const column = (name: string) => header.indexOf(name);
  const typeIndex = column("存款類別");
  const currencyIndex = column("幣別");
  const balanceIndex = column("即時餘額");
  const availableIndex = column("可用餘額");
  if (typeIndex < 0 || currencyIndex < 0 || availableIndex < 0) {
    throw new FubonProtocolError("台北富邦存款總覽欄位已變更。");
  }
  const accounts: FubonDepositAccount[] = [];
  const skippedTypes: string[] = [];
  const rejected: FubonRejectedDepositRow[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const accountNo = digitsOnly(row[0] ?? "");
    if (accountNo.length < 10) continue;
    const typeName = row[typeIndex] ?? "";
    // 本 connector 只同步活期性存款；定存、支存等其他類別略過但記錄類別名稱。
    if (!/活/.test(typeName) || /定/.test(typeName)) {
      skippedTypes.push(typeName || "unknown");
      continue;
    }
    const currencyText = row[currencyIndex] ?? "";
    const currency = fubonCurrency(currencyText);
    const balance = parseFubonAmount(row[balanceIndex]);
    if (!currency || balance === undefined) {
      rejected.push({
        foreign: currency
          ? currency !== "TWD"
          : !/[臺台]幣|TWD/.test(currencyText),
        reason: !currency
          ? "台北富邦存款總覽的幣別無法辨識。"
          : "台北富邦存款總覽的即時餘額無法解析。",
      });
      continue;
    }
    const availableText = row[availableIndex];
    const availableBalance = parseFubonAmount(availableText);
    const sourceId = fubonDepositSourceId(accountNo, currency);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    accounts.push({
      accountNo,
      sourceId,
      typeName,
      currency,
      balance,
      // 可用餘額為選填；空白、`-` 或格式不符時保持未知，不以 0 代替。
      availableBalance,
    });
  }
  return { accounts, skippedTypes, rejected };
}

// ---------------------------------------------------------------------------
// 臺外幣交易明細 CDSQU001
// ---------------------------------------------------------------------------

export type FubonTransactionAccountOption = {
  /** `form1:comboAccount` 的值，例如 `012-<16 碼帳號>-TWD-31`；只在當次請求使用。 */
  value: string;
  accountNo: string;
  currency: string;
};

/** 解析 `012-<帳號>-<幣別>-<帳戶類型>` 形式的帳號選單值；不符合時回傳 undefined。 */
export function parseFubonComboAccountValue(
  raw: string,
): FubonTransactionAccountOption | undefined {
  const value = decodeHtmlAttribute(raw).trim();
  const parts = value.split("-");
  const accountNo = digitsOnly(parts[1] ?? "");
  const currency = (parts[2] ?? "").trim().toUpperCase();
  if (accountNo.length < 10 || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { value, accountNo, currency };
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const COMBO_SCRIPT_ITEM =
  /\w*comboAccount\w*Items\s*\[[^\]]*\]\s*=\s*new\s+Array\(\s*(["'])(?:\\.|(?!\1)[^\\])*\1\s*,\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/gi;
const COMBO_SELECT =
  /<select\b[^>]*\b(?:id|name)\s*=\s*["'][^"']*comboAccount[^"']*["'][^>]*>([\s\S]*?)<\/select>/gi;
const OPTION_VALUE = /<option\b[^>]*\bvalue\s*=\s*(["'])([^"']*)\1/gi;

/**
 * 交易明細的帳號選單。來源依序為頁面中的 `comboAccountItems[n] = new Array(...)`、
 * `<select id="form1:comboAccount">` 的 `<option>`，以及呼叫端由框架即時讀到的值
 * （例如 `window.comboAccountItems`）。重複的值只保留一次。
 */
export function parseFubonTransactionAccounts(
  html: string,
  extraValues: readonly string[] = [],
): FubonTransactionAccountOption[] {
  const values: string[] = [];
  for (const match of html.matchAll(COMBO_SCRIPT_ITEM)) {
    values.push(match[3] ?? "");
  }
  for (const select of html.matchAll(COMBO_SELECT)) {
    for (const option of (select[1] ?? "").matchAll(OPTION_VALUE)) {
      values.push(option[2] ?? "");
    }
  }
  values.push(...extraValues);
  const options: FubonTransactionAccountOption[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const option = parseFubonComboAccountValue(raw);
    if (!option || seen.has(option.value)) continue;
    seen.add(option.value);
    options.push(option);
  }
  return options;
}

export type FubonTransactionAccountMatch = {
  matched: {
    account: FubonDepositAccount;
    option: FubonTransactionAccountOption;
  }[];
  missing: FubonDepositAccount[];
};

/** 以去除前置補零後的帳號與幣別，將總覽臺幣帳戶對應到交易明細選單。 */
export function matchFubonTransactionAccounts(
  accounts: readonly FubonDepositAccount[],
  options: readonly FubonTransactionAccountOption[],
): FubonTransactionAccountMatch {
  const result: FubonTransactionAccountMatch = { matched: [], missing: [] };
  for (const account of accounts) {
    const option = options.find(
      (candidate) =>
        candidate.currency === account.currency &&
        normalizeFubonAccountNo(candidate.accountNo) ===
          normalizeFubonAccountNo(account.accountNo),
    );
    if (option) result.matched.push({ account, option });
    else result.missing.push(account);
  }
  return result;
}

/** 頁面中是否含帳號選單的腳本或 select（不含任何帳號）。 */
export function describeFubonTransactionAccountsHtml(html: string) {
  const selects = [...html.matchAll(COMBO_SELECT)];
  return {
    hasComboScript: /comboAccount\w*Items\s*\[/i.test(html),
    hasComboSelect:
      selects.length > 0 || /<select\b[^>]*comboAccount/i.test(html),
    selectOptionCount: selects.reduce(
      (sum, select) =>
        sum + [...(select[1] ?? "").matchAll(OPTION_VALUE)].length,
      0,
    ),
  };
}

/** 帳號選單值的形狀（數字以 N<位數> 取代），供診斷記錄使用，不含帳號。 */
export function fubonComboValueShape(value: string) {
  return value.replace(/\d+/g, (digits) => `N${digits.length}`).slice(0, 40);
}

export type FubonDepositTransactionRow = {
  bookingDate: string;
  transactedAt?: string;
  summary: string;
  amount: number;
  balanceAfter?: number;
  memo: string;
};

export type FubonDepositTransactionPage = {
  rows: FubonDepositTransactionRow[];
  /** 格式不符而略過的資料列原因（不含帳號或金額）。 */
  rejected: string[];
  /** 頁面回傳的每頁筆數；資料列達此筆數時可能被截斷，需分割期間重查。 */
  pageSize?: number;
  selectedAccount?: string;
  startDate?: string;
  endDate?: string;
};

export function parseFubonDepositTransactionsPage(
  html: string,
): FubonDepositTransactionPage {
  const pageSize = Number(
    html.match(
      /name="resultGrid:dataGridCurrentPageSize"\s+value="(\d+)"/,
    )?.[1] ?? Number.NaN,
  );
  const selectedAccount = html.match(
    /setupComboBox\("form1:comboAccount",\s*"[^"]*",\s*"([^"]*)"/,
  )?.[1];
  const startDate = html.match(
    /name="form1:startDate"[^>]*value="([^"]*)"/,
  )?.[1];
  const endDate = html.match(/name="form1:endDate"[^>]*value="([^"]*)"/)?.[1];
  const table = tableById(html, "form1:resultGrid_DataGridBody");
  const meta = {
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
    selectedAccount,
    startDate,
    endDate,
  };
  if (!table) {
    // 查無交易時的實際頁面尚未擷取；只接受明確「查無」提示，其餘未知頁面一律失敗。
    if (/查無(?:任何)?(?:交易)?(?:資料|明細|紀錄)/.test(fubonCellText(html))) {
      return { rows: [], rejected: [], ...meta };
    }
    throw new FubonProtocolError("台北富邦交易明細頁面格式無法辨識。");
  }
  const rows = innermostRows(table);
  const header = rows[0] ?? [];
  const expected = ["帳務日期", "交易時間", "摘要", "支出金額", "存入金額"];
  if (expected.some((name, index) => header[index] !== name)) {
    throw new FubonProtocolError("台北富邦交易明細欄位已變更。");
  }
  const parsed: FubonDepositTransactionRow[] = [];
  const rejected: string[] = [];
  for (const row of rows.slice(1)) {
    if (row.length < 6) continue;
    if (!row[0] && /查無/.test(row.join(""))) continue;
    try {
      parsed.push(parseFubonDepositTransactionRow(row));
    } catch (error) {
      if (!(error instanceof FubonRowRejectedError)) throw error;
      rejected.push(error.message);
    }
  }
  return { rows: parsed, rejected, ...meta };
}

/**
 * 單列驗證：帳務日期必須是有效日期；支出／存入恰有一欄有非零金額（另一欄空白或 `-`）；
 * 交易時間、即時餘額有值時必須可解析。不符時拋出 FubonRowRejectedError，只略過該列。
 */
export function parseFubonDepositTransactionRow(
  row: readonly string[],
): FubonDepositTransactionRow {
  const bookingDate = parseFubonDate(row[0]);
  if (!bookingDate) {
    throw new FubonRowRejectedError("台北富邦交易明細日期無法解析。");
  }
  const withdrawalBlank = isFubonBlankCell(row[3]);
  const depositBlank = isFubonBlankCell(row[4]);
  const withdrawal = withdrawalBlank ? 0 : parseFubonAmount(row[3]);
  const deposit = depositBlank ? 0 : parseFubonAmount(row[4]);
  if (withdrawal === undefined || deposit === undefined) {
    throw new FubonRowRejectedError("台北富邦交易明細金額無法解析。");
  }
  if (withdrawalBlank && depositBlank) {
    throw new FubonRowRejectedError("台北富邦交易明細缺少支出或存入金額。");
  }
  if (withdrawal !== 0 && deposit !== 0) {
    throw new FubonRowRejectedError("台北富邦交易明細同時有支出與存入金額。");
  }
  if (withdrawal < 0 || deposit < 0) {
    // 支出／存入欄的方向由欄位決定，欄內出現負數表示格式不符。
    throw new FubonRowRejectedError("台北富邦交易明細金額方向無法判斷。");
  }
  const transactedAt = parseFubonTimestamp(row[1]);
  if (!transactedAt && !isFubonBlankCell(row[1])) {
    throw new FubonRowRejectedError("台北富邦交易明細交易時間無法解析。");
  }
  const balanceAfter = parseFubonAmount(row[5]);
  if (balanceAfter === undefined && !isFubonBlankCell(row[5])) {
    throw new FubonRowRejectedError("台北富邦交易明細即時餘額無法解析。");
  }
  return {
    bookingDate,
    transactedAt,
    summary: row[2] ?? "",
    amount: roundCurrency(deposit - withdrawal),
    balanceAfter,
    memo: (row[6] ?? "").replace(/\s*更多$/, "").trim(),
  };
}

/** 解析成功與格式拒絕的資料列數達到每頁筆數時，頁面可能被截斷。 */
export function isFubonTransactionPageTruncated(
  page: FubonDepositTransactionPage,
) {
  return (
    page.pageSize !== undefined &&
    page.rows.length + page.rejected.length >= page.pageSize
  );
}

// ---------------------------------------------------------------------------
// 信用卡：額度與繳款 CCCQU002、帳單 CCCQU003、未出帳 CCCQU004
// ---------------------------------------------------------------------------

export type FubonCardStatus =
  | { hasCreditCard: false }
  | {
      hasCreditCard: true;
      creditLimit?: number;
      availableCredit?: number;
      statementClosingDate?: string;
      statementAmount: number;
      minimumPayment?: number;
      paymentDueDate?: string;
      paymentStatus: string;
      lastPaymentDate?: string;
      paidAmount?: number;
      remainingAmount: number;
      /** 頁面列有自動扣繳帳號（不保存帳號本身）。 */
      autopay: boolean;
    };

function pageMessages(html: string): string[] {
  const messages: string[] = [];
  const regex =
    /<(div|span|li|td)\b[^>]*(?:class="[^"]*(?:Reminder_message|txt_ct|warning|error_msg|msg)[^"]*"|id="[^"]*(?:message|Message|msg)[^"]*")[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const text = fubonCellText(match[2] ?? "");
    if (text) messages.push(text);
  }
  const alerts = /alert\(\s*['"]([^'"]{2,120})['"]\s*\)/g;
  while ((match = alerts.exec(html)) !== null) messages.push(match[1] ?? "");
  return messages;
}

/** 只有明確的無卡提示才視為沒有信用卡；其他未知頁面一律失敗。 */
export function parseFubonCardStatus(html: string): FubonCardStatus {
  const bill = headerValues(html, /^本期帳單結帳日/);
  const payment = headerValues(html, /^繳款狀態$/);
  if (!bill || !payment) {
    if (pageMessages(html).some((message) => isNoCreditCardMessage(message))) {
      return { hasCreditCard: false };
    }
    throw new FubonProtocolError("台北富邦信用卡繳款頁面格式無法辨識。");
  }
  const statementAmount = parseFubonAmount(valueByPrefix(bill, "應繳總金額"));
  const remainingAmount = parseFubonAmount(
    valueByPrefix(payment, "本期帳單剩餘應繳金額"),
  );
  const paymentStatus = valueByPrefix(payment, "繳款狀態") ?? "";
  if (
    statementAmount === undefined ||
    remainingAmount === undefined ||
    !paymentStatus
  ) {
    throw new FubonProtocolError("台北富邦信用卡應繳金額或繳款狀態無法解析。");
  }
  return {
    hasCreditCard: true,
    creditLimit: parseFubonAmount(labeledValue(html, "正卡人信用額度")),
    availableCredit: parseFubonAmount(labeledValue(html, "正卡人可用額度")),
    statementClosingDate: parseFubonDate(valueByPrefix(bill, "本期帳單結帳日")),
    statementAmount,
    minimumPayment: parseFubonAmount(valueByPrefix(bill, "最低應繳金額")),
    paymentDueDate: parseFubonDate(valueByPrefix(bill, "繳款截止日")),
    paymentStatus,
    lastPaymentDate: parseFubonDate(valueByPrefix(payment, "最近繳款日期")),
    paidAmount: parseFubonAmount(valueByPrefix(payment, "已繳金額")),
    remainingAmount,
    autopay: hasAutopayAccount(valueByPrefix(payment, "自動扣繳帳號")),
  };
}

function hasAutopayAccount(value: string | undefined) {
  if (value === undefined || isFubonBlankCell(value)) return false;
  if (/未(?:約定|設定|申請)|無/.test(value)) return false;
  return /\d/.test(value);
}

/**
 * 帳單繳款狀態。對應 repo 的帳單模型（`isPaid`：true＝已繳／無需繳款、false＝待繳、
 * undefined＝未知），細分狀態保存在 raw.paymentState 供診斷與顯示：
 * - `paid`：已繳清（狀態文字明確已繳，或剩餘應繳 ≤ 0，或已繳金額 ≥ 應繳總額）。
 * - `payment_processing`：狀態仍為「未繳款」但已繳金額 ≥ 應繳總額（自動扣繳當日，
 *   剩餘應繳尚未更新；2026-10 實測隔日即轉為「已繳款」、剩餘 0）。視為已繳。
 * - `no_payment_needed`：本期應繳 0（無帳單或無應繳金額）。
 * - `credit_balance`：本期應繳為負（溢繳／退款形成的負餘額）。
 * - `autopay_pending`：已約定自動扣繳、尚未扣款且未過繳款截止日。仍為待繳。
 * - `unpaid`：未繳且未過繳款截止日。
 * - `partial`：已繳部分金額但未繳清；`below_minimum`：已繳未達最低應繳。
 * - `overdue`：過了繳款截止日仍有剩餘應繳（台灣日期比較）。
 * - `unknown`：缺少足以判斷的金額。
 */
export type FubonPaymentState =
  | "paid"
  | "payment_processing"
  | "no_payment_needed"
  | "credit_balance"
  | "autopay_pending"
  | "unpaid"
  | "partial"
  | "below_minimum"
  | "overdue"
  | "unknown";

export type FubonPaymentInput = {
  statementAmount: number;
  minimumPayment?: number;
  paidAmount?: number;
  remainingAmount?: number;
  paymentStatus?: string;
  paymentDueDate?: string;
  autopay?: boolean;
};

const PAID_STATES = new Set<FubonPaymentState>([
  "paid",
  "payment_processing",
  "no_payment_needed",
  "credit_balance",
]);
const UNPAID_STATES = new Set<FubonPaymentState>([
  "autopay_pending",
  "unpaid",
  "partial",
  "below_minimum",
  "overdue",
]);

export function fubonPaymentStateToIsPaid(
  state: FubonPaymentState,
): boolean | undefined {
  if (PAID_STATES.has(state)) return true;
  if (UNPAID_STATES.has(state)) return false;
  return undefined;
}

/** 依狀態文字、應繳／已繳／剩餘金額與繳款截止日（台灣日期）推得繳款狀態。 */
export function deriveFubonPaymentState(
  input: FubonPaymentInput,
  now = new Date(),
): FubonPaymentState {
  const text = (input.paymentStatus ?? "").replace(/\s+/g, "");
  const statement = input.statementAmount;
  const paid = input.paidAmount;
  const remaining =
    input.remainingAmount ??
    (paid !== undefined ? roundCurrency(statement - paid) : undefined);
  if (statement < 0 || /溢繳/.test(text)) return "credit_balance";
  if (statement === 0 || /無應繳|免繳|不需繳|無需繳/.test(text))
    return "no_payment_needed";
  if (/已繳(?:款|清|足)|繳清|已全額/.test(text)) return "paid";
  if (remaining !== undefined && remaining <= 0) return "paid";
  if (paid !== undefined && paid >= statement)
    return /未繳/.test(text) ? "payment_processing" : "paid";
  if (remaining === undefined) return "unknown";
  const today = taipeiDate(now);
  const overdue =
    /逾期|延滯|遲繳/.test(text) ||
    (input.paymentDueDate !== undefined && today > input.paymentDueDate);
  if (overdue) return "overdue";
  if (paid !== undefined && paid > 0) {
    if (input.minimumPayment !== undefined && paid < input.minimumPayment)
      return "below_minimum";
    return "partial";
  }
  if (/部分繳|未繳足/.test(text)) return "partial";
  if (input.autopay) return "autopay_pending";
  return "unpaid";
}

/** 相容舊名稱：依繳款頁狀態判定本期帳單是否已繳。 */
export function fubonBillPaidState(
  status: Extract<FubonCardStatus, { hasCreditCard: true }>,
  now = new Date(),
): boolean | undefined {
  return fubonPaymentStateToIsPaid(deriveFubonPaymentState(status, now));
}

/**
 * 較早期別沒有繳款頁：以下一期帳單的「前期應繳總額」與「繳(退)金額」推得。
 * 只有下一期的前期應繳總額等於本期應繳總額時才採用；繳(退)金額含退款，
 * 退款同樣抵減應繳，因此視為已繳的一部分。
 */
export function deriveFubonPreviousBillPayment(
  bill: Pick<
    FubonBill,
    "statementAmount" | "minimumPayment" | "paymentDueDate"
  >,
  next: Pick<FubonBill, "previousBalance" | "paymentsAndRefunds"> | undefined,
  now = new Date(),
): { state: FubonPaymentState; paidAmount?: number } {
  if (bill.statementAmount <= 0) {
    return {
      state: deriveFubonPaymentState({ statementAmount: bill.statementAmount }),
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
    state: deriveFubonPaymentState(
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

export type FubonCardTransaction = {
  cardLast4?: string;
  transactionDate: string;
  postedDate?: string;
  description: string;
  /** 銀行顯示的臺幣金額：正數為消費，負數為繳款／退款。 */
  bankAmount: number;
  foreignCurrency?: string;
  foreignAmount?: number;
};

export type FubonBill = {
  period: string;
  statementClosingDate?: string;
  paymentDueDate?: string;
  creditLimit?: number;
  previousBalance?: number;
  paymentsAndRefunds?: number;
  adjustments?: number;
  newCharges?: number;
  statementAmount: number;
  minimumPayment?: number;
  transactions: FubonCardTransaction[];
  /** 格式不符而略過的明細列原因。 */
  rejected: string[];
};

function cardHeaderLast4(text: string): string | undefined {
  const normalized = toHalfWidthDigits(text);
  return (
    normalized.match(/末\s*[4四]\s*碼\s*(\d{4})/)?.[1] ??
    normalized.match(/^\d{4,6}[*＊]{4,}(\d{4})$/)?.[1]
  );
}

export function parseFubonBill(html: string): FubonBill | undefined {
  const summary = headerValues(html, /^帳單年月$/);
  if (!summary) {
    // 無帳單期別的實際提示尚未擷取；只接受明確提示，其餘未知頁面一律失敗。
    if (/查無|無帳單|尚無帳單/.test(fubonCellText(html))) return undefined;
    throw new FubonProtocolError("台北富邦信用卡帳單頁面格式無法辨識。");
  }
  const period = parseFubonMonth(summary.get("帳單年月"));
  const amounts = headerValues(html, /^前期應繳總額$/);
  const statementAmount = parseFubonAmount(
    amounts && valueByPrefix(amounts, "本期應繳總額"),
  );
  if (!period || !amounts || statementAmount === undefined) {
    throw new FubonProtocolError("台北富邦信用卡帳單期別或應繳金額無法解析。");
  }
  const detail = tableContaining(html, />\s*消費日期\s*</);
  const transactions: FubonCardTransaction[] = [];
  const rejected: string[] = [];
  if (detail) {
    let currentCard: string | undefined;
    const rows = innermostRows(detail);
    for (const row of rows.slice(1)) {
      if (row.length < 6) continue;
      const header = cardHeaderLast4(row[1] ?? "");
      if (!row[0] && header) {
        currentCard = header;
        continue;
      }
      // 前期／本期應繳總額等摘要列沒有消費日期。
      if (isFubonBlankCell(row[0])) continue;
      const transactionDate = parseFubonDate(row[0]);
      const bankAmount = parseFubonAmount(row[5]);
      if (!transactionDate || bankAmount === undefined) {
        rejected.push(
          !transactionDate
            ? "台北富邦信用卡帳單明細消費日期無法解析。"
            : "台北富邦信用卡帳單明細金額無法解析。",
        );
        continue;
      }
      const foreign = row[3]?.match(/\b([A-Z]{3})\b/)?.[1];
      transactions.push({
        cardLast4: currentCard,
        transactionDate,
        postedDate: parseFubonDate(row[2]),
        description: row[1] ?? "",
        bankAmount,
        foreignCurrency: foreign && foreign !== "TWD" ? foreign : undefined,
        foreignAmount:
          foreign && foreign !== "TWD" ? parseFubonAmount(row[4]) : undefined,
      });
    }
  }
  return {
    period,
    statementClosingDate: parseFubonDate(summary.get("帳單結帳日")),
    paymentDueDate: parseFubonDate(summary.get("繳款截止日")),
    creditLimit: parseFubonAmount(summary.get("信用額度")),
    previousBalance: parseFubonAmount(amounts.get("前期應繳總額")),
    paymentsAndRefunds: parseFubonAmount(amounts.get("繳(退)金額")),
    adjustments: parseFubonAmount(amounts.get("本期調整金額")),
    newCharges: parseFubonAmount(amounts.get("本期新增")),
    statementAmount,
    minimumPayment: parseFubonAmount(amounts.get("最低應繳金額")),
    transactions,
    rejected,
  };
}

/** 帳單頁目前顯示的期別（hidden `form1:period`，1 = 本期）。 */
export function fubonBillPeriodIndex(html: string): string | undefined {
  return html.match(/name="form1:period"\s+value="(\d+)"/)?.[1];
}

export type FubonUnbilled = {
  expectedClosingDate?: string;
  total: number;
  transactions: FubonCardTransaction[];
  rejected: string[];
};

export function parseFubonUnbilled(html: string): FubonUnbilled {
  const totalText = labeledValue(html, "臺幣加總金額");
  const detail = tableContaining(html, />\s*消費卡號後四碼\s*</);
  if (totalText === undefined && !detail) {
    // 無未出帳消費時的實際提示尚未擷取；只接受明確提示，其餘未知頁面一律失敗。
    if (/查無|無未出帳/.test(fubonCellText(html))) {
      return { total: 0, transactions: [], rejected: [] };
    }
    throw new FubonProtocolError("台北富邦未出帳消費頁面格式無法辨識。");
  }
  const total = parseFubonAmount(totalText);
  if (total === undefined) {
    throw new FubonProtocolError("台北富邦未出帳臺幣加總金額無法解析。");
  }
  const transactions: FubonCardTransaction[] = [];
  const rejected: string[] = [];
  if (detail) {
    let currentCard: string | undefined;
    for (const row of innermostRows(detail).slice(1)) {
      if (row.length < 7) continue;
      const header = cardHeaderLast4(row[1] ?? "");
      if (!row[0] && header) {
        currentCard = header;
        continue;
      }
      if (isFubonBlankCell(row[0])) continue; // 臺幣加總金額等摘要列
      const transactionDate = parseFubonDate(row[0]);
      if (!transactionDate) {
        if (/加總|合計|小計/.test(row.join(""))) continue;
        rejected.push("台北富邦未出帳消費日期無法解析。");
        continue;
      }
      const bankAmount = parseFubonAmount(row[6]);
      if (bankAmount === undefined) {
        rejected.push("台北富邦未出帳消費金額無法解析。");
        continue;
      }
      const rowCard = toHalfWidthDigits(row[3] ?? "").match(/^\d{4}$/)?.[0];
      const foreign = row[4]?.match(/^[A-Z]{3}$/)?.[0];
      transactions.push({
        cardLast4: rowCard ?? currentCard,
        transactionDate,
        postedDate: parseFubonDate(row[2]),
        description: row[1] ?? "",
        bankAmount,
        foreignCurrency: foreign && foreign !== "TWD" ? foreign : undefined,
        foreignAmount:
          foreign && foreign !== "TWD" ? parseFubonAmount(row[5]) : undefined,
      });
    }
  }
  return {
    expectedClosingDate: parseFubonDate(
      labeledValue(html, "預計結帳日") ?? undefined,
    ),
    total,
    transactions,
    rejected,
  };
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

export type FubonPayloads = {
  /** 存款總覽頁；擷取失敗時為 undefined（失敗已記入同步彙整）。 */
  depositOverviewHtml?: string;
  depositTransactions: Array<{
    accountNo: string;
    currency: string;
    pages: string[];
  }>;
  card?:
    | { hasCreditCard: false }
    | {
        hasCreditCard: true;
        /** 額度與繳款頁；擷取或解析失敗時為 undefined。 */
        statusHtml?: string;
        /** 成功擷取的帳單期別頁（失敗的期別已略過）。 */
        billHtmls: string[];
        /** 未出帳頁；擷取失敗時為 undefined。 */
        unbilledHtml?: string;
      };
};

export type FubonData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
  hasCreditCard?: boolean;
};

function taipeiDate(now: Date) {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 正規化。任一帳戶、交易明細、帳單期別或明細列無法解析時只略過該項並記入
 * `report`，其餘資料照常回傳；頁面整體格式錯誤只影響該頁對應的資料類別。
 */
export function parseFubonData(
  payloads: FubonPayloads,
  now = new Date(),
  report = new FubonSyncReport(),
): FubonData {
  const asOfAt = now.toISOString();
  const snapshotDate = taipeiDate(now);
  let accounts: FubonDepositAccount[] = [];
  if (payloads.depositOverviewHtml !== undefined) {
    try {
      const overview = parseFubonDepositOverview(payloads.depositOverviewHtml);
      accounts = overview.accounts;
      for (const row of overview.rejected) {
        report.rejectRow(
          row.foreign ? "foreignDeposits" : "twdDeposits",
          new FubonRowRejectedError(row.reason),
        );
      }
    } catch (error) {
      report.fail("twdDeposits", "parse", error);
      report.fail("foreignDeposits", "parse", error);
    }
  }
  const bankAccounts: FubonData["bankAccounts"] = [];
  const bankBalanceSnapshots: FubonData["bankBalanceSnapshots"] = [];
  const bankTransactions: FubonData["bankTransactions"] = [];
  const creditCardBills: FubonData["creditCardBills"] = [];

  for (const account of accounts) {
    report.ok(account.currency === "TWD" ? "twdDeposits" : "foreignDeposits");
    const last4 = account.accountNo.slice(-4);
    const raw = {
      bankCode: FUBON_BANK_CODE,
      accountLast4: last4,
      accountTypeName: account.typeName || undefined,
      currency: account.currency,
    };
    bankAccounts.push({
      sourceId: account.sourceId,
      institutionName: "台北富邦銀行",
      accountName: `${account.typeName || "活期存款"} 末四碼 ${last4}`,
      accountType: "savings",
      currency: account.currency,
      raw,
    });
    bankBalanceSnapshots.push({
      accountId: account.sourceId,
      sourceId: `snapshot:fubon:${account.sourceId.split(":").slice(2).join(":")}:${snapshotDate}`,
      balance: account.balance,
      availableBalance: account.availableBalance,
      currency: account.currency,
      asOfAt,
      raw: { ...raw, balance: account.balance },
    });
  }

  for (const entry of payloads.depositTransactions) {
    try {
      const sourceId = fubonDepositSourceId(entry.accountNo, entry.currency);
      if (!accounts.some((account) => account.sourceId === sourceId)) {
        throw new FubonProtocolError("台北富邦交易明細帳號不在存款總覽中。");
      }
      const pages = entry.pages.map((html) =>
        parseFubonDepositTransactionsPage(html),
      );
      for (const reason of pages.flatMap((page) => page.rejected)) {
        report.rejectRow("twdTransactions", new FubonRowRejectedError(reason));
      }
      const deposit = depositTransactions(
        sourceId,
        entry.accountNo,
        entry.currency,
        pages.map((page) => page.rows),
      );
      report.duplicates("twdTransactions", deposit.duplicatesRemoved);
      bankTransactions.push(...deposit.records);
      report.ok("twdTransactions");
    } catch (error) {
      report.fail("twdTransactions", "parse", error);
    }
  }

  let hasCreditCard: boolean | undefined;
  if (payloads.card) {
    hasCreditCard = payloads.card.hasCreditCard ? undefined : false;
    if (payloads.card.hasCreditCard) {
      const card = parseCreditCards(
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
 * `fubon_sync_result`：同步結束的一行總結（只含筆數與幣別，不含帳號或金額）。
 * `succeeded`／`failed` 為各資料項成功與失敗（含格式不符而略過的資料列）的合計。
 */
export function summarizeFubonResult(data: FubonData, report: FubonSyncReport) {
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
  );
  const counts = Object.values(report.counts);
  const twdAccounts = deposits.filter(
    (account) => account.currency === "TWD",
  ).length;
  const foreignCurrencies = [
    ...new Set(
      deposits
        .map((account) => account.currency)
        .filter((currency) => currency !== "TWD"),
    ),
  ];
  const foreignAccounts = deposits.length - twdAccounts;
  const postedCard = cardTransactions.filter(
    (txn) => txn.status !== "pending",
  ).length;
  const unbilledCard = cardTransactions.length - postedCard;
  const depositTransactions =
    data.bankTransactions.length - cardTransactions.length;
  const succeeded = counts.reduce((sum, count) => sum + count.ok, 0);
  const failed = report.failedCount;
  const status = failed > 0 ? "partial" : "complete";
  const message =
    `fubon[sync] ${status === "complete" ? "success" : "partial"} - ` +
    `twdAccounts:${twdAccounts}, foreignAccounts:${foreignAccounts}, ` +
    `cards:${creditIds.size}, cardBills:${data.creditCardBills.length}` +
    (failed > 0 ? `, failed:${failed}` : "");
  return {
    message,
    status,
    twdAccounts,
    foreignAccounts,
    foreignCurrencies,
    creditCards: creditIds.size,
    depositTransactions,
    cardBills: data.creditCardBills.length,
    cardTransactions: postedCard,
    cardUnbilled: unbilledCard,
    succeeded,
    failed,
  };
}

/**
 * 存款交易 ID（v2）：`sha256(帳號|幣別|帳務日期|交易時間|金額|即時餘額|摘要)` 前 16 碼加上
 * 同一查詢期間內相同識別的序號。附註不納入（網銀可能截斷或加上「更多」）。
 *
 * - 每個頁面對應一個查詢期間；分段查詢以整日切割，同一日的資料列必在同一頁，
 *   因此序號在不同同步、重疊的三個月期間與分段期間之間皆一致，重新同步會 upsert。
 * - 同一頁內完全相同的合法交易以序號區分，不會被合併。
 * - 不同頁（期間重疊）出現相同 ID 時只保留一筆，並回報移除筆數。
 */
export function depositTransactions(
  accountId: string,
  accountNo: string,
  currency: string,
  pages: FubonDepositTransactionRow[][],
): { records: FubonData["bankTransactions"]; duplicatesRemoved: number } {
  const normalized = normalizeFubonAccountNo(accountNo);
  const records = new Map<string, FubonData["bankTransactions"][number]>();
  let duplicatesRemoved = 0;
  for (const rows of pages) {
    const occurrences = new Map<string, number>();
    for (const row of rows) {
      const identity = fubonDepositTransactionIdentity(
        normalized,
        currency,
        row,
      );
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      const sourceId = `fubon:deposit:tx:v2:${stableHash(identity)}:${occurrence}`;
      if (records.has(sourceId)) {
        duplicatesRemoved += 1;
        continue;
      }
      const memo = maskFubonText(row.memo);
      records.set(sourceId, {
        accountId,
        sourceId,
        postedDate: row.bookingDate,
        authorizedAt: row.transactedAt ?? row.bookingDate,
        amount: row.amount,
        currency,
        description: maskFubonText(row.summary) || memo || "台北富邦交易",
        counterparty: memo || undefined,
        status: "posted" as const,
        raw: {
          summary: maskFubonText(row.summary) || undefined,
          memo: memo || undefined,
          balanceAfter: row.balanceAfter,
        },
      });
    }
  }
  return { records: [...records.values()], duplicatesRemoved };
}

function fubonDepositTransactionIdentity(
  normalizedAccountNo: string,
  currency: string,
  row: FubonDepositTransactionRow,
) {
  return [
    normalizedAccountNo,
    currency,
    row.bookingDate,
    row.transactedAt ?? "",
    row.amount.toFixed(2),
    row.balanceAfter === undefined ? "" : row.balanceAfter.toFixed(2),
    row.summary.replace(/\s+/g, " ").trim(),
  ].join("|");
}

type FubonCardParseResult =
  | { kind: "no_card" }
  | { kind: "unavailable" }
  | {
      kind: "data";
      account: FubonData["bankAccounts"][number];
      snapshot?: FubonData["bankBalanceSnapshots"][number];
      transactions: FubonData["bankTransactions"];
      bills: FubonData["creditCardBills"];
    };

function parseCreditCards(
  payload: Extract<NonNullable<FubonPayloads["card"]>, { hasCreditCard: true }>,
  asOfAt: string,
  snapshotDate: string,
  now: Date,
  report: FubonSyncReport,
): FubonCardParseResult {
  let status: Extract<FubonCardStatus, { hasCreditCard: true }> | undefined;
  if (payload.statusHtml !== undefined) {
    try {
      const parsed = parseFubonCardStatus(payload.statusHtml);
      if (!parsed.hasCreditCard) return { kind: "no_card" };
      status = parsed;
      report.ok("cardStatus");
    } catch (error) {
      report.fail("cardStatus", "parse", error);
    }
  }

  const parsedBills: FubonBill[] = [];
  for (const html of payload.billHtmls) {
    try {
      const bill = parseFubonBill(html);
      if (bill) parsedBills.push(bill);
      report.ok("cardBills");
    } catch (error) {
      report.fail("cardBills", "parse", error);
    }
  }
  const bills = Array.from(
    new Map(parsedBills.map((bill) => [bill.period, bill])).values(),
  )
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, BANK_SYNC_MONTHS);

  let unbilled: FubonUnbilled | undefined;
  if (payload.unbilledHtml !== undefined) {
    try {
      unbilled = parseFubonUnbilled(payload.unbilledHtml);
      report.ok("cardUnbilled");
    } catch (error) {
      report.fail("cardUnbilled", "parse", error);
    }
  }
  if (!status && bills.length === 0 && !unbilled) {
    return { kind: "unavailable" };
  }

  for (const reason of [
    ...bills.flatMap((bill) => bill.rejected),
    ...(unbilled?.rejected ?? []),
  ]) {
    report.rejectRow("cardTransactions", new FubonRowRejectedError(reason));
  }

  const creditBills: FubonData["creditCardBills"] = bills.map((bill, index) => {
    const current =
      status !== undefined &&
      status.statementClosingDate !== undefined &&
      bill.statementClosingDate === status.statementClosingDate;
    const payment = current
      ? {
          state: deriveFubonPaymentState(status!, now),
          paidAmount: status!.paidAmount,
          source: "payment_page" as const,
        }
      : {
          ...deriveFubonPreviousBillPayment(bill, bills[index - 1], now),
          source: "next_statement" as const,
        };
    return {
      accountId: FUBON_CREDIT_ACCOUNT_ID,
      sourceId: `fubon:card:bill:${bill.period}`,
      billingPeriod: bill.period,
      statementAmount: bill.statementAmount,
      minimumPayment: bill.minimumPayment,
      statementClosingDate: bill.statementClosingDate,
      paymentDueDate: bill.paymentDueDate,
      paidAmount: payment.paidAmount,
      isPaid: fubonPaymentStateToIsPaid(payment.state),
      currency: "TWD",
      raw: {
        period: bill.period,
        previousBalance: bill.previousBalance,
        paymentsAndRefunds: bill.paymentsAndRefunds,
        adjustments: bill.adjustments,
        newCharges: bill.newCharges,
        paymentState: payment.state,
        paymentStateSource:
          payment.state === "unknown" ? undefined : payment.source,
        ...(current ? { paymentStatus: status!.paymentStatus } : {}),
      },
    };
  });

  // 帳單（posted）與未出帳（pending）共用序號計數，posted 先分配：同卡同日同金額的
  // 未出帳列不會與已入帳列撞 ID 而被合併；未出帳轉入帳單時沿用相同 ID（upsert）。
  const cardOccurrences = new Map<string, number>();
  const allCardTransactions: FubonData["bankTransactions"] = [
    ...cardTransactions(
      bills.flatMap((bill) => bill.transactions),
      "posted",
      cardOccurrences,
    ),
    ...cardTransactions(
      unbilled?.transactions ?? [],
      "pending",
      cardOccurrences,
    ),
  ];
  const transactions = dedupeBySourceId(allCardTransactions);
  report.duplicates(
    "cardTransactions",
    allCardTransactions.length - transactions.length,
  );
  report.ok("cardTransactions", transactions.length);

  // 負債快照需要繳款頁剩餘應繳與未出帳總額兩者；任一缺少時不建立快照，
  // 避免把未知部分當成 0 而低估負債。
  const snapshot =
    status && unbilled
      ? {
          accountId: FUBON_CREDIT_ACCOUNT_ID,
          sourceId: `snapshot:fubon:credit:${snapshotDate}`,
          balance: creditCardLiabilityBalance(
            status.remainingAmount,
            unbilled.total,
          ),
          statementBalance: status.statementAmount,
          statementClosingDate: status.statementClosingDate,
          paymentDueDate: status.paymentDueDate,
          noPaymentNeeded: status.remainingAmount <= 0,
          currency: "TWD",
          asOfAt,
          raw: {
            remainingAmount: status.remainingAmount,
            unbilledTotal: unbilled.total,
            paidAmount: status.paidAmount,
            paymentStatus: status.paymentStatus,
            paymentState: deriveFubonPaymentState(status, now),
            availableCredit: status.availableCredit,
          },
        }
      : undefined;

  return {
    kind: "data",
    account: {
      sourceId: FUBON_CREDIT_ACCOUNT_ID,
      institutionName: "台北富邦銀行",
      accountName: "台北富邦信用卡",
      accountType: "credit" as const,
      currency: "TWD",
      creditLimit: status?.creditLimit ?? bills[0]?.creditLimit,
    },
    snapshot,
    transactions,
    bills: creditBills,
  };
}

/**
 * 交易 ID：卡片末四碼（繳款列無卡片時為 `account`）、消費日、帶正負號金額與同組序號。
 * 不含店名，未出帳轉入帳單時可沿用相同 ID；未出帳列為 `pending`，帳單列為 `posted`。
 */
function cardTransactions(
  rows: FubonCardTransaction[],
  status: "pending" | "posted",
  occurrences = new Map<string, number>(),
): FubonData["bankTransactions"] {
  return rows.map((row) => {
    const amount = roundCurrency(-row.bankAmount);
    const card = row.cardLast4 ?? "account";
    const identity = `${card}:${row.transactionDate}:${amount}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      accountId: FUBON_CREDIT_ACCOUNT_ID,
      sourceId: `fubon:card:tx:v1:${identity}:${occurrence}`,
      authorizedAt: row.transactionDate,
      postedDate: status === "posted" ? row.postedDate : undefined,
      amount,
      currency: "TWD",
      description: maskFubonText(row.description) || "台北富邦信用卡",
      status,
      cardLast4: row.cardLast4,
      raw: {
        cardLast4: row.cardLast4,
        bankPostedDate: row.postedDate,
        foreignCurrency: row.foreignCurrency,
        foreignAmount: row.foreignAmount,
      },
    };
  });
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

/** 近三個月（含今日）的查詢期間，台灣日期，格式 `YYYY/MM/DD`。 */
export function fubonTransactionRange(now: Date) {
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

export function formatSlashDate(date: Date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "/");
}

/** 網銀「交易明細」每次查詢期間不可超過六個月，且只提供最近一年。 */
export const FUBON_MAX_RANGE_MONTHS = 6;

/** 期間是否超過網銀單次查詢上限（迄日往前六個月仍晚於起日）。 */
export function exceedsFubonRangeLimit(range: { start: string; end: string }) {
  const [y, m, d] = range.end.split("/").map(Number);
  const lastDay = new Date(
    Date.UTC(y, m - 1 - FUBON_MAX_RANGE_MONTHS + 1, 0),
  ).getUTCDate();
  const limit = formatSlashDate(
    new Date(Date.UTC(y, m - 1 - FUBON_MAX_RANGE_MONTHS, Math.min(d, lastDay))),
  );
  return range.start < limit;
}

/** 將 `YYYY/MM/DD` 期間平分為兩段不重疊的期間；單日無法再分割時回傳 undefined。 */
export function splitFubonRange(range: { start: string; end: string }) {
  const start = Date.parse(`${range.start.replace(/\//g, "-")}T00:00:00Z`);
  const end = Date.parse(`${range.end.replace(/\//g, "-")}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return undefined;
  const middle = start + Math.floor(days / 2) * 86_400_000;
  return [
    { start: range.start, end: formatSlashDate(new Date(middle)) },
    {
      start: formatSlashDate(new Date(middle + 86_400_000)),
      end: range.end,
    },
  ] as const;
}
