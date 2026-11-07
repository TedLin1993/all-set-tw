export type SinotradeHolding = {
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number;
  costBasis?: number;
  unrealizedPnl?: number;
  currency: "TWD" | "USD";
  market: "TW" | "US";
  positionType?: string;
};

/**
 * `Equity/UnRealPrtlos` 的請求內容，與官方頁面送出的欄位一致：`ttype` 必須是 `A`（全部），
 * 空字串會被官方以 400（fieldsError）拒絕。
 */
export function taiwanUnrealizedRequestBody(
  account: { brokerNo: string; brokerAccount: string },
  token: string,
) {
  return {
    action: "",
    bhno: account.brokerNo,
    cseq: account.brokerAccount,
    ctype: "A",
    stock: " ",
    ttype: "A",
    token,
  };
}

/** 純協定資料不完整或驗證失敗時使用固定訊息，避免把外部回應內容寫入錯誤。 */
export class SinotradeProtocolError extends Error {
  constructor() {
    super("永豐證券持倉回應格式錯誤");
    this.name = "SinotradeProtocolError";
  }
}

type SinotradeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SinotradeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(): never {
  throw new SinotradeProtocolError();
}

function stringField(record: SinotradeRecord, field: string): string {
  if (typeof record[field] !== "string") protocolError();
  return record[field] as string;
}

function nonEmptyStringField(record: SinotradeRecord, field: string): string {
  const value = stringField(record, field).trim();
  if (!value) protocolError();
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    protocolError();
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
      protocolError();
    }
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  protocolError();
}

function numberField(record: SinotradeRecord, field: string): number {
  return finiteNumber(record[field]);
}

function booleanField(record: SinotradeRecord, field: string): boolean {
  if (typeof record[field] !== "boolean") protocolError();
  return record[field] as boolean;
}

function isEmptyText(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  );
}

function isTaiwanAggregateRow(row: SinotradeRecord): boolean {
  if (!isEmptyText(row.stock)) return false;
  if (isEmptyText(row.stocknm)) return true;
  return typeof row.stocknm === "string" && row.stocknm.trim() === "合計";
}

/**
 * 解析新理財網 `Equity/UnRealPrtlos` 的台股回應。
 * 前端把最後一列當成合計列，因此只接受可辨識的末列合計，避免把缺資料當成空庫存。
 */
export function parseTaiwanUnrealizedResponse(
  payload: unknown,
): SinotradeHolding[] {
  if (!isRecord(payload) || payload.success !== "True") protocolError();

  const result = payload.result;
  if (!isRecord(result)) protocolError();
  const unrealSums = result.unreal_sums;
  if (!isRecord(unrealSums) || !Array.isArray(unrealSums.unreal_sum)) {
    protocolError();
  }

  const rows = unrealSums.unreal_sum as unknown[];
  if (rows.length === 0) return [];

  const total = rows[rows.length - 1];
  if (!isRecord(total) || !isTaiwanAggregateRow(total)) protocolError();

  const positionRows = rows.slice(0, -1);
  if (positionRows.some((row) => isRecord(row) && isTaiwanAggregateRow(row))) {
    protocolError();
  }

  return positionRows.map((row) => {
    if (!isRecord(row)) protocolError();
    const positionType = nonEmptyStringField(row, "ttypename");
    // `nowamt` 的負債／融資口徑尚未納入 portable contract，第一版只允許現股。
    if (positionType !== "現股") protocolError();
    return {
      symbol: nonEmptyStringField(row, "stock"),
      name: nonEmptyStringField(row, "stocknm"),
      quantity: numberField(row, "real_qty"),
      // 官方頁面「現值」欄位直接使用 nowamt；它可能已含預估費用／稅費口徑。
      marketValue: numberField(row, "nowamt"),
      costBasis: numberField(row, "cost"),
      unrealizedPnl: numberField(row, "unreal"),
      currency: "TWD",
      market: "TW",
      positionType,
    };
  });
}

