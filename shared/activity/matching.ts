import { MANUAL_CONNECTOR_ID } from "../api/manual-transactions";

export interface MatchingTransaction {
  id: string;
  connectorId: string;
  sourceId: string;
  accountType?: string | null;
  amount: number;
  currency: string;
  authorizedAt?: string | null;
  postedDate?: string | null;
  counterparty?: string | null;
  description?: string | null;
  excludedFromCalculation?: boolean;
}
export interface MatchingInvoice {
  id: string;
  invoiceDate: string;
  amount: number;
}
export interface InvoiceTransactionPreference {
  updatedAt: string;
  invoiceId: string;
  transactionId: string | null;
  decision: "linked" | "separate";
}
type ExpenseDayTransaction = Pick<
  MatchingTransaction,
  "amount" | "currency" | "accountType" | "authorizedAt" | "postedDate"
>;
/** 手動配對時，扣款可晚於發票日的最多天數（金融卡等可能延後扣款）。 */
export const MANUAL_INVOICE_MATCH_MAX_DAYS = 45;
/** 手動配對時，刷卡可早於發票日的最多天數（網購等出貨後才開立發票）。 */
export const MANUAL_INVOICE_MATCH_MAX_EARLY_DAYS = 14;
const TAIPEI_DAY_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface InvoiceTransactionMatches<
  I extends MatchingInvoice = MatchingInvoice,
> {
  invoiceToTransactionId: Map<string, string>;
  transactionToInvoice: Map<string, I>;
}

const ESUN_LIFECYCLE_MARKER = /:(已入帳|未入帳):(?=\d+$)/u;

export function deduplicateBankTransactions<T extends MatchingTransaction>(
  transactions: T[],
): T[] {
  const preferredByKey = new Map<
    string,
    { transaction: T; priority: number }
  >();

  for (const transaction of transactions) {
    if (transaction.connectorId !== "esun") continue;
    const lifecycle = transaction.sourceId.match(ESUN_LIFECYCLE_MARKER)?.[1];
    const key = transaction.sourceId.replace(ESUN_LIFECYCLE_MARKER, ":");
    const priority = lifecycle == null ? 2 : lifecycle === "已入帳" ? 1 : 0;
    const current = preferredByKey.get(key);
    if (!current || priority > current.priority)
      preferredByKey.set(key, { transaction, priority });
  }

  const preferredIds = new Set(
    Array.from(preferredByKey.values(), ({ transaction }) => transaction.id),
  );
  return transactions.filter(
    (transaction) =>
      transaction.connectorId !== "esun" || preferredIds.has(transaction.id),
  );
}

export function matchInvoicesToTransactions<I extends MatchingInvoice>(
  transactions: MatchingTransaction[],
  invoices: I[],
  preferences: InvoiceTransactionPreference[] = [],
): InvoiceTransactionMatches<I> {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const invoiceToTransactionId = new Map<string, string>();
  const transactionToInvoice = new Map<string, I>();
  const separateInvoiceIds = new Set(
    preferences
      .filter(({ decision }) => decision === "separate")
      .map(({ invoiceId }) => invoiceId),
  );

  for (const preference of preferences) {
    if (preference.decision !== "linked" || !preference.transactionId) continue;
    const invoice = invoiceById.get(preference.invoiceId);
    const transaction = transactionById.get(preference.transactionId);
    if (!invoice || !transaction || transactionToInvoice.has(transaction.id))
      continue;
    invoiceToTransactionId.set(invoice.id, transaction.id);
    transactionToInvoice.set(transaction.id, invoice);
  }

  const autoInvoices = invoices.filter(
    (invoice) =>
      !separateInvoiceIds.has(invoice.id) &&
      !invoiceToTransactionId.has(invoice.id),
  );
  // 手動記錄的現金移動與餘額調整不是消費；自動配到發票會讓那筆發票跟著排除統計。
  const autoTransactions = transactions.filter(
    (transaction) =>
      !transactionToInvoice.has(transaction.id) &&
      !(
        transaction.connectorId === MANUAL_CONNECTOR_ID &&
        transaction.excludedFromCalculation
      ),
  );
  addAutomaticMatches(
    autoInvoices,
    autoTransactions,
    invoiceToTransactionId,
    transactionToInvoice,
  );

  return { invoiceToTransactionId, transactionToInvoice };
}

