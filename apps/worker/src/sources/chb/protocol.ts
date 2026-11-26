import type {
  AutopayAccountHint,
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "../financial-types";
import forge from "node-forge";
import { z } from "zod";
import { creditCardLiabilityBalance } from "../credit-card-liability";
import { depositAccountName } from "../deposit-account-name";
import { loanAccountName } from "../loan-account-name";
import { BANK_SYNC_MONTHS } from "../sync-window";

// 彰化銀行個人網路銀行（www.chb.com.tw/chbnib）。登入由頁面自己加密密碼後送出；
// 登入後所有資料都經 `POST /chbnib/rest`（JSON），由已登入的頁面內發出。
// 欄位依 2026-10-31 登入後偵察與銀行公開前端程式整理，語意不確定處以 `TODO(chb-live)` 標示。

export const CHB_BANK_CODE = "009";
export const CHB_CAPTCHA_DIGIT_COUNT = 6;
export const CHB_INSTITUTION_NAME = "彰化銀行";
export const CHB_SYNC_MONTHS = BANK_SYNC_MONTHS;
export const CHB_CREDIT_ACCOUNT_ID = "credit:chb:card";
/** 每次同步的信用卡帳單期數（網銀提供近六期）。 */
const CHB_STATEMENT_MONTHS = BANK_SYNC_MONTHS;

export const chbConfigSchema = z.object({
  nationalId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
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

export type ChbConfig = z.infer<typeof chbConfigSchema>;

export function parseChbConfig(config: unknown): ChbConfig {
  return chbConfigSchema.parse(config);
}

export class ChbProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChbProtocolError";
  }
}

/** 單一資料列或欄位值不符預期；只略過該筆，不中止同步。 */
export class ChbRowRejectedError extends ChbProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "ChbRowRejectedError";
  }
}

/**
 * `/chbnib/rest` 回覆 `isSuccess: false` 或非 `S001`；只帶回覆代碼，不帶回覆內容。
 * `noData` 表示回覆是 `E005`「查無資料」（該查詢沒有資料列），只保留這個判斷結果。
 */
export class ChbApiError extends ChbProtocolError {
  constructor(
    readonly returnCode: string,
    message: string,
    readonly noData = false,
  ) {
    super(message);
    this.name = "ChbApiError";
  }
}

// ---------------------------------------------------------------------------
// REST 請求：DataCheckSum
// ---------------------------------------------------------------------------

export type ChbRestRequest = {
  url: string;
  method: "GET" | "POST";
  taskID: string;
  data: Record<string, unknown>;
};

/** 與銀行前端 `sendDataToServer` 相同的欄位順序：url、method、taskID、data。 */
export function chbRequestBody(request: ChbRestRequest) {
  return JSON.stringify({
    url: request.url,
    method: request.method,
    taskID: request.taskID,
    data: request.data,
  });
}

const BASE64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** 銀行前端 `utils.utf16to8`：逐個 UTF-16 code unit 轉 UTF-8 位元組（代理對各自編成三位元組）。 */
function utf16to8(value: string) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0x0001 && c <= 0x007f) {
      out += value.charAt(i);
    } else if (c > 0x07ff) {
      out += String.fromCharCode(0xe0 | ((c >> 12) & 0x0f));
      out += String.fromCharCode(0x80 | ((c >> 6) & 0x3f));
      out += String.fromCharCode(0x80 | (c & 0x3f));
    } else {
      out += String.fromCharCode(0xc0 | ((c >> 6) & 0x1f));
      out += String.fromCharCode(0x80 | (c & 0x3f));
    }
  }
  return out;
}

/** 銀行前端 `utils.encode64`：標準 Base64（含 `=` 補齊）。 */
function encode64(input: string) {
  let output = "";
  let i = 0;
  do {
    const chr1 = input.charCodeAt(i++);
    const chr2 = input.charCodeAt(i++);
    const chr3 = input.charCodeAt(i++);
    const enc1 = chr1 >> 2;
    const enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
    let enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
    let enc4 = chr3 & 63;
    if (Number.isNaN(chr2)) {
      enc3 = enc4 = 64;
    } else if (Number.isNaN(chr3)) {
      enc4 = 64;
    }
    output +=
      BASE64_CHARS.charAt(enc1) +
      BASE64_CHARS.charAt(enc2) +
      BASE64_CHARS.charAt(enc3) +
      BASE64_CHARS.charAt(enc4);
  } while (i < input.length);
  return output;
}

let crcTable: number[] | undefined;

/** 標準 CRC-32（IEEE 802.3，與銀行 `SecCRC32` 的 256 項查表逐項相同）。 */
function crc32(value: string) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable.push(c >>> 0);
    }
  }
  let crc = -1;
  for (let i = 0; i < value.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ value.charCodeAt(i)) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

/** `DataCheckSum` 標頭值：`crc32(encode64(utf16to8(body)))` 的十進位字串。 */
export function chbDataCheckSum(body: string) {
  return String(crc32(encode64(utf16to8(body))));
}

/** 解析 `/chbnib/rest` 回應；`S001` 以外一律拋出 ChbApiError（不含回覆內文）。 */
export function parseChbRestResponse(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChbApiError("NOT_JSON", "彰化銀行回應不是 JSON。");
  }
  const body = asRecord(parsed);
  if (!body) throw new ChbApiError("NOT_OBJECT", "彰化銀行回應格式不符。");
  const code = typeof body.returnCode === "string" ? body.returnCode : "";
  if (body.isSuccess !== true || code !== "S001") {
    throw new ChbApiError(
      code || "NO_CODE",
      `彰化銀行查詢失敗（回覆代碼 ${safeCode(code)}）。`,
      code === NO_DATA_CODE &&
        typeof body.returnMessage === "string" &&
        NO_DATA_MESSAGE.test(body.returnMessage),
    );
  }
  return body.data;
}

/** 銀行以回覆代碼 `E005` 加上這段文字表示該查詢沒有任何資料列（實機：信用卡未出帳明細）。 */
const NO_DATA_CODE = "E005";
const NO_DATA_MESSAGE = /查無資料/;

function safeCode(code: string) {
  return /^[A-Za-z0-9_-]{1,16}$/.test(code) ? code : "unknown";
}

// ---------------------------------------------------------------------------
// 部分失敗彙整
// ---------------------------------------------------------------------------

export const CHB_SYNC_CATEGORIES = {
  twBalance: "台幣餘額",
  twTransactions: "台幣明細",
  fcBalance: "外幣餘額",
  fcTransactions: "外幣明細",
  loans: "貸款",
  cardStatus: "信用卡繳款資訊",
  cardLimit: "信用卡額度",
  cardBills: "信用卡帳單",
  cardTransactions: "信用卡明細",
} as const;

export type ChbSyncCategory = keyof typeof CHB_SYNC_CATEGORIES;

export type ChbSyncFailure = {
  category: ChbSyncCategory;
  stage: string;
  errorClass: string;
  message: string;
};

const MAX_REPORTED_FAILURES = 12;