function findJsonArrayEnd(source: string, start: number): number {
  if (source[start] !== "[") protocolError();

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "[" || character === "{") {
      stack.push(character);
    } else if (character === "]" || character === "}") {
      const opening = stack.pop();
      if (
        (character === "]" && opening !== "[") ||
        (character === "}" && opening !== "{")
      ) {
        protocolError();
      }
      if (stack.length === 0) return index + 1;
    }
  }

  protocolError();
}

function extractSavingsAssetDatas(html: string): unknown[] {
  const candidates: unknown[][] = [];
  for (const scriptMatch of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const script = scriptMatch[1];
    for (const assetMatch of script.matchAll(/\bassetDatas\s*:\s*/g)) {
      const assetStart = (assetMatch.index ?? -1) + assetMatch[0].length;
      const assetEnd = findJsonArrayEnd(script, assetStart);
      if (!/^\s*,\s*actype\s*:/.test(script.slice(assetEnd))) {
        protocolError();
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(script.slice(assetStart, assetEnd));
      } catch {
        protocolError();
      }
      if (!Array.isArray(parsed)) protocolError();
      candidates.push(parsed as unknown[]);
    }
  }

  if (candidates.length !== 1) protocolError();
  return candidates[0];
}

function savingsAssetTypes(
  value: unknown,
  market: "TW" | "US",
): string[] | null {
  if (market === "US") {
    if (value !== null) protocolError();
    return null;
  }
  // The page's category filter values: 0 is 現股, 1 is 融資, 2 is 融券.
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => item === "0")
  ) {
    protocolError();
  }
  return ["現股"];
}

export function parseSavingsAssetHtml(
  html: string,
  context: { market: "TW" | "US"; currency: "TWD" | "USD" },
): SinotradeHolding[] {
  if (typeof html !== "string") protocolError();
  if (
    !context ||
    !(
      (context.market === "TW" && context.currency === "TWD") ||
      (context.market === "US" && context.currency === "USD")
    )
  ) {
    protocolError();
  }

  const rows = extractSavingsAssetDatas(html);
  return rows.map((row) => {
    if (!isRecord(row)) protocolError();
    const assetTypes = savingsAssetTypes(row.AssetType, context.market);
    if (assetTypes?.some((type) => type !== "現股")) protocolError();
    // These fields are present in the Vue model and guard against parsing a different page.
    booleanField(row, "AgreedUnit");
    if (booleanField(row, "NeedReCalculate")) protocolError();
    if (
      row.AlreadyOpenDividendReinvest !== undefined &&
      typeof row.AlreadyOpenDividendReinvest !== "boolean"
    ) {
      protocolError();
    }

    return {
      symbol: nonEmptyStringField(row, "StockNum"),
      name: nonEmptyStringField(row, "StockName"),
      quantity: numberField(row, "InStock"),
      marketValue: numberField(row, "StockValue"),
      costBasis: numberField(row, "Cost"),
      unrealizedPnl: numberField(row, "ProfitAndLoss"),
      currency: context.currency,
      market: context.market,
      positionType:
        assetTypes && assetTypes.length > 0 ? assetTypes.join(",") : undefined,
    };
  });
}

function foreignCurrency(value: unknown): "TWD" | "USD" {
  if (typeof value !== "string") protocolError();
  const currency = value.trim().toUpperCase();
  if (currency !== "TWD" && currency !== "USD") protocolError();
  return currency;
}

/**
 * 解析 Divo `assets/querySubBrokerageUnrealizedPrtLos` 回應。
 * 非空欄位依官方海外庫存表的 `last_inv`、`amount_{curr}`、`cost_{curr}`、`pl_{curr}`。
 */
