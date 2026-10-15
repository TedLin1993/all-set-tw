import type { BankTransaction } from "../financial-types";

/**
 * 樂天臺幣活存交易明細解析（`CTWQU0001/010` 當月、`CTWQU0001/011` 指定月份）。
 *
 * 輸入是網頁自己解密後的 `rsData`：
 * `{ display: {dataEnd, dataLimit, noData}, accounts: [{acctNo, balance}], queryAccountNo,
 *    txDetails: [{ sysDate: "YYYY/MM/DD", sysTime: "HH:MM", amtSign: boolean, amt: string,
 *                  memo, txDesc, nickNameOrAcct, acctNo（對手帳號）, bankId, balance（交易後餘額）,
 *                  pk（17 碼唯一碼）, ... }] }`
 *
 * 收支方向（重點）：`amt` 是無正負號的金額，`amtSign` 的布林語意（true 是收入還是支出）
 * 沒有文件保證，所以「不假設」，而是用資料本身判斷：
 * 1. 相鄰兩筆的交易後餘額差 `balance(新) - balance(舊)` 必須等於新那筆的 `amt`
 *    （容許 0.005），差值的正負就是那筆的方向（正＝收入）。排列順序（新→舊或舊→新）
 *    先看首尾的日期時間，日期相同時兩種都試，必須恰有一種完全吻合才採用。
 * 2. 每個月最舊的一筆沒有前一筆可比，改用同一次同步其他筆「餘額差與 amtSign 都能對到」
 *    所學到的 amtSign 對應（true＝收入或 true＝支出），而且全部證據必須一致；
 *    只要有互相矛盾的證據就視為 amtSign 不可信，不使用。
 * 3. 兩種方法都得不到方向時，整個月份略過（不猜方向、不寫入），只回報筆數。
 *
 * 不會拋錯：任何格式問題都只計入 stats，讓餘額照常同步。
 */

type JsonRecord = Record<string, unknown>;

export type RakutenTransactionDraft = Omit<
  BankTransaction,
  "id" | "connectorId"
>;

export type RakutenDepositAccountRef = {
  /** 存款帳戶的 sourceId（`bank:rakuten:<帳號>:TWD`）。 */
  sourceId: string;
  /** 存款帳號（只用於比對，不寫入交易）。 */
  accountNo: string;
};

/** 只有筆數與原因代碼，可安全寫入 log。 */
export type RakutenTransactionStats = {
  monthsProvided: number;
  monthsParsed: number;
  monthsSkipped: number;
  rowsParsed: number;
  rowsSkipped: number;
  /** display.dataEnd === false 或 dataLimit === true 的月份數（回傳資料可能被截斷）。 */
  monthsTruncated: number;
  directionByBalance: number;
  directionByAmtSign: number;
  /** 月份被略過的原因代碼 → 月數。 */
  skipReasons: Record<string, number>;
};

export type RakutenDepositTransactionResult = {
  transactions: RakutenTransactionDraft[];
  stats: RakutenTransactionStats;
};

/** description 附加備註的長度上限：超過就只留交易類型，避免把長段自由文字寫進描述。 */
export const RAKUTEN_MEMO_MAX_LENGTH = 30;

type ParsedRow = {
  date: string;
  time?: string;
  amount: number;
  balance?: number;
  amtSign?: boolean;
  pk?: string;
  txDesc: string;
  memo: string;
  counterpartyAcctNo: string;
  nickname: string;
  bankId: string;
};