/** 錯誤類別與訊息去識別化：不含帳號、身分證字號或網址參數。 */
export function describeChbError(error: unknown) {
  const name =
    error instanceof Error
      ? error.name || error.constructor?.name || "Error"
      : typeof error;
  const errorClass = /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(name) ? name : "Error";
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = maskChbText(
    raw
      .replace(/https?:\/\/[^\s"'<>]+/g, "[url]")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .replace(/\d{6,}/g, "[redacted]")
    .slice(0, 160);
  return { errorClass, message };
}

/** 同步過程逐類累計成功／失敗筆數；失敗只記錄去識別化原因。 */
export class ChbSyncReport {
  readonly counts: Record<
    ChbSyncCategory,
    { ok: number; failed: number; rowsRejected: number }
  >;
  readonly failures: ChbSyncFailure[] = [];
  private failureTotal = 0;

  constructor() {
    this.counts = Object.fromEntries(
      Object.keys(CHB_SYNC_CATEGORIES).map((key) => [
        key,
        { ok: 0, failed: 0, rowsRejected: 0 },
      ]),
    ) as ChbSyncReport["counts"];
  }

  ok(category: ChbSyncCategory, count = 1) {
    this.counts[category].ok += count;
  }

  fail(category: ChbSyncCategory, stage: string, error: unknown, count = 1) {
    this.counts[category].failed += count;
    this.failureTotal += count;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({ category, stage, ...describeChbError(error) });
    }
  }

  rejectRow(category: ChbSyncCategory, error: unknown) {
    this.counts[category].rowsRejected += 1;
    this.failureTotal += 1;
    if (this.failures.length < MAX_REPORTED_FAILURES) {
      this.failures.push({
        category,
        stage: "row",
        ...describeChbError(error),
      });
    }
  }

  get failedCount() {
    return this.failureTotal;
  }

  /** `chb_sync_summary` 記錄內容；只含筆數與去識別化原因。 */
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
    const failed = (Object.keys(this.counts) as ChbSyncCategory[])
      .filter(
        (key) => this.counts[key].failed + this.counts[key].rowsRejected > 0,
      )
      .map(
        (key) =>
          `${CHB_SYNC_CATEGORIES[key]} ${this.counts[key].failed + this.counts[key].rowsRejected} 筆`,
      );
    return failed.length > 0
      ? `部分資料未能取得，已略過：${failed.join("、")}。`
      : undefined;
  }
}

// ---------------------------------------------------------------------------
// 登入結果分類（頁面文字只在記憶體內比對，不寫入 log）
// ---------------------------------------------------------------------------

export type ChbLoginOutcome =
  | { kind: "success" }
  | { kind: "captcha" }
  | { kind: "credential" }
  | { kind: "locked" }
  | { kind: "duplicate" }
  | { kind: "maintenance" }
  | { kind: "unknown" };

/**
 * 依登入送出後的提示文字（原生 alert 或頁面文字）分類。帳密類錯誤優先判斷，
 * 避免同時提到驗證碼與密碼的訊息被當成可重試的驗證碼錯誤；只有明確的驗證碼錯誤才可重試。
 * TODO(chb-live): 尚未取得各種失敗的真實提示文字，關鍵字依一般網銀用語推定。
 */
export function classifyChbLoginMessage(text: string): ChbLoginOutcome {
  const message = text.replace(/\s+/g, "");
  if (!message) return { kind: "unknown" };
  if (
    /(鎖定|停用|暫停使用|凍結|註銷|已達\d*次|連續.{0,6}錯誤.{0,6}次)/.test(
      message,
    )
  )
    return { kind: "locked" };
  if (
    /(密碼|使用者代號|使用者代碼|身分證|身份證|統一編號|帳號).{0,12}(錯誤|有誤|不符|不正確|不存在|無效)/.test(
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
// 基本解析
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw new ChbProtocolError("彰化銀行回應的資料列不是陣列。");
  }
  return value.map((row, index) => {
    const record = asRecord(row);
    if (!record) {
      throw new ChbRowRejectedError(`資料列 ${index + 1} 不是物件。`);
    }
    return record;
  });
}

function text(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 在回應物件頂層、再往下一層尋找欄位（View 回應的欄位位置依頁面而異）。 */
export function findChbField(data: unknown, key: string): unknown {
  const top = asRecord(data);
  if (!top) return undefined;
  if (top[key] !== undefined) return top[key];
  for (const value of Object.values(top)) {
    const nested = asRecord(value);
    if (nested && nested[key] !== undefined) return nested[key];
  }
  return undefined;
}

function toHalfWidth(value: string) {
  return value
    .replace(/[！-～]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/　/g, " ");
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function stableHash(value: string) {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

/** 文字中可能出現的帳號、身分證字號遮罩為末四碼。 */
export function maskChbText(value: string) {
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
// 金額
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const MAX_AMOUNT = 1e12;

/**
 * 銀行金額字串：千分位、小數、正負號（含括號負數與後置負號）。空字串與 `-`／`--` 視為無值（回傳
 * undefined）；其他無法解析的值一律拒絕，不產生 NaN。
 */
export function parseChbAmount(value: unknown): number | undefined {
  const raw = typeof value === "number" ? String(value) : text(value);
  const compact = toHalfWidth(raw)
    .replace(/\s+/g, "")
    .replace(/^(?:NT\$|NTD|\$)/i, "")
    .replace(/[元]$/, "");
  if (compact === "" || /^[-－—–]{1,2}$/.test(compact)) return undefined;
  let normalized = compact;
  let negative = false;
  const parenthesized = normalized.match(/^\((.+)\)$/);
  if (parenthesized) {
    normalized = parenthesized[1]!;
    negative = true;
  }
  if (normalized.endsWith("-")) {
    normalized = normalized.slice(0, -1);
    negative = !negative;
  }
  if (!AMOUNT_PATTERN.test(normalized)) {
    throw new ChbRowRejectedError("金額格式不符。");
  }
  const parsed = Number(normalized.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_AMOUNT) {
    throw new ChbRowRejectedError("金額超出範圍。");
  }
  return roundCurrency(negative ? -parsed : parsed);
}

// ---------------------------------------------------------------------------
// 日期與查詢區間
// ---------------------------------------------------------------------------

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
  return date.toISOString().slice(0, 10);
}

type ChbDateParts = { year: number; month: number; day: number };

/** 可能含時間尾巴的日期字串；3 位數（7 碼數字）年份為民國年，4 位數為西元年。 */
function matchChbDate(
  value: string,
): { parts: ChbDateParts; style: ChbDateStyle } | undefined {
  const raw = toHalfWidth(value).trim();
  const separated = raw.match(/^(\d{3,4})([/.-])(\d{1,2})\2(\d{1,2})(?!\d)/);
  if (separated) {
    const yearText = separated[1]!;
    return {
      parts: {
        year: Number(yearText) + (yearText.length === 3 ? 1911 : 0),
        month: Number(separated[3]),
        day: Number(separated[4]),
      },
      style: { roc: yearText.length === 3, separator: separated[2]! },
    };
  }
  const compact = raw.match(/^(\d{7}|\d{8})(?!\d)/);
  if (compact) {
    const digits = compact[1]!;
    const roc = digits.length === 7;
    const yearLength = roc ? 3 : 4;
    return {
      parts: {
        year: Number(digits.slice(0, yearLength)) + (roc ? 1911 : 0),
        month: Number(digits.slice(yearLength, yearLength + 2)),
        day: Number(digits.slice(yearLength + 2, yearLength + 4)),
      },
      style: { roc, separator: "" },
    };
  }
  return undefined;
}

/** 解析 `YYYY/MM/DD`、民國 `YYY/MM/DD`（分隔符 `/`、`-`、`.`）與 7／8 碼數字；無效日期回傳 undefined。 */
export function parseChbDate(value: unknown): string | undefined {
  const matched = matchChbDate(text(value));
  if (!matched) return undefined;
  const { year, month, day } = matched.parts;
  return isoDate(year, month, day);
}

export type ChbDateStyle = { roc: boolean; separator: string };

/** 由 View 回應的查詢迄日偵測日期樣式：3 位數年份為民國年，沿用相同分隔符。 */
export function detectChbDateStyle(sample: unknown): ChbDateStyle | undefined {
  const matched = matchChbDate(text(sample));
  if (!matched) return undefined;
  const { year, month, day } = matched.parts;
  return isoDate(year, month, day) ? matched.style : undefined;
}

export function formatChbDate(iso: string, style: ChbDateStyle) {
  const [year, month, day] = iso.split("-") as [string, string, string];
  const yearText = style.roc
    ? String(Number(year) - 1911).padStart(3, "0")
    : year;
  return [yearText, month, day].join(style.separator);
}

export type ChbQueryRange = { start: string; end: string };

/**
 * 查詢區間：迄日取 View 回應的查詢迄日（TW `queryEndDate`、FC `endDate`），起日為迄日往前
 * CHB_SYNC_MONTHS 個月，格式與迄日相同。View 沒有可解析的迄日時無從得知日期格式，直接拒絕。
 */
export function chbQueryRange(endSample: unknown): ChbQueryRange {
  const endIso = parseChbDate(endSample);
  const style = detectChbDateStyle(endSample);
  if (!endIso || !style) {
    throw new ChbProtocolError("彰化銀行查詢頁沒有提供可解析的查詢迄日。");
  }
  const [year, month, day] = endIso.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const targetMonth = month - 1 - CHB_SYNC_MONTHS;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
  return {
    start: formatChbDate(start, style),
    end: formatChbDate(endIso, style),
  };
}

/** `HH:MM`、`HH:MM:SS`、`HHMM`、`HHMMSS`；無法解析回傳 undefined。 */
function parseChbTime(value: unknown) {
  const matched = toHalfWidth(text(value)).match(
    /^(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/,
  );
  if (!matched) return undefined;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  const second = Number(matched[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

// ---------------------------------------------------------------------------
// 帳號選單與 sourceId
// ---------------------------------------------------------------------------

/** View 回應 `accountItems[]` 的一項：`label` 為顯示文字（含帳號），`value` 為查詢使用的值。 */
export type ChbAccountItem = { label: string; value: string };

export function parseChbAccountItems(data: unknown): ChbAccountItem[] {
  const items = findChbField(data, "accountItems");
  if (!Array.isArray(items)) {
    throw new ChbProtocolError("彰化銀行查詢頁沒有帳號選單。");
  }
  return items.flatMap((item) => {
    const record = asRecord(item);
    const value = text(record?.value);
    return record && value ? [{ label: text(record.label), value }] : [];
  });
}

/** 「全部帳號」選項：標籤含「全部」或值為 ALL；沒有時回傳 undefined。 */
export function pickChbAllAccountItem(items: ChbAccountItem[]) {
  return items.find(
    (item) => /全部/.test(item.label) || /^all$/i.test(item.value),
  );
}

function isAllItem(item: ChbAccountItem) {
  return pickChbAllAccountItem([item]) !== undefined;
}

/** 單一帳號選項（排除「全部帳號」）。 */
export function chbSingleAccountItems(items: ChbAccountItem[]) {
  return items.filter((item) => !isAllItem(item));
}

const FC_VALUE_SEPARATOR = "$$$";

/** 台幣明細選單項目的帳號：標籤第一段（例如 `0000-12-34567-8-90 虛構分行`）的數字。 */
export function chbTwItemAccountNo(item: ChbAccountItem) {
  const fromLabel = digitsOnly(toHalfWidth(item.label).split(/\s+/)[0] ?? "");
  return fromLabel || digitsOnly(item.value);
}

/** 外幣選單項目：`value` 為 `<帳號>$$$<幣別>`（銀行前端以此取幣別），標籤另有 `(USD)`。 */
export function chbFcItemAccount(item: ChbAccountItem) {
  const [accountPart = "", currencyPart = ""] =
    item.value.split(FC_VALUE_SEPARATOR);
  const labelCurrency = item.label.match(/\(([A-Za-z]{3})\)\s*$/)?.[1];
  const currency = (
    /^[A-Za-z]{3}$/.test(currencyPart) ? currencyPart : (labelCurrency ?? "")
  ).toUpperCase();
  const accountNo =
    digitsOnly(accountPart) ||
    digitsOnly(toHalfWidth(item.label).split(/\s+/)[0] ?? "");
  return { accountNo, currency };
}

/**
 * 存款帳戶 sourceId：`bank:chb:<末四碼>:<完整帳號 SHA-256 前 16 碼>`，外幣帳戶再加 `:<幣別>`。
 * 不保存完整帳號；第三段為末四碼，符合直接存款來源約定。
 */
export function chbDepositSourceId(accountNo: string, currency = "TWD") {
  const normalized = digitsOnly(toHalfWidth(accountNo));
  const base = `bank:chb:${normalized.slice(-4)}:${stableHash(`chb:${normalized}`)}`;
  return currency === "TWD" ? base : `${base}:${currency}`;
}

// ---------------------------------------------------------------------------
// 餘額
// ---------------------------------------------------------------------------

export type ChbDepositAccount = {
  accountNo: string;
  sourceId: string;
  currency: string;
  typeName: string;
  branchName?: string;
  balance: number;
  availableBalance?: number;
};

function validAccountNo(value: unknown) {
  const accountNo = digitsOnly(toHalfWidth(text(value)));
  if (accountNo.length < 6) {
    throw new ChbRowRejectedError("帳號格式不符。");
  }
  return accountNo;
}

/** 台幣餘額 `depositDatas[]`：`surplus` 為帳面餘額、`autoBalance` 為可用餘額（銀行表格欄位名稱）。 */
export function parseChbTwBalance(data: unknown) {
  const accounts: ChbDepositAccount[] = [];
  const rejected: string[] = [];
  for (const row of asRows(asRecord(data)?.depositDatas)) {
    try {
      const accountNo = validAccountNo(row.accountNo);
      const balance = parseChbAmount(row.surplus);
      if (balance === undefined) {
        throw new ChbRowRejectedError("台幣餘額缺少帳面餘額。");
      }
      accounts.push({
        accountNo,
        sourceId: chbDepositSourceId(accountNo),
        currency: "TWD",
        typeName: "新臺幣活存",
        branchName: text(row.branceBank) || undefined,
        balance,
        availableBalance: parseChbAmount(row.autoBalance),
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  return { accounts, rejected };
}

/** 外幣餘額 `recordList[]`：`blanceAmt` 為帳面餘額、`autoBalanceAmt` 為可用餘額，`currencyId` 為幣別。 */
export function parseChbFcBalance(data: unknown) {
  const accounts: ChbDepositAccount[] = [];
  const rejected: string[] = [];
  for (const row of asRows(asRecord(data)?.recordList)) {
    try {
      const accountNo = validAccountNo(row.accountNo);
      const currency = text(row.currencyId).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new ChbRowRejectedError("外幣餘額的幣別不符。");
      }
      const balance = parseChbAmount(row.blanceAmt);
      if (balance === undefined) {
        throw new ChbRowRejectedError("外幣餘額缺少帳面餘額。");
      }
      accounts.push({
        accountNo,
        sourceId: chbDepositSourceId(accountNo, currency),
        currency,
        typeName: "外幣活存",
        branchName: text(row.branchId) || undefined,
        balance,
        availableBalance: parseChbAmount(row.autoBalanceAmt),
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  return { accounts, rejected };
}

// ---------------------------------------------------------------------------
// 貸款
// ---------------------------------------------------------------------------

/**
 * 貸款帳戶 sourceId：`loan:chb:<完整帳號 SHA-256 前 16 碼>`；不保存完整帳號。
 * `subNumber` 是回應 `key`（`<帳號>~~~<序號>~~~`）的第二段；實機都是 `00`，只有不是 `00` 時才納入雜湊，
 * 用來區分同一個帳號底下的多筆撥款。
 * TODO(chb-live): 同帳號多筆撥款的回應沒有實機樣本。
 */
export function chbLoanSourceId(accountNo: string, subNumber = "00") {
  const normalized = digitsOnly(toHalfWidth(accountNo));
  const identity =
    subNumber === "00" ? normalized : `${normalized}:${subNumber}`;
  return `loan:chb:${stableHash(`chb:loan:${identity}`)}`;
}

/**
 * 帳戶別 `accTypeName` 對應系統分類。實機只看到「信用貸款」與「擔保貸款」，房貸也顯示為
 * 「擔保貸款」，沒有另外的房貸名稱，所以擔保類一律視為 `housing`。
 */
function chbLoanCategory(
  typeName: string,
): NonNullable<BankAccount["loanCategory"]> {
  if (/信用|信貸|無擔保/.test(typeName)) return "personal";
  if (/擔保|房|住宅/.test(typeName)) return "housing";
  return "other";
}

/**
 * 網銀顯示的扣款帳號（貸款 `payActno`、信用卡 `autoDeductAccount`）。不保存完整帳號。
 * - 14 碼且就是本次同步到的彰銀臺幣存款帳戶：寫入銀行代碼、末四碼與存款 sourceId。
 * - 其他帳號（可能是他行帳號）：只留末四碼，不標銀行、不算雜湊。
 * - 空字串：頁面沒有顯示扣款帳號，為 null。
 * - 欄位不存在或不是字串、內容含遮罩或其他文字而無法辨識，或本次沒有取得臺幣存款帳戶而無從比對：undefined，保留既有資料
 *   （寫入只有末四碼的值會蓋掉上次正確對應的扣款帳戶）。
 */
function chbAutopayAccount(
  value: unknown,
  depositSourceIds: ReadonlySet<string>,
): { autopayAccount?: AutopayAccountHint | null } {
  if (typeof value !== "string") return {};
  const raw = value.trim();
  if (raw === "") return { autopayAccount: null };
  const display = toHalfWidth(raw);
  const accountNo = digitsOnly(display);
  // 含遮罩或其他文字的值無法得到正確末四碼，視為無法辨識。
  if (
    !/^[\d\s-]+$/.test(display) ||
    accountNo.length < 6 ||
    depositSourceIds.size === 0
  ) {
    return {};
  }
  const depositSourceId = chbDepositSourceId(accountNo);
  return {
    autopayAccount:
      accountNo.length === 14 && depositSourceIds.has(depositSourceId)
        ? {
            bankCode: CHB_BANK_CODE,
            last4: accountNo.slice(-4),
            depositSourceId,
          }
        : { last4: accountNo.slice(-4) },
  };
}

/** 選填欄位：無值或格式不符都回傳 undefined，不因此拒絕整筆資料。 */
function optionalChbAmount(value: unknown) {
  try {
    return parseChbAmount(value);
  } catch {
    return undefined;
  }
}

/** 利率字串（如 `2.275%`）的百分點數值；不走金額解析，避免被四捨五入到小數兩位。 */
function parseChbRatePct(value: unknown) {
  const matched = toHalfWidth(text(value)).match(/^(\d+(?:\.\d+)?)\s*%?$/);
  const rate = matched ? Number(matched[1]) : Number.NaN;
  return rate >= 0 && rate <= 100 ? rate : undefined;
}

type ChbLoan = {
  account: Omit<BankAccount, "id" | "connectorId">;
  snapshot: Omit<BankBalanceSnapshot, "id" | "connectorId">;
};

/**
 * 貸款帳戶查詢 `LO01001/lo01001_1_View` 的一般貸款 `generalLoanData[]`（欄位依實機回應）：
 * `account` 帳號、`accTypeName` 帳戶別、`actBal` 貸款餘額（以負值保存）、`apAmt` 初放金額、
 * `fitIrt` 利率（`2.19%`，百分點）、`startDate`／`endDate` 初放日與到期日、`total` 應繳本息、
 * `date` 繳款日、`payActno` 扣帳帳號（彰銀存款帳號）。額度貸款 `trancheLoanData[]` 尚未接入，只回報筆數。
 * `complete`：銀行明確回覆成功（`generalLoanSuccess: true`、沒有錯誤訊息、`generalLoanData` 是陣列）且每一列都解析成功，
 * 才能據此停用已消失的貸款。
 * TODO(chb-live): 沒有貸款時的回應未經實機確認；`generalLoanSuccess: false` 且訊息含「查無資料」視為沒有貸款。
 */
function parseChbLoans(
  data: unknown,
  now = new Date(),
  depositSourceIds: ReadonlySet<string>,
) {
  const record = asRecord(data);
  if (!record) throw new ChbProtocolError("彰化銀行貸款查詢回應格式不符。");
  if (
    record.generalLoanSuccess === false &&
    !NO_DATA_MESSAGE.test(text(record.generalLoanErrorMessage))
  ) {
    throw new ChbProtocolError("彰化銀行貸款查詢未成功。");
  }
  const asOfAt = now.toISOString();
  const snapshotDate = taipeiDate(now);
  const loans: ChbLoan[] = [];
  const rejected: string[] = [];
  for (const row of asRows(record.generalLoanData)) {
    try {
      const accountNo = validAccountNo(row.account);
      const currency = text(row.moneyType).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new ChbRowRejectedError("貸款的幣別不符。");
      }
      const balance = parseChbAmount(row.actBal);
      if (balance === undefined) {
        throw new ChbRowRejectedError("貸款缺少餘額。");
      }
      const subNumber = digitsOnly(text(row.key).split("~~~")[1] ?? "");
      const sourceId = chbLoanSourceId(accountNo, subNumber || "00");
      if (loans.some((loan) => loan.account.sourceId === sourceId)) {
        // 帳號與序號都相同的兩列無法區分，後一列會覆蓋前一列的餘額；拒絕並記錄。
        throw new ChbRowRejectedError("貸款帳號重複。");
      }
      const productName = maskChbText(text(row.accTypeName));
      const loanCategory = chbLoanCategory(productName);
      const loanInterestRate = parseChbRatePct(row.fitIrt);
      const paymentAmount = optionalChbAmount(row.total);
      const paymentDueDate = parseChbDate(row.date);
      const remaining = balance === 0 ? 0 : -Math.abs(balance);
      loans.push({
        account: {
          sourceId,
          institutionName: CHB_INSTITUTION_NAME,
          accountName: loanAccountName(loanCategory, accountNo),
          accountType: "loan",
          loanCategory,
          ...(loanInterestRate !== undefined ? { loanInterestRate } : {}),
          currency,
          openedDate: parseChbDate(row.startDate),
          maturityDate: parseChbDate(row.endDate),
          ...chbAutopayAccount(row.payActno, depositSourceIds),
          raw: {
            bankCode: CHB_BANK_CODE,
            accountLast4: accountNo.slice(-4),
            productName: productName || undefined,
            initialAmount: optionalChbAmount(row.apAmt),
            annualRatePct: loanInterestRate,
          },
        },
        snapshot: {
          accountId: sourceId,
          sourceId: `snapshot:${sourceId}:${snapshotDate}`,
          balance: remaining,
          ...(paymentDueDate ? { paymentDueDate } : {}),
          ...(paymentAmount !== undefined
            ? { loanPaymentAmount: paymentAmount }
            : {}),
          currency,
          asOfAt,
          raw: { balance: remaining },
        },
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  return {
    loans,
    rejected,
    complete:
      record.generalLoanSuccess === true &&
      text(record.generalLoanErrorMessage) === "" &&
      Array.isArray(record.generalLoanData) &&
      rejected.length === 0,
    trancheSkipped: Array.isArray(record.trancheLoanData)
      ? record.trancheLoanData.length
      : 0,
  };
}

// ---------------------------------------------------------------------------
// 信用卡
// ---------------------------------------------------------------------------

/**
 * 帳單清單 `CA01002/ca01002_1_View` 的 `list[]`（`stmtDate` 為 `YYYYMMDD`、`stmtBal` 為帳單金額）：
 * 由新到舊取最近 CHB_STATEMENT_MONTHS 個月。查詢單期帳單時要把該列原樣放進 Action 的 `data`。
 * 帳單以月份識別，同月有兩期（例如變更結帳日）時只取較新的一期，較舊的一期不查，以免它覆寫已存的帳單；
 * `sameMonthSkipped` 是略過的列數。
 * 任何一列的結帳日無法解析時整個清單視為格式不符，不靜默少查一期。
 */
export function chbCardBillListRows(data: unknown) {
  const entries = asRows(asRecord(data)?.list)
    .map((row) => {
      const closingDate = parseChbDate(row.stmtDate);
      if (!closingDate) {
        throw new ChbProtocolError("彰化銀行信用卡帳單清單的結帳日格式不符。");
      }
      return { row, closingDate };
    })
    .sort((a, b) => b.closingDate.localeCompare(a.closingDate));
  const latest = new Map<string, Record<string, unknown>>();
  for (const { row, closingDate } of entries) {
    const period = closingDate.slice(0, 7);
    if (!latest.has(period)) latest.set(period, row);
  }
  return {
    rows: [...latest.values()].slice(0, CHB_STATEMENT_MONTHS),
    sameMonthSkipped: entries.length - latest.size,
  };
}

/** 單期帳單回應的結帳日是否就是清單列要查的那一期。 */
export function chbCardBillMatchesListRow(bill: unknown, row: unknown) {
  const closingDate = parseChbDate(asRecord(bill)?.stmtDate);
  return (
    closingDate !== undefined &&
    closingDate === parseChbDate(asRecord(row)?.stmtDate)
  );
}

type ChbCardRow = {
  /** ISO 消費日。 */
  transactionDate: string;
  postedDate?: string;
  /** 銀行的台幣金額：正數為消費，負數為繳款或退款。 */
  bankAmount: number;
  description: string;
  cardLast4?: string;
  foreignCurrency?: string;
  foreignAmount?: number;
};

/**
 * 帳單明細 `info[]` 的列（欄位依實機回應）：
 * `trxnDate` 消費日、`postDate` 入帳日、`memo` 摘要、`billAmt` 台幣金額、
 * `trxnAmt`／`trxnCurr` 簽帳金額與幣別、`chNO` 卡號後四碼（繳款列為 `****`）。
 */
function parseChbCardRows(value: unknown) {
  const transactions: ChbCardRow[] = [];
  const rejected: string[] = [];
  for (const row of asRows(value)) {
    try {
      const postedDate = parseChbDate(row.postDate);
      const transactionDate = parseChbDate(row.trxnDate) ?? postedDate;
      if (!transactionDate) {
        throw new ChbRowRejectedError("信用卡明細的日期格式不符。");
      }
      const bankAmount = parseChbAmount(row.billAmt);
      if (bankAmount === undefined) {
        throw new ChbRowRejectedError("信用卡明細缺少台幣金額。");
      }
      // 只供顯示；遮罩卡號（例如 `1234-****-****-5678`）取數字的末四碼。
      const cardDigits = digitsOnly(toHalfWidth(text(row.chNO)));
      const currency = text(row.trxnCurr).toUpperCase();
      const foreign = /^[A-Z]{3}$/.test(currency) && currency !== "TWD";
      transactions.push({
        transactionDate,
        postedDate,
        bankAmount,
        description: text(row.memo),
        cardLast4: cardDigits.length >= 4 ? cardDigits.slice(-4) : undefined,
        foreignCurrency: foreign ? currency : undefined,
        foreignAmount: foreign ? optionalChbAmount(row.trxnAmt) : undefined,
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  return { transactions, rejected };
}

type ChbCardBill = {
  /** 帳單期別 `YYYY-MM`（結帳日所在月份）。 */
  period: string;
  statementClosingDate: string;
  paymentDueDate?: string;
  statementAmount: number;
  minimumPayment?: number;
  previousBalance?: number;
  /** 上期繳款金額＋退款金額（網銀的算式兩項都從上期帳單金額扣除），保留銀行的正負號。 */
  paymentsAndRefunds?: number;
  newCharges?: number;
  transactions: ChbCardRow[];
  rejected: string[];
};

/**
 * 單期帳單 `CA01002/ca01002_1_Action`（欄位依實機回應）：`stmtDate` 結帳日、`dueDate` 繳款截止日、
 * `totalCurrentBal` 本期應繳總金額、`minRepay` 最低應繳、`begBal` 上期帳單金額、`pmtBal` 上期繳款金額、
 * `adjustBal` 退款金額、`prinBal` 本期新增金額（網銀算式：上期帳單金額 − 上期繳款金額 − 退款金額
 * ＋ 本期新增金額 ＝ 本期應繳總金額）。同一回應的 `billAmt`／`postDate`／`notYetBal`
 * 是最近一次繳款與目前未繳總額，不屬於這一期，不採用。
 */
function parseChbCardBill(data: unknown): ChbCardBill {
  const record = asRecord(data);
  const statementClosingDate = parseChbDate(record?.stmtDate);
  const statementAmount = optionalChbAmount(record?.totalCurrentBal);
  if (!record || !statementClosingDate || statementAmount === undefined) {
    throw new ChbProtocolError("彰化銀行信用卡帳單缺少結帳日或應繳總金額。");
  }
  const payments = optionalChbAmount(record.pmtBal);
  const refunds = optionalChbAmount(record.adjustBal);
  return {
    period: statementClosingDate.slice(0, 7),
    statementClosingDate,
    paymentDueDate: parseChbDate(record.dueDate),
    statementAmount,
    minimumPayment: optionalChbAmount(record.minRepay),
    previousBalance: optionalChbAmount(record.begBal),
    paymentsAndRefunds:
      payments === undefined
        ? undefined
        : roundCurrency(payments + (refunds ?? 0)),
    newCharges: optionalChbAmount(record.prinBal),
    ...parseChbCardRows(record.info),
  };
}

type ChbCardStatus = {
  statementClosingDate?: string;
  paymentDueDate?: string;
  /** 本期帳單剩餘應繳金額 (a)。 */
  remainingAmount: number;
  /** 未寄帳單金額 (b)。 */
  unbilledTotal: number;
  minimumRemaining?: number;
  autopayAccount?: AutopayAccountHint | null;
};

/**
 * 本期繳款查詢 `CA01021/ca01021_1_View`（欄位依實機回應）：`settleAccountDayOfMonth` 本期帳單結帳日、
 * `payBillDeadLine` 繳款截止日、`stmtBillAmt` 本期帳單剩餘應繳金額 (a)、`notSendBillBal` 未寄帳單金額 (b)、
 * `minimumPayAmount` 剩餘最低應繳、`autoDeductAccount` 自動扣款帳號。
 */
function parseChbCardStatus(
  data: unknown,
  depositSourceIds: ReadonlySet<string>,
): ChbCardStatus {
  const record = asRecord(data);
  const remainingAmount = optionalChbAmount(record?.stmtBillAmt);
  const unbilledTotal = optionalChbAmount(record?.notSendBillBal);
  if (!record || remainingAmount === undefined || unbilledTotal === undefined) {
    throw new ChbProtocolError("彰化銀行信用卡繳款資訊缺少應繳金額。");
  }
  return {
    statementClosingDate: parseChbDate(record.settleAccountDayOfMonth),
    paymentDueDate: parseChbDate(record.payBillDeadLine),
    remainingAmount,
    unbilledTotal,
    minimumRemaining: optionalChbAmount(record.minimumPayAmount),
    ...chbAutopayAccount(record.autoDeductAccount, depositSourceIds),
  };
}

/** `YYYY-MM` 的下一個月。 */
function nextChbPeriod(period: string) {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/**
 * 帳單是否已繳：應繳為 0 或溢繳視為已繳。本期（結帳日與繳款資訊相同）看剩餘應繳。較早期別只用
 * 緊接的下一個月帳單推得：該帳單的「上期帳單金額」須等於本期應繳總金額，再看「上期繳款＋退款」
 * 是否足額。中間缺一期或金額對不上時為未知，不拿隔期的帳單比對。退款金額的正負號沒有實機樣本，
 * 所以下一期帳單要先符合網銀的算式（上期帳單金額 − 上期繳款金額 − 退款金額 ＋ 本期新增金額
 * ＝ 本期應繳總金額）才採用，否則為未知。
 */
function chbCardBillPayment(
  bill: ChbCardBill,
  next: ChbCardBill | undefined,
  status: ChbCardStatus | undefined,
): { isPaid?: boolean; paidAmount?: number } {
  if (bill.statementAmount <= 0) return { isPaid: true };
  if (status && status.statementClosingDate === bill.statementClosingDate) {
    return {
      isPaid: status.remainingAmount <= 0,
      paidAmount: clampPaid(
        roundCurrency(bill.statementAmount - status.remainingAmount),
        bill.statementAmount,
      ),
    };
  }
  if (
    next?.period !== nextChbPeriod(bill.period) ||
    next.previousBalance === undefined ||
    next.paymentsAndRefunds === undefined ||
    next.newCharges === undefined ||
    next.previousBalance !== bill.statementAmount ||
    roundCurrency(
      next.previousBalance - next.paymentsAndRefunds + next.newCharges,
    ) !== next.statementAmount
  ) {
    return {};
  }
  return {
    isPaid: next.paymentsAndRefunds >= bill.statementAmount,
    paidAmount: clampPaid(next.paymentsAndRefunds, bill.statementAmount),
  };
}

/** 已繳金額限制在 0 到帳單金額之間；溢繳不算進這一期。 */
function clampPaid(paid: number, statementAmount: number) {
  return Math.min(statementAmount, Math.max(0, paid));
}

export type ChbCardPayload = {
  /** 本期繳款查詢 View 回應的 `data`；查無資料或查詢失敗時沒有這個欄位。 */
  status?: unknown;
  /** 額度及費率 `CA01001` View 回應的 `data`（`creditLine` 信用總額度）。 */
  limit?: unknown;
  /** 各期帳單 Action 回應的 `data`。 */
  bills: unknown[];
};

/** 額度及費率回應的信用總額度；沒有或格式不符時為 undefined。 */
export function chbCardCreditLimit(limit: unknown) {
  return optionalChbAmount(asRecord(limit)?.creditLine);
}

/**
 * 本期繳款查詢的回應是否顯示持有信用卡：有可解析的結帳日，或剩餘應繳、未寄帳單金額不是 0。
 * 沒有信用卡的客戶可能得到「成功但內容是空的或全為 0」的回應，這種回應不能當成持卡依據。
 * TODO(chb-live): 沒有信用卡時的回應沒有實機樣本。
 */
export function chbCardStatusShowsCard(status: unknown) {
  const record = asRecord(status);
  if (!record) return false;
  return (
    parseChbDate(record.settleAccountDayOfMonth) !== undefined ||
    (optionalChbAmount(record.stmtBillAmt) ?? 0) !== 0 ||
    (optionalChbAmount(record.notSendBillBal) ?? 0) !== 0
  );
}

type ChbCardData = {
  account: Omit<BankAccount, "id" | "connectorId">;
  snapshot?: Omit<BankBalanceSnapshot, "id" | "connectorId">;
  transactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  bills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

/**
 * 信用卡正規化。各卡共用一個帳戶，交易以 `cardLast4` 標示卡片（只供顯示）。
 * - 明細只取帳單明細，一律是 `posted`。未出帳明細（`CA01003`）有資料時的回應沒有實機樣本，
 *   無法確認出帳後能沿用同一個 ID，所以不寫成交易；未出帳的金額已含在負債快照。
 * - 交易 ID 為 `chb:card:tx:v1:<消費日>:<入帳日>:<帶正負號金額>:<摘要雜湊>:<序號>`，不含卡號與帳單期別。
 *   入帳日相同的列必在同一期帳單，序號只在這一組內分配：分期每期各一列各有自己的 ID（入帳日或摘要的期數不同），
 *   某期帳單沒有取得或舊帳單離開三期視窗，都不會改變其他列的 ID。卡號不能放進 ID，所以只差卡號的列
 *   依出現順序編號，銀行對調順序時這兩列會互換 ID。
 *   缺入帳日時以該期結帳日代替。
 * 繳款資訊、帳單與信用額度都沒有時回傳 undefined。
 */
function parseChbCard(
  payload: ChbCardPayload,
  asOfAt: string,
  snapshotDate: string,
  report: ChbSyncReport,
  depositSourceIds: ReadonlySet<string>,
): ChbCardData | undefined {
  let status: ChbCardStatus | undefined;
  if (payload.status !== undefined) {
    try {
      status = parseChbCardStatus(payload.status, depositSourceIds);
      report.ok("cardStatus");
    } catch (error) {
      report.fail("cardStatus", "parse", error);
    }
  }

  const byPeriod = new Map<string, ChbCardBill>();
  for (const data of Array.isArray(payload.bills) ? payload.bills : []) {
    try {
      const bill = parseChbCardBill(data);
      if (byPeriod.has(bill.period)) {
        // 同一個月有兩期（例如變更結帳日）時期別會相同，不靜默覆蓋。
        throw new ChbProtocolError("彰化銀行信用卡帳單期別重複。");
      }
      byPeriod.set(bill.period, bill);
      report.ok("cardBills");
    } catch (error) {
      report.fail("cardBills", "parse", error);
    }
  }
  const bills = [...byPeriod.values()].sort((a, b) =>
    b.period.localeCompare(a.period),
  );

  const creditLimit = chbCardCreditLimit(payload.limit);
  if (creditLimit !== undefined) report.ok("cardLimit");
  else if (payload.limit !== undefined) {
    report.fail(
      "cardLimit",
      "parse",
      new ChbProtocolError("彰化銀行信用卡額度格式不符。"),
    );
  }
  if (
    !(status && chbCardStatusShowsCard(payload.status)) &&
    bills.length === 0 &&
    !(creditLimit !== undefined && creditLimit > 0)
  ) {
    return undefined;
  }

  for (const reason of bills.flatMap((bill) => bill.rejected)) {
    report.rejectRow("cardTransactions", new ChbRowRejectedError(reason));
  }
  const occurrences = new Map<string, number>();
  const transactions = [...bills].reverse().flatMap((bill) =>
    bill.transactions.map((row): ChbCardData["transactions"][number] => {
      const negated = roundCurrency(-row.bankAmount);
      const amount = negated === 0 ? 0 : negated;
      const postedKey = row.postedDate ?? bill.statementClosingDate;
      const description = maskChbText(row.description);
      const memoKey = stableHash(description.replace(/\s+/g, " ").trim()).slice(
        0,
        8,
      );
      const identity = `${row.transactionDate}:${postedKey}:${amount}:${memoKey}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      return {
        accountId: CHB_CREDIT_ACCOUNT_ID,
        sourceId: `chb:card:tx:v1:${identity}:${occurrence}`,
        authorizedAt: row.transactionDate,
        postedDate: row.postedDate,
        amount,
        currency: "TWD",
        description: description || "彰化銀行信用卡",
        status: "posted",
        cardLast4: row.cardLast4,
        raw: {
          cardLast4: row.cardLast4,
          foreignCurrency: row.foreignCurrency,
          foreignAmount: row.foreignAmount,
        },
      };
    }),
  );
  report.ok("cardTransactions", transactions.length);

  const currentBill = bills.find(
    (bill) => bill.statementClosingDate === status?.statementClosingDate,
  );
  return {
    account: {
      sourceId: CHB_CREDIT_ACCOUNT_ID,
      institutionName: CHB_INSTITUTION_NAME,
      accountName: "彰化銀行信用卡",
      accountType: "credit",
      currency: "TWD",
      creditLimit,
      // 繳款資訊未取得時為 undefined，保留上次同步的扣款帳戶。
      autopayAccount: status?.autopayAccount,
    },
    // 負債需要剩餘應繳與未出帳金額，兩者都來自繳款資訊；未取得時不建立快照。
    snapshot: status && {
      accountId: CHB_CREDIT_ACCOUNT_ID,
      sourceId: `snapshot:chb:credit:${snapshotDate}`,
      balance: creditCardLiabilityBalance(
        status.remainingAmount,
        status.unbilledTotal,
      ),
      statementBalance: currentBill?.statementAmount,
      statementClosingDate: status.statementClosingDate,
      // 本期已不需繳款時不寫繳款期限，避免提醒拿這個期限去找一張沒有存到的帳單。
      paymentDueDate:
        status.remainingAmount > 0 ? status.paymentDueDate : undefined,
      noPaymentNeeded: status.remainingAmount <= 0,
      currency: "TWD",
      asOfAt,
      raw: {
        remainingAmount: status.remainingAmount,
        unbilledTotal: status.unbilledTotal,
        minimumRemaining: status.minimumRemaining,
      },
    },
    transactions,
    bills: bills.map((bill, index) => ({
      accountId: CHB_CREDIT_ACCOUNT_ID,
      sourceId: `chb:card:bill:${bill.period}`,
      billingPeriod: bill.period,
      statementAmount: bill.statementAmount,
      minimumPayment: bill.minimumPayment,
      statementClosingDate: bill.statementClosingDate,
      paymentDueDate: bill.paymentDueDate,
      ...chbCardBillPayment(bill, bills[index - 1], status),
      currency: "TWD",
      raw: {
        period: bill.period,
        previousBalance: bill.previousBalance,
        paymentsAndRefunds: bill.paymentsAndRefunds,
        newCharges: bill.newCharges,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// 交易明細
// ---------------------------------------------------------------------------

export type ChbTransactionRow = {
  /** 帶方向的金額：支出為負、存入為正。 */
  amount: number;
  balanceAfter?: number;
  /** ISO 日期。 */
  transactionDate?: string;
  bookingDate?: string;
  /** `HH:MM:SS`（台灣時間）；無法解析為 undefined。 */
  transactionTime?: string;
  summary: string;
  memo: string;
  kind: string;
  adjustment: boolean;
};

export type ChbTransactionPage = {
  rows: ChbTransactionRow[];
  rejected: string[];
  /** 回應的總筆數（TW `totalCount`）；沒有時為 undefined。 */
  totalCount?: number;
};

function rowDates(row: Record<string, unknown>) {
  const transactionDate = parseChbDate(row.transactionDate ?? row.txDay);
  const bookingDate = parseChbDate(row.keepAccountDate ?? row.entDay);
  if (!transactionDate && !bookingDate) {
    throw new ChbRowRejectedError("交易日期格式不符。");
  }
  return { transactionDate, bookingDate };
}

/**
 * 台幣明細 `depositDatas[]`：`expenseBetr` 為支出、`depositedBetr` 為存入（銀行表格依此兩欄分列），
 * 兩欄須恰有一欄有非零金額。`hcode == "1"` 為更正交易（銀行表格在金額後標示「更正」）：
 * 更正列沿用原交易的欄位，但沖回原交易，所以方向相反（實機：支出欄的轉提更正讓餘額增加）。
 */
export function parseChbTwTransactions(data: unknown): ChbTransactionPage {
  const record = asRecord(data);
  const rows: ChbTransactionRow[] = [];
  const rejected: string[] = [];
  for (const row of asRows(record?.depositDatas)) {
    try {
      const expense = parseChbAmount(row.expenseBetr) ?? 0;
      const deposit = parseChbAmount(row.depositedBetr) ?? 0;
      if ((expense === 0) === (deposit === 0)) {
        throw new ChbRowRejectedError("支出與存入必須恰有一欄有金額。");
      }
      const dates = rowDates(row);
      const adjustment = text(row.hcode) === "1";
      const signed = expense !== 0 ? -Math.abs(expense) : Math.abs(deposit);
      rows.push({
        amount: roundCurrency(adjustment ? -signed : signed),
        balanceAfter: parseChbAmount(row.depositedSurplus),
        ...dates,
        transactionTime: parseChbTime(row.transactionTime),
        summary: text(row.summary),
        memo: text(row.memo) || text(row.annotation),
        kind: text(row.transKind),
        adjustment,
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  const totalCount = Number(record?.totalCount);
  return {
    rows,
    rejected,
    totalCount: Number.isFinite(totalCount) ? totalCount : undefined,
  };
}

/**
 * 外幣明細 `recordList[]`：`txAmt` 為金額、`expense` 為方向旗標。銀行前端表格在
 * `expense == 1` 時把 `txAmt` 放進第一個金額欄（與台幣明細一致，第一欄為支出），其餘放第二欄（存入），
 * 因此 `expense == 1` 視為支出。
 * TODO(chb-live): 方向假設以同步 log 的 `balanceMismatch` 驗證；不一致筆數應為 0。
 */
export function parseChbFcTransactions(data: unknown): ChbTransactionPage {
  const rows: ChbTransactionRow[] = [];
  const rejected: string[] = [];
  for (const row of asRows(asRecord(data)?.recordList)) {
    try {
      const magnitude = parseChbAmount(row.txAmt);
      if (magnitude === undefined || magnitude === 0) {
        throw new ChbRowRejectedError("外幣交易缺少金額。");
      }
      const flag = text(row.expense);
      if (flag === "") {
        throw new ChbRowRejectedError("外幣交易缺少收支旗標。");
      }
      const isExpense = flag === "1";
      const dates = rowDates(row);
      rows.push({
        amount: roundCurrency(
          isExpense ? -Math.abs(magnitude) : Math.abs(magnitude),
        ),
        balanceAfter: parseChbAmount(row.avaibleBalance),
        ...dates,
        transactionTime: parseChbTime(row.txTime),
        summary: text(row.trnDesc),
        memo: text(row.reMark),
        kind: text(row.txType),
        adjustment: false,
      });
    } catch (error) {
      rejected.push(error instanceof Error ? error.message : "列格式不符。");
    }
  }
  return { rows, rejected };
}

/**
 * 「上一筆餘額＋本筆金額＝本筆餘額」不一致的筆數。回應排序（由舊到新或由新到舊）未知，
 * 兩種順序各算一次、取不一致較少者；只回傳筆數，不含任何金額。
 */
export function chbBalanceMismatches(
  rows: Array<{ amount: number; balanceAfter?: number }>,
) {
  const count = (ordered: typeof rows) => {
    let checked = 0;
    let mismatched = 0;
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!.balanceAfter;
      const current = ordered[i]!;
      if (previous === undefined || current.balanceAfter === undefined)
        continue;
      checked += 1;
      if (Math.abs(previous + current.amount - current.balanceAfter) > 0.005) {
        mismatched += 1;
      }
    }
    return { checked, mismatched };
  };
  const forward = count(rows);
  const backward = count([...rows].reverse());
  return backward.mismatched < forward.mismatched
    ? { ...backward, order: "newest_first" as const }
    : { ...forward, order: "oldest_first" as const };
}

/**
 * 存款交易 ID：`sha256(帳號|幣別|交易日|記帳日|交易時間|帶正負號金額|交易後餘額|摘要)` 前 16 碼加上
 * 同一次查詢回應內相同識別的序號。每次同步都查整個固定區間，序號在不同同步之間一致。
 */
export function chbDepositTransactions(
  accountId: string,
  accountNo: string,
  currency: string,
  rows: ChbTransactionRow[],
): Array<Omit<BankTransaction, "id" | "connectorId">> {
  const normalized = digitsOnly(accountNo);
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const identity = [
      normalized,
      currency,
      row.transactionDate ?? "",
      row.bookingDate ?? "",
      row.transactionTime ?? "",
      // 識別用銀行欄位的方向（更正列反轉前），更正列方向修正後 sourceId 不變、同步時就地更新金額。
      (row.adjustment ? -row.amount : row.amount).toFixed(2),
      row.balanceAfter === undefined ? "" : row.balanceAfter.toFixed(2),
      row.summary.replace(/\s+/g, " ").trim(),
    ].join("|");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const summary = maskChbText(row.summary);
    const memo = maskChbText(row.memo);
    const authorizedDate = row.transactionDate ?? row.bookingDate;
    return {
      accountId,
      sourceId: `chb:deposit:tx:v1:${stableHash(identity)}:${occurrence}`,
      postedDate: row.bookingDate ?? row.transactionDate,
      authorizedAt:
        authorizedDate && row.transactionTime
          ? `${authorizedDate}T${row.transactionTime}+08:00`
          : authorizedDate,
      amount: row.amount,
      currency,
      description: summary || maskChbText(row.kind) || memo || "彰化銀行交易",
      counterparty: memo || undefined,
      status: "posted" as const,
      raw: {
        kind: maskChbText(row.kind) || undefined,
        summary: summary || undefined,
        memo: memo || undefined,
        balanceAfter: row.balanceAfter,
        adjustment: row.adjustment || undefined,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

export type ChbPayloads = {
  /** 台幣餘額 Action 回應的 `data`。 */
  twBalance?: unknown;
  twTransactions: Array<{ accountNo: string; data: unknown }>;
  /** 外幣餘額 Action 回應的 `data`（可能由多次查詢合併成 `recordList`）。 */
  fcBalance?: unknown;
  fcTransactions: Array<{
    accountNo: string;
    currency: string;
    data: unknown;
  }>;
  /** 貸款帳戶查詢 View 回應的 `data`；沒有貸款時為空物件。 */
  loans?: unknown;
  /** 信用卡各查詢的回應；沒有信用卡或未查詢時為 undefined。 */
  card?: ChbCardPayload;
};

export type ChbBalanceCheck = {
  checked: number;
  mismatched: number;
  order: "oldest_first" | "newest_first";
};

export type ChbData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
  /** 各類明細的「上一筆餘額＋本筆金額＝本筆餘額」檢查（只含筆數）。 */
  balanceChecks: { tw: ChbBalanceCheck[]; fc: ChbBalanceCheck[] };
  /** 回應 `totalCount` 大於實際解析筆數的查詢數（可能被截斷）。 */
  truncationSuspected: number;
  /** 尚未接入而略過的額度貸款筆數。 */
  trancheLoansSkipped: number;
  /** 貸款清單完整時，本次出現的貸款 sourceId（可能為空陣列）；不完整時為 undefined，不停用任何貸款。 */
  loanSourceIds?: string[];
};

/**
 * 任一帳戶、明細查詢或資料列無法解析時只略過該項並記入 `report`，其餘資料照常回傳。
 * 明細只寫入餘額回應中已出現的帳戶。
 */
export function parseChbData(
  payloads: ChbPayloads,
  now = new Date(),
  report = new ChbSyncReport(),
): ChbData {
  const asOfAt = now.toISOString();
  const snapshotDate = taipeiDate(now);
  const accounts = new Map<string, ChbDepositAccount>();

  const collect = (
    category: "twBalance" | "fcBalance",
    data: unknown,
    parse: typeof parseChbTwBalance,
  ) => {
    if (data === undefined) return;
    try {
      const parsed = parse(data);
      for (const reason of parsed.rejected) {
        report.rejectRow(category, new ChbRowRejectedError(reason));
      }
      for (const account of parsed.accounts) {
        if (accounts.has(account.sourceId)) continue;
        accounts.set(account.sourceId, account);
        report.ok(category);
      }
    } catch (error) {
      report.fail(category, "parse", error);
    }
  };
  collect("twBalance", payloads.twBalance, parseChbTwBalance);
  collect("fcBalance", payloads.fcBalance, parseChbFcBalance);

  const bankAccounts: ChbData["bankAccounts"] = [];
  const bankBalanceSnapshots: ChbData["bankBalanceSnapshots"] = [];
  for (const account of accounts.values()) {
    const last4 = account.accountNo.slice(-4);
    const raw = {
      bankCode: CHB_BANK_CODE,
      accountLast4: last4,
      accountTypeName: account.typeName,
      branchName: account.branchName,
      currency: account.currency,
    };
    bankAccounts.push({
      sourceId: account.sourceId,
      institutionName: CHB_INSTITUTION_NAME,
      accountName: depositAccountName(
        account.currency === "TWD"
          ? account.typeName
          : `${account.typeName} ${account.currency}`,
        account.accountNo,
        `${account.typeName} ${last4}`,
      ),
      accountType: "savings",
      currency: account.currency,
      raw,
    });
    bankBalanceSnapshots.push({
      accountId: account.sourceId,
      sourceId: `snapshot:chb:${account.sourceId.split(":").slice(2).join(":")}:${snapshotDate}`,
      balance: account.balance,
      availableBalance: account.availableBalance,
      currency: account.currency,
      asOfAt,
      raw: { ...raw, balance: account.balance },
    });
  }

  const bankTransactions: ChbData["bankTransactions"] = [];
  const balanceChecks: ChbData["balanceChecks"] = { tw: [], fc: [] };
  let truncationSuspected = 0;
  const addTransactions = (
    kind: "tw" | "fc",
    accountNo: string,
    currency: string,
    data: unknown,
  ) => {
    const category = kind === "tw" ? "twTransactions" : "fcTransactions";
    const account = accounts.get(chbDepositSourceId(accountNo, currency));
    if (!account) {
      report.fail(
        category,
        "parse",
        new ChbProtocolError("彰化銀行交易明細的帳號不在餘額回應中。"),
      );
      return;
    }
    try {
      const page =
        kind === "tw"
          ? parseChbTwTransactions(data)
          : parseChbFcTransactions(data);
      for (const reason of page.rejected) {
        report.rejectRow(category, new ChbRowRejectedError(reason));
      }
      if (
        page.totalCount !== undefined &&
        page.totalCount > page.rows.length + page.rejected.length
      ) {
        truncationSuspected += 1;
      }
      balanceChecks[kind].push(chbBalanceMismatches(page.rows));
      bankTransactions.push(
        ...chbDepositTransactions(
          account.sourceId,
          account.accountNo,
          account.currency,
          page.rows,
        ),
      );
      report.ok(category);
    } catch (error) {
      report.fail(category, "parse", error);
    }
  };
  for (const entry of payloads.twTransactions) {
    addTransactions("tw", entry.accountNo, "TWD", entry.data);
  }
  for (const entry of payloads.fcTransactions) {
    addTransactions("fc", entry.accountNo, entry.currency, entry.data);
  }

  // 扣款帳號只對應本次同步到的臺幣存款帳戶；沒有臺幣帳戶時無從比對，保留既有資料。
  const depositSourceIds = new Set(
    [...accounts.values()]
      .filter((account) => account.currency === "TWD")
      .map((account) => account.sourceId),
  );

  // 貸款是附加資料：解析失敗只略過貸款，存款照常回傳。
  let trancheLoansSkipped = 0;
  let loanSourceIds: string[] | undefined;
  if (payloads.loans !== undefined) {
    try {
      const parsed = parseChbLoans(payloads.loans, now, depositSourceIds);
      for (const reason of parsed.rejected) {
        report.rejectRow("loans", new ChbRowRejectedError(reason));
      }
      for (const loan of parsed.loans) {
        bankAccounts.push(loan.account);
        bankBalanceSnapshots.push(loan.snapshot);
        report.ok("loans");
      }
      trancheLoansSkipped = parsed.trancheSkipped;
      if (parsed.complete) {
        loanSourceIds = parsed.loans.map((loan) => loan.account.sourceId);
      }
    } catch (error) {
      report.fail("loans", "parse", error);
    }
  }

  // 信用卡同樣是附加資料；各查詢各自記錄成功或失敗，整體格式不符時只略過信用卡。
  let card: ChbCardData | undefined;
  if (payloads.card !== undefined) {
    try {
      if (!asRecord(payloads.card)) {
        throw new ChbProtocolError("彰化銀行信用卡資料格式不符。");
      }
      card = parseChbCard(
        payloads.card,
        asOfAt,
        snapshotDate,
        report,
        depositSourceIds,
      );
    } catch (error) {
      report.fail("cardStatus", "parse", error);
    }
  }
  if (card) {
    bankAccounts.push(card.account);
    if (card.snapshot) bankBalanceSnapshots.push(card.snapshot);
    bankTransactions.push(...card.transactions);
  }

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions: dedupeBySourceId(bankTransactions),
    creditCardBills: card?.bills ?? [],
    balanceChecks,
    truncationSuspected,
    trancheLoansSkipped,
    loanSourceIds,
  };
}

/**
 * 存款查詢有失敗，而且沒有取得任何存款帳戶：整次同步應視為失敗。
 * 貸款與信用卡是附加資料，不能讓它們的成功蓋過存款完全沒有取得。
 */
export function chbDepositsUnavailable(data: ChbData, report: ChbSyncReport) {
  const failed = (
    ["twBalance", "twTransactions", "fcBalance", "fcTransactions"] as const
  ).some(
    (key) => report.counts[key].failed + report.counts[key].rowsRejected > 0,
  );
  return failed && !data.bankAccounts.some((a) => a.accountType === "savings");
}

/** `chb_sync_result` 記錄內容：只含筆數，不含帳號、金額或名稱。 */
export function summarizeChbResult(data: ChbData, report: ChbSyncReport) {
  const sum = (checks: ChbBalanceCheck[], key: "checked" | "mismatched") =>
    checks.reduce((total, check) => total + check[key], 0);
  const deposits = data.bankAccounts.filter((a) => a.accountType === "savings");
  const cardTransactions = data.bankTransactions.filter(
    (transaction) => transaction.accountId === CHB_CREDIT_ACCOUNT_ID,
  );
  return {
    status: report.failedCount > 0 ? "partial" : "complete",
    twAccounts: deposits.filter((a) => a.currency === "TWD").length,
    fcAccounts: deposits.filter((a) => a.currency !== "TWD").length,
    loans: data.bankAccounts.filter((a) => a.accountType === "loan").length,
    trancheLoansSkipped: data.trancheLoansSkipped,
    loansComplete: data.loanSourceIds !== undefined,
    cardBills: data.creditCardBills.length,
    cardTransactions: cardTransactions.length,
    transactions: data.bankTransactions.length - cardTransactions.length,
    twBalanceChecked: sum(data.balanceChecks.tw, "checked"),
    twBalanceMismatch: sum(data.balanceChecks.tw, "mismatched"),
    fcBalanceChecked: sum(data.balanceChecks.fc, "checked"),
    fcBalanceMismatch: sum(data.balanceChecks.fc, "mismatched"),
    truncationSuspected: data.truncationSuspected,
    failed: report.failedCount,
  };
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.sourceId)) return false;
    seen.add(record.sourceId);
    return true;
  });
}