export function parseForeignUnrealizedResponse(
  payload: unknown,
): SinotradeHolding[] {
  if (!isRecord(payload) || payload.success !== true) protocolError();
  if (typeof payload.message !== "string") protocolError();

  const result = payload.result;
  if (!isRecord(result)) protocolError();
  if (stringField(result, "market").trim() !== "US") protocolError();
  if (!Array.isArray(result.data) || !Array.isArray(result.sum_data)) {
    protocolError();
  }

  const status = result.status;
  if (!isRecord(status) || status.success !== true) protocolError();
  if (typeof status.message !== "string" || typeof status.source !== "string") {
    protocolError();
  }

  return (result.data as unknown[]).map((row) => {
    if (!isRecord(row)) protocolError();
    if (stringField(row, "market").trim() !== "US") protocolError();

    const currency = foreignCurrency(row.curr);
    const suffix = currency.toLowerCase();
    // Validate the public table's common fields even though the portable contract keeps only the essentials.
    numberField(row, "ave_cost");
    numberField(row, "cost");
    numberField(row, "amount");
    numberField(row, "pl");
    numberField(row, "roi");

    return {
      symbol: nonEmptyStringField(row, "symbol"),
      name: nonEmptyStringField(row, "name"),
      quantity: numberField(row, "last_inv"),
      marketValue: numberField(row, `amount_${suffix}`),
      costBasis: numberField(row, `cost_${suffix}`),
      unrealizedPnl: numberField(row, `pl_${suffix}`),
      currency,
      market: "US",
    };
  });
}

/** 對帳單與豐存股成交紀錄正規化後的一筆交易。 */
export type SinotradeTrade = {
  /** 同一帳戶內的穩定識別：日期、標的、買賣、數量、價格；完全相同的列依出現順序補序號。 */
  key: string;
  symbol: string;
  name: string;
  /** YYYY-MM-DD。 */
  tradeDate: string;
  side: "B" | "S";
  quantity: number;
  price: number;
  /** 帶正負號的淨收付金額：買進為負、賣出為正，已含手續費與交易稅。 */
  amount: number;
  currency: "TWD" | "USD";
  market: "TW" | "US";
  fee: number;
  tax?: number;
  orderNo?: string;
  inventoryType?: string;
  /** 官方「已實現」損益（已扣費稅）；買進、尚未結算或官方沒有完整成本時留空。 */
  realizedPnl?: number;
  /** 官方記錄的賣出對應買進成本；沒有買進紀錄的持股（例如 ETF 募集取得）為 0 或負值。 */
  realizedCost?: number;
};

/**
 * 對帳單只提供近五年：從五年前的明天起算，避免被官方以超出範圍拒絕。
 * today 與回傳的 start／end 分別是 YYYY-MM-DD 與 YYYYMMDD。
 */
export function statementDateRange(today: string) {
  const [year, month, day] = today.split("-").map(Number);
  const start = new Date(Date.UTC(year! - 5, month! - 1, day! + 1));
  const compact = (value: string) => value.replaceAll("-", "");
  return {
    start: compact(start.toISOString().slice(0, 10)),
    end: compact(today),
  };
}

/** `Equity/ReconciliationStatement` 的請求內容，與官方「交易紀錄 → 對帳單」送出的欄位一致。 */
export function taiwanStatementRequestBody(
  account: { brokerNo: string; brokerAccount: string },
  token: string,
  range: { start: string; end: string },
) {
  return {
    account: account.brokerAccount,
    broker_id: account.brokerNo,
    bs: "",
    currency: "",
    end_date: range.end,
    start_date: range.start,
    stock_id: "",
    token,
    ttype: "",
  };
}

function calendarDate(value: string, separator: "" | "/"): string {
  const pattern =
    separator === ""
      ? /^(\d{4})(\d{2})(\d{2})$/
      : /^(\d{4})\/(\d{2})\/(\d{2})$/;
  const match = pattern.exec(value.trim());
  if (!match) protocolError();
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    protocolError();
  return `${year}-${month}-${day}`;
}

/** 完全相同的列（同日、同標的、同價量）依出現順序補序號，讓重複成交不互相覆蓋。 */
function uniqueTradeKeys<T extends { key: string }>(trades: T[]): T[] {
  const seen = new Map<string, number>();
  return trades.map((trade) => {
    const count = (seen.get(trade.key) ?? 0) + 1;
    seen.set(trade.key, count);
    return count === 1 ? trade : { ...trade, key: `${trade.key}#${count}` };
  });
}

const sumOf = (values: number[]) =>
  Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