export function invoiceTransactionCandidates<T extends MatchingTransaction>(
  transactions: T[],
  invoice: MatchingInvoice,
  unavailableTransactionIds: ReadonlySet<string> = new Set(),
) {
  return transactions
    .filter(
      (transaction) =>
        !unavailableTransactionIds.has(transaction.id) &&
        isManualInvoiceMatchCandidate(transaction, invoice),
    )
    .sort((left, right) => {
      const leftDifference = Math.abs(invoice.amount - Math.abs(left.amount));
      const rightDifference = Math.abs(invoice.amount - Math.abs(right.amount));
      return (
        Math.abs(invoiceTransactionDayGap(left, invoice)!) -
          Math.abs(invoiceTransactionDayGap(right, invoice)!) ||
        leftDifference - rightDifference ||
        (left.counterparty ?? left.description ?? left.id).localeCompare(
          right.counterparty ?? right.description ?? right.id,
          "zh-TW",
        )
      );
    });
}

/**
 * 台幣支出交易晚於發票日的天數（台北日期，早於發票日為負數）；非台幣支出或日期不明時為 undefined。
 */
export function invoiceTransactionDayGap(
  transaction: ExpenseDayTransaction,
  invoice: Pick<MatchingInvoice, "invoiceDate">,
) {
  const transactionDay = expenseDay(transaction);
  const invoiceDay = dayNumber(invoice.invoiceDate);
  return transactionDay == null || invoiceDay == null
    ? undefined
    : transactionDay - invoiceDay;
}

/**
 * 手動配對接受發票日當天的台幣支出（金額可因折抵不同），
 * 或發票日前 MANUAL_INVOICE_MATCH_MAX_EARLY_DAYS 天到其後 MANUAL_INVOICE_MATCH_MAX_DAYS 天內
 * 金額完全相同的台幣支出。
 */
export function isManualInvoiceMatchCandidate(
  transaction: ExpenseDayTransaction,
  invoice: Pick<MatchingInvoice, "invoiceDate" | "amount">,
) {
  const gap = invoiceTransactionDayGap(transaction, invoice);
  if (gap === 0) return true;
  return (
    gap != null &&
    gap >= -MANUAL_INVOICE_MATCH_MAX_EARLY_DAYS &&
    gap <= MANUAL_INVOICE_MATCH_MAX_DAYS &&
    Math.abs(transaction.amount) === invoice.amount
  );
}

function addAutomaticMatches<I extends MatchingInvoice>(
  invoices: I[],
  transactions: MatchingTransaction[],
  invoiceToTransactionId: Map<string, string>,
  transactionToInvoice: Map<string, I>,
) {
  const invoicesByKey = groupByMatchKey(invoices, (invoice) => {
    const invoiceDay = dayNumber(invoice.invoiceDate);
    return invoiceDay == null ? undefined : `${invoiceDay}:${invoice.amount}`;
  });
  const transactionsByKey = groupByMatchKey(transactions, (transaction) => {
    const transactionDay = expenseDay(transaction);
    return transactionDay == null
      ? undefined
      : `${transactionDay}:${Math.abs(transaction.amount)}`;
  });

  for (const [key, matchingInvoices] of invoicesByKey) {
    const matchingTransactions = transactionsByKey.get(key);
    if (!matchingTransactions) continue;
    matchingInvoices.sort(compareById);
    matchingTransactions.sort(compareById);
    const pairCount = Math.min(
      matchingInvoices.length,
      matchingTransactions.length,
    );
    for (let index = 0; index < pairCount; index += 1) {
      const invoice = matchingInvoices[index];
      const transaction = matchingTransactions[index];
      invoiceToTransactionId.set(invoice.id, transaction.id);
      transactionToInvoice.set(transaction.id, invoice);
    }
  }
}