type Direction = 1 | -1;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function comparableAccountNo(value: string): string {
  return value.replace(/[\s-]/g, "");
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\s,$]/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  const match = textOf(value).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return undefined;
  const [year, month, day] = [match[1]!, Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeTime(value: unknown): string | undefined {
  const match = textOf(value).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return undefined;
  const [hour, minute, second] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ];
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${match[2]}:${String(second).padStart(2, "0")}`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 32 位元雜湊在同一批明細裡撞號的機率極低，仍以正反兩向各算一次串成 64 位元。 */
function wideHash(input: string): string {
  return stableHash(input) + stableHash([...input].reverse().join(""));
}

function parseRow(value: unknown): ParsedRow | undefined {
  if (!isRecord(value)) return undefined;
  const date = normalizeDate(value.sysDate);
  const rawAmount = numberOf(value.amt);
  if (!date || rawAmount === undefined) return undefined;
  const amount = Math.abs(rawAmount);
  if (!(amount > 0)) return undefined;
  const pk = textOf(value.pk);
  return {
    date,
    time: normalizeTime(value.sysTime),
    amount,
    balance: numberOf(value.balance),
    amtSign: typeof value.amtSign === "boolean" ? value.amtSign : undefined,
    pk: pk || undefined,
    txDesc: textOf(value.txDesc),
    memo: textOf(value.memo).replace(/\s+/g, " "),
    counterpartyAcctNo: textOf(value.acctNo),
    nickname: textOf(value.nickNameOrAcct),
    bankId: textOf(value.bankId),
  };
}

function sortKey(row: ParsedRow): string {
  return `${row.date}T${row.time ?? "00:00:00"}`;
}

const BALANCE_TOLERANCE = 0.005;

type MonthDirections = {
  /** 以交易後餘額差確認的方向，索引與原始陣列相同。 */
  byBalance: Array<Direction | undefined>;
};

/**
 * 依相鄰兩筆的交易後餘額差推算方向（見檔頭說明）。回傳的陣列索引對應原始
 * `txDetails`；無法確認的筆數是 undefined。
 */
function deriveDirectionsByBalance(
  rows: ReadonlyArray<ParsedRow | undefined>,
): MonthDirections {
  const derive = (order: "newestFirst" | "oldestFirst") => {
    const directions: Array<Direction | undefined> = rows.map(() => undefined);
    let consistent = 0;
    let inconsistent = 0;
    for (let i = 0; i < rows.length - 1; i += 1) {
      // newestFirst：rows[i] 較新，前一筆是 rows[i + 1]；oldestFirst 相反
      const newerIndex = order === "newestFirst" ? i : i + 1;
      const olderIndex = order === "newestFirst" ? i + 1 : i;
      const newer = rows[newerIndex];
      const older = rows[olderIndex];
      if (
        !newer ||
        !older ||
        newer.balance === undefined ||
        older.balance === undefined
      ) {
        continue;
      }
      const delta = newer.balance - older.balance;
      if (Math.abs(Math.abs(delta) - newer.amount) <= BALANCE_TOLERANCE) {
        consistent += 1;
        directions[newerIndex] = delta > 0 ? 1 : -1;
      } else {
        inconsistent += 1;
      }
    }
    return { directions, consistent, inconsistent };
  };

  const parsed = rows.filter((row): row is ParsedRow => row !== undefined);
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  let hint: "newestFirst" | "oldestFirst" | undefined;
  if (first && last) {
    const a = sortKey(first);
    const b = sortKey(last);
    if (a > b) hint = "newestFirst";
    else if (a < b) hint = "oldestFirst";
  }

  if (hint) return { byBalance: derive(hint).directions };

  // 首尾時間相同：兩種排列都試，必須恰有一種完全吻合
  const desc = derive("newestFirst");
  const asc = derive("oldestFirst");
  const descOk = desc.consistent > 0 && desc.inconsistent === 0;
  const ascOk = asc.consistent > 0 && asc.inconsistent === 0;
  if (descOk && !ascOk) return { byBalance: desc.directions };
  if (ascOk && !descOk) return { byBalance: asc.directions };
  return { byBalance: rows.map(() => undefined) };
}

type MonthDraft = {
  accountSourceId: string;
  accountNo: string;
  rows: Array<ParsedRow | undefined>;
  rowsSkipped: number;
  byBalance: Array<Direction | undefined>;
};

type AmtSignMapping = { trueMeans: Direction };

/**
 * 用「餘額差已確認方向」的筆數學習 amtSign 對應；證據必須完全一致才回傳。
 */
function learnAmtSignMapping(
  months: readonly MonthDraft[],
): AmtSignMapping | undefined {
  let trueIsCredit = 0;
  let trueIsDebit = 0;
  for (const month of months) {
    month.rows.forEach((row, index) => {
      const direction = month.byBalance[index];
      if (!row || direction === undefined || row.amtSign === undefined) return;
      const trueMeans: Direction = row.amtSign
        ? direction
        : (-direction as Direction);
      if (trueMeans === 1) trueIsCredit += 1;
      else trueIsDebit += 1;
    });
  }
  if (trueIsCredit > 0 && trueIsDebit === 0) return { trueMeans: 1 };
  if (trueIsDebit > 0 && trueIsCredit === 0) return { trueMeans: -1 };
  return undefined;
}

function counterpartyOf(
  row: ParsedRow,
  ownAccountNo: string,
): string | undefined {
  const acctDigits = row.counterpartyAcctNo.replace(/\D/g, "");
  const ownDigits = ownAccountNo.replace(/\D/g, "");
  const nicknameIsNumber = /^[\d\s-]+$/.test(row.nickname);
  // 暱稱不是數字（約定帳號別名）時直接用暱稱，永遠不輸出完整帳號
  if (row.nickname && !nicknameIsNumber) return row.nickname;
  if (acctDigits.length >= 4 && acctDigits !== ownDigits) {
    return `****${acctDigits.slice(-4)}`;
  }
  return undefined;
}

function descriptionOf(row: ParsedRow): string {
  const base = row.txDesc || "樂天銀行交易";
  // 備註常是轉帳留言或自由文字：夠短才附在交易類型後面，
  // 交易類型仍維持在描述開頭，方便日後以類型辨識
  if (row.memo && row.memo.length <= RAKUTEN_MEMO_MAX_LENGTH) {
    return `${base} · ${row.memo}`;
  }
  return base;
}

function toTransaction(
  row: ParsedRow,
  direction: Direction,
  source: "balance" | "amtSign",
  month: MonthDraft,
): RakutenTransactionDraft {
  const identity = row.pk
    ? `pk:${row.pk}`
    : `fb:${[
        row.date,
        row.time ?? "",
        row.amount,
        row.txDesc,
        row.balance ?? "",
      ].join("|")}`;
  return {
    accountId: month.accountSourceId,
    sourceId: `rakuten:deposit:tx:${wideHash(identity)}`,
    // 台北日期；時間已知時才提供帶 +08:00 的 authorizedAt
    postedDate: row.date,
    authorizedAt: row.time ? `${row.date}T${row.time}+08:00` : row.date,
    amount: direction * row.amount,
    currency: "TWD",
    description: descriptionOf(row),
    counterparty: counterpartyOf(row, month.accountNo),
    status: "posted",
    raw: {
      txDesc: row.txDesc || undefined,
      balanceAfter: row.balance,
      bankId: row.bankId || undefined,
      directionSource: source,
    },
  };
}

function emptyStats(monthsProvided: number): RakutenTransactionStats {
  return {
    monthsProvided,
    monthsParsed: 0,
    monthsSkipped: 0,
    rowsParsed: 0,
    rowsSkipped: 0,
    monthsTruncated: 0,
    directionByBalance: 0,
    directionByAmtSign: 0,
    skipReasons: {},
  };
}

/**
 * 解析多個月份的臺幣活存明細（每個元素是一個月的 rsData）。
 * 同一筆（sourceId 相同）只留第一筆。
 */
export function parseRakutenDepositTransactions(
  payloads: readonly unknown[],
  deposits: readonly RakutenDepositAccountRef[],
): RakutenDepositTransactionResult {
  const stats = emptyStats(payloads.length);
  const skipMonth = (reason: string) => {
    stats.monthsSkipped += 1;
    stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1;
  };

  const months: MonthDraft[] = [];
  for (const payload of payloads) {
    if (!isRecord(payload)) {
      skipMonth("invalid_payload");
      continue;
    }
    const display = isRecord(payload.display) ? payload.display : {};
    const firstAccount = Array.isArray(payload.accounts)
      ? payload.accounts.find(isRecord)
      : undefined;
    const queryNo = comparableAccountNo(
      textOf(payload.queryAccountNo) || textOf(firstAccount?.acctNo),
    );
    const account = queryNo
      ? deposits.find(
          (deposit) => comparableAccountNo(deposit.accountNo) === queryNo,
        )
      : deposits.length === 1
        ? deposits[0]
        : undefined;
    if (!account) {
      skipMonth("account_mismatch");
      continue;
    }
    const details = payload.txDetails;
    if (details === undefined || details === null) {
      if (display.noData === true) {
        stats.monthsParsed += 1;
        continue;
      }
      skipMonth("invalid_payload");
      continue;
    }
    if (!Array.isArray(details)) {
      skipMonth("invalid_payload");
      continue;
    }
    // 沒有交易的月份（例如開戶前）銀行也會帶 dataEnd: false，不算截斷
    if (
      display.noData !== true &&
      details.length > 0 &&
      (display.dataEnd === false || display.dataLimit === true)
    ) {
      stats.monthsTruncated += 1;
    }
    const rows = details.map(parseRow);
    const rowsSkipped = rows.filter((row) => row === undefined).length;
    months.push({
      accountSourceId: account.sourceId,
      accountNo: account.accountNo,
      rows,
      rowsSkipped,
      byBalance: deriveDirectionsByBalance(rows).byBalance,
    });
  }

  const mapping = learnAmtSignMapping(months);
  const transactions: RakutenTransactionDraft[] = [];
  const seen = new Set<string>();

  for (const month of months) {
    const resolved: Array<{
      row: ParsedRow;
      direction: Direction;
      source: "balance" | "amtSign";
    }> = [];
    let undetermined = false;
    month.rows.forEach((row, index) => {
      if (!row) return;
      const byBalance = month.byBalance[index];
      if (byBalance !== undefined) {
        resolved.push({ row, direction: byBalance, source: "balance" });
      } else if (mapping && row.amtSign !== undefined) {
        resolved.push({
          row,
          direction: row.amtSign
            ? mapping.trueMeans
            : (-mapping.trueMeans as Direction),
          source: "amtSign",
        });
      } else {
        undetermined = true;
      }
    });
    if (undetermined) {
      // 方向無法確認就整月不寫入，寧可缺資料也不寫錯正負號
      skipMonth("direction_unknown");
      continue;
    }
    stats.monthsParsed += 1;
    stats.rowsSkipped += month.rowsSkipped;
    for (const { row, direction, source } of resolved) {
      const transaction = toTransaction(row, direction, source, month);
      if (seen.has(transaction.sourceId)) continue;
      seen.add(transaction.sourceId);
      transactions.push(transaction);
      stats.rowsParsed += 1;
      if (source === "balance") stats.directionByBalance += 1;
      else stats.directionByAmtSign += 1;
    }
  }

  return { transactions, stats };
}