/**
 * 解析新理財網 `Equity/ReconciliationStatement` 的台股對帳單。
 * `ttype` 1 是現股；其他交易別（融資、融券等）語意未確認，不猜測。
 * 官方的三個總計必須等於逐筆加總，避免把被截斷的回應當成完整紀錄。
 */
export function parseTaiwanStatementResponse(
  payload: unknown,
): SinotradeTrade[] {
  if (!isRecord(payload) || payload.success !== "True") protocolError();
  const result = payload.result;
  if (!isRecord(result)) protocolError();
  // 區間內沒有成交時，同一系列的 API 以「查無資料」回覆。
  if (result.data === undefined && result.msg === "查無資料") return [];
  if (!Array.isArray(result.data)) protocolError();

  const rows = (result.data as unknown[]).map((row) => {
    if (!isRecord(row)) protocolError();
    const rawSide = stringField(row, "bs");
    if (rawSide !== "B" && rawSide !== "S") protocolError();
    const side: "B" | "S" = rawSide === "B" ? "B" : "S";
    if (stringField(row, "ttype") !== "1") protocolError();
    if (stringField(row, "currency").trim() !== "TWD") protocolError();
    const quantity = numberField(row, "qty");
    const price = numberField(row, "price");
    const amount = numberField(row, "amt");
    const fee = numberField(row, "fee");
    const tax = numberField(row, "tax");
    const payable = numberField(row, "payable");
    const receivable = numberField(row, "receivable");
    if (quantity <= 0 || price <= 0 || amount <= 0) protocolError();
    if (fee < 0 || tax < 0 || payable < 0 || receivable < 0) protocolError();
    // 買進只有應付、賣出只有應收；兩邊都有或都沒有就是無法解讀。
    if (
      side === "B"
        ? payable <= 0 || receivable !== 0
        : receivable <= 0 || payable !== 0
    )
      protocolError();
    const symbol = nonEmptyStringField(row, "stock");
    const tradeDate = calendarDate(stringField(row, "tdate"), "");
    const orderNo = nonEmptyStringField(row, "ord_no");
    const name =
      typeof row.name_zh === "string" && row.name_zh.trim()
        ? row.name_zh.trim()
        : symbol;
    return {
      key: [tradeDate, orderNo, side, symbol, quantity, price].join(":"),
      symbol,
      name,
      tradeDate,
      side,
      quantity,
      price,
      amount: side === "B" ? -payable : receivable,
      currency: "TWD" as const,
      market: "TW" as const,
      fee,
      tax,
      orderNo,
      gross: amount,
      payable,
      receivable,
    };
  });

  if (
    sumOf(rows.map((row) => row.gross)) !==
      sumOf([numberField(result, "amt_sum")]) ||
    sumOf(rows.map((row) => row.payable)) !==
      sumOf([numberField(result, "payable_sum")]) ||
    sumOf(rows.map((row) => row.receivable)) !==
      sumOf([numberField(result, "receivable_sum")])
  )
    protocolError();

  return uniqueTradeKeys(
    rows.map(
      ({
        gross: _gross,
        payable: _payable,
        receivable: _receivable,
        ...trade
      }) => trade,
    ),
  );
}

/** 豐存股「成交」頁的表格：由頁面內的 DOM 取出的欄位標題與每列儲存格文字。 */
export type SavingsTransactionTable = { headers: string[]; rows: string[][] };

/** 官方「庫存損益 → 已實現」單次查詢的區間上限是 12 個月；保守取 350 天。 */
const REALIZED_WINDOW_DAYS = 350;

/**
 * 把賣出日期切成官方可接受的查詢區間，只涵蓋有賣出的日期，沒有賣出時不需查詢。
 * 輸入為 YYYY-MM-DD，回傳的 start／end 為 YYYYMMDD。
 */