/** 交割扣款可晚於成交日的最多天數：台股 T+2 個營業日，加上週末與連假的緩衝。 */
export const TRADE_SETTLEMENT_MAX_DAYS = 7;

export interface SettlementTrade {
  id: string;
  /** 成交日，YYYY-MM-DD 開頭。 */
  date: string;
  /** 帶正負號、含費稅的淨收付金額；來源沒有提供時不配對。 */
  amount?: number | null;
  currency: string;
}

/**
 * 把證券成交配到銀行帳戶上的交割款：同幣別、金額（含正負號）完全相同，且入帳日在成交日
 * 當天到其後 TRADE_SETTLEMENT_MAX_DAYS 天內。一筆交割款只配一筆成交，同條件多筆時取最接近
 * 成交日的那筆；同日多筆成交合併成一筆交割款時金額對不上，不猜測配對。
 * 信用卡與手動記錄不是交割帳戶，不參與。回傳銀行交易 id → 成交 id。
 */
export function matchTradesToSettlements(
  transactions: MatchingTransaction[],
  trades: SettlementTrade[],
) {
  const candidates = transactions
    .filter(
      (transaction) =>
        transaction.accountType !== "credit" &&
        transaction.connectorId !== MANUAL_CONNECTOR_ID,
    )
    .map((transaction) => ({
      transaction,
      // 交割以入帳日為準；授權時間可能早於成交日（例如預先圈存）。
      day:
        dateOnlyNumber(transaction.postedDate) ??
        dayNumber(transaction.authorizedAt),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { day: number } =>
        candidate.day != null,
    );
  const settlementToTrade = new Map<string, string>();
  const datedTrades = trades
    .map((trade) => ({ trade, day: dateOnlyNumber(trade.date) }))
    .filter(
      (entry): entry is typeof entry & { day: number } =>
        entry.day != null &&
        entry.trade.amount != null &&
        entry.trade.amount !== 0,
    )
    .sort(
      (left, right) =>
        left.day - right.day || compareById(left.trade, right.trade),
    );
  for (const { trade, day } of datedTrades) {
    const settlement = candidates
      .filter(
        (candidate) =>
          !settlementToTrade.has(candidate.transaction.id) &&
          candidate.transaction.currency === trade.currency &&
          candidate.transaction.amount === trade.amount &&
          candidate.day >= day &&
          candidate.day - day <= TRADE_SETTLEMENT_MAX_DAYS,
      )
      .sort(
        (left, right) =>
          left.day - right.day ||
          compareById(left.transaction, right.transaction),
      )[0];
    if (settlement) settlementToTrade.set(settlement.transaction.id, trade.id);
  }
  return settlementToTrade;
}

function expenseDay(transaction: ExpenseDayTransaction) {
  if (
    transaction.amount === 0 ||
    (transaction.accountType !== "credit" && transaction.amount > 0) ||
    transaction.currency !== "TWD"
  )
    return undefined;
  return transaction.authorizedAt
    ? dayNumber(transaction.authorizedAt)
    : dateOnlyNumber(transaction.postedDate);
}

function dayNumber(value?: string | null) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = Object.fromEntries(
      TAIPEI_DAY_FORMATTER.formatToParts(parsed).map(({ type, value }) => [
        type,
        value,
      ]),
    );
    return (
      Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) /
      86_400_000
    );
  }
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
    86_400_000
  );
}

function dateOnlyNumber(value?: string | null) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  return (
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
    86_400_000
  );
}

function groupByMatchKey<T>(
  items: T[],
  keyFor: (item: T) => string | undefined,
) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (key == null) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function compareById(left: { id: string }, right: { id: string }) {
  return left.id.localeCompare(right.id);
}