export function realizedDateWindows(sellDates: string[]) {
  const days = [...new Set(sellDates)].sort();
  const compact = (value: string) => value.replaceAll("-", "");
  const windows: Array<{ start: string; end: string }> = [];
  let start: string | undefined;
  let end = "";
  for (const day of days) {
    if (
      start !== undefined &&
      Date.parse(day) - Date.parse(start) <= REALIZED_WINDOW_DAYS * 86_400_000
    ) {
      end = day;
      continue;
    }
    if (start !== undefined)
      windows.push({ start: compact(start), end: compact(end) });
    start = day;
    end = day;
  }
  if (start !== undefined)
    windows.push({ start: compact(start), end: compact(end) });
  return windows;
}

/** `Equity/RealPrtlosSum` 的請求內容，與官方「庫存損益 → 已實現」送出的欄位一致。 */
export function taiwanRealizedRequestBody(
  account: { brokerNo: string; brokerAccount: string },
  token: string,
  range: { start: string; end: string },
) {
  return {
    action: "0",
    bdate: range.start,
    bhno: account.brokerNo,
    cseq: account.brokerAccount,
    ctype: "A",
    edate: range.end,
    stock: "",
    token,
    ttype: "A",
  };
}

/** 官方「已實現」的一筆賣出；cost 是官方記錄的買進成本，profit 等於 proceeds 減 cost。 */
export type SinotradeRealizedRow = {
  tradeDate: string;
  orderNo: string;
  symbol: string;
  quantity: number;
  price: number;
  proceeds: number;
  cost: number;
  profit: number;
};

/**
 * 解析新理財網 `Equity/RealPrtlosSum`。`ttype` 0 是現股，其他交易別語意未確認，不猜測；
 * 每列必須滿足 profit = scost - bcost，且官方的合計列必須等於逐列加總。
 */
export function parseTaiwanRealizedResponse(
  payload: unknown,
): SinotradeRealizedRow[] {
  if (!isRecord(payload) || payload.success !== "True") protocolError();
  const result = payload.result;
  if (!isRecord(result)) protocolError();
  if (result.profit_sums === undefined && result.msg === "查無資料") return [];
  if (!isRecord(result.profit_sums)) protocolError();
  const entries = result.profit_sums.profit_sum;
  if (!Array.isArray(entries) || entries.length < 2) protocolError();

  const total = entries[entries.length - 1];
  if (!isRecord(total) || total.no !== "合計") protocolError();
  const rows = (entries.slice(0, -1) as unknown[]).map(
    (row): SinotradeRealizedRow => {
      if (!isRecord(row)) protocolError();
      if (stringField(row, "ttype") !== "0") protocolError();
      if (stringField(row, "currency").trim() !== "NTD") protocolError();
      const quantity = numberField(row, "cqty");
      const price = numberField(row, "price");
      const proceeds = numberField(row, "scost");
      const cost = numberField(row, "bcost");
      const profit = numberField(row, "profit");
      if (quantity <= 0 || price <= 0 || proceeds <= 0) protocolError();
      if (sumOf([proceeds - cost]) !== sumOf([profit])) protocolError();
      return {
        tradeDate: calendarDate(stringField(row, "tdate"), ""),
        orderNo: nonEmptyStringField(row, "dseq"),
        symbol: nonEmptyStringField(row, "stock"),
        quantity,
        price,
        proceeds,
        cost,
        profit,
      };
    },
  );
  if (
    sumOf(rows.map((row) => row.quantity)) !==
      sumOf([numberField(total, "cqty")]) ||
    sumOf(rows.map((row) => row.proceeds)) !==
      sumOf([numberField(total, "scost")]) ||
    sumOf(rows.map((row) => row.cost)) !==
      sumOf([numberField(total, "bcost")]) ||
    sumOf(rows.map((row) => row.profit)) !==
      sumOf([numberField(total, "profit")])
  )
    protocolError();
  return rows;
}

const realizedKey = (row: {
  tradeDate: string;
  orderNo?: string;
  symbol: string;
  price: number;
}) => [row.tradeDate, row.orderNo, row.symbol, row.price].join(":");

/**
 * 以日期、委託單號、標的與成交價把官方已實現損益對到對帳單的賣出，並確認數量與淨收入一致；
 * 對不上時視為無法解讀，不猜測。官方的買進成本不是正數（沒有買進紀錄的持股，例如 ETF 募集取得）
 * 時，profit 只是賣出收入，不是真正損益，所以不採用。
 * 同一委託單同價有多筆賣出時無法分配損益，一律留空。
 */
export function applyRealizedPnl(
  trades: SinotradeTrade[],
  rows: SinotradeRealizedRow[],
): SinotradeTrade[] {
  const groups = new Map<string, SinotradeRealizedRow[]>();
  for (const row of rows) {
    const key = realizedKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const sellCounts = new Map<string, number>();
  for (const trade of trades)
    if (trade.side === "S")
      sellCounts.set(
        realizedKey(trade),
        (sellCounts.get(realizedKey(trade)) ?? 0) + 1,
      );
  if ([...groups.keys()].some((key) => !sellCounts.has(key))) protocolError();

  return trades.map((trade) => {
    if (trade.side !== "S") return trade;
    const key = realizedKey(trade);
    const group = groups.get(key);
    if (!group || sellCounts.get(key) !== 1) return trade;
    if (
      sumOf(group.map((row) => row.quantity)) !== trade.quantity ||
      sumOf(group.map((row) => row.proceeds)) !== sumOf([trade.amount])
    )
      protocolError();
    const cost = sumOf(group.map((row) => row.cost));
    return {
      ...trade,
      realizedCost: cost,
      ...(cost > 0
        ? { realizedPnl: sumOf(group.map((row) => row.profit)) }
        : {}),
    };
  });
}

const SAVINGS_TRANSACTION_HEADERS: Array<[number, string]> = [
  [0, "成交日"],
  [1, "股票名稱"],
  [3, "成交股"],
  [4, "成交均價"],
  [5, "手續費"],
  [6, "投入成本"],
];

/**
 * 解析豐存股「成交」頁。此頁只呈現買進（成交股、均價、手續費、含手續費的投入成本），
 * 賣出的呈現方式尚未確認，所以數量或金額不是正數的列直接視為無法解讀，不猜測。
 * 沒有成交時頁面沒有成交表格，由呼叫端先確認頁面本身可辨識後傳入 null。
 */
export function parseSavingsTransactionTable(
  table: SavingsTransactionTable | null,
  context: { market: "TW" | "US"; currency: "TWD" | "USD" },
): SinotradeTrade[] {
  if (!(
    (context.market === "TW" && context.currency === "TWD") ||
    (context.market === "US" && context.currency === "USD")
  ))
    protocolError();
  if (table === null) return [];
  if (
    table.headers.length !== 10 ||
    SAVINGS_TRANSACTION_HEADERS.some(
      ([index, label]) => table.headers[index] !== label,
    )
  )
    protocolError();

  const trades = table.rows.map((cells) => {
    if (cells.length !== 10) protocolError();
    const tradeDate = calendarDate(cells[0]!, "/");
    const [symbol] = cells[1]!.trim().split(/\s+/);
    const name = cells[2]!.trim();
    // 代碼與名稱欄位必須互相吻合，欄位錯位時不會被誤認。
    if (!symbol || !name || cells[1]!.trim() !== `${symbol} ${name}`)
      protocolError();
    const quantity = finiteNumber(cells[3]);
    const price = finiteNumber(cells[4]);
    const fee = finiteNumber(cells[5]);
    const cost = finiteNumber(cells[6]);
    if (quantity <= 0 || price <= 0 || fee < 0 || cost <= 0) protocolError();
    // 均價與數量都是四捨五入後的顯示值，容許對應的誤差。
    if (Math.abs(quantity * price + fee - cost) > quantity * 0.006 + 0.05)
      protocolError();
    return {
      key: [tradeDate, "B", symbol, quantity, price].join(":"),
      symbol,
      name,
      tradeDate,
      side: "B" as const,
      quantity,
      price,
      amount: -cost,
      currency: context.currency,
      market: context.market,
      fee,
      ...(cells[9]!.trim() ? { inventoryType: cells[9]!.trim() } : {}),
    };
  });
  return uniqueTradeKeys(trades);
}
