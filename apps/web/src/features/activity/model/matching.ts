import type { BankTransactionRow } from "@/data/bank/types";
import type {
  InvoiceSummaryRow,
  InvoiceTransactionPreference,
} from "@/data/invoices/types";

const TAIPEI_DAY_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface InvoiceTransactionMatches {
  invoiceToTransactionId: Map<string, string>;
  transactionToInvoice: Map<string, InvoiceSummaryRow>;
}

const ESUN_LIFECYCLE_MARKER = /:(已入帳|未入帳):(?=\d+$)/u;

export function deduplicateBankTransactions(
  transactions: BankTransactionRow[],
): BankTransactionRow[] {
  const preferredByKey = new Map<
    string,
    { transaction: BankTransactionRow; priority: number }
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

export function matchInvoicesToTransactions(
  transactions: BankTransactionRow[],
  invoices: InvoiceSummaryRow[],
  preferences: InvoiceTransactionPreference[] = [],
): InvoiceTransactionMatches {
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const transactionById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  const invoiceToTransactionId = new Map<string, string>();
  const transactionToInvoice = new Map<string, InvoiceSummaryRow>();
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
  const autoTransactions = transactions.filter(
    (transaction) => !transactionToInvoice.has(transaction.id),
  );
  addAutomaticMatches(
    autoInvoices,
    autoTransactions,
    invoiceToTransactionId,
    transactionToInvoice,
  );

  return { invoiceToTransactionId, transactionToInvoice };
}

export function invoiceTransactionCandidates(
  transactions: BankTransactionRow[],
  invoice: InvoiceSummaryRow,
  unavailableTransactionIds: ReadonlySet<string> = new Set(),
) {
  return transactions
    .filter(
      (transaction) =>
        !unavailableTransactionIds.has(transaction.id) &&
        isSameDayTwdExpense(transaction, invoice),
    )
    .sort((left, right) => {
      const leftDifference = Math.abs(invoice.amount - Math.abs(left.amount));
      const rightDifference = Math.abs(invoice.amount - Math.abs(right.amount));
      return (
        leftDifference - rightDifference ||
        (left.counterparty ?? left.description ?? left.id).localeCompare(
          right.counterparty ?? right.description ?? right.id,
          "zh-TW",
        )
      );
    });
}

function addAutomaticMatches(
  invoices: InvoiceSummaryRow[],
  transactions: BankTransactionRow[],
  invoiceToTransactionId: Map<string, string>,
  transactionToInvoice: Map<string, InvoiceSummaryRow>,
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

function isSameDayTwdExpense(
  transaction: BankTransactionRow,
  invoice: InvoiceSummaryRow,
) {
  const transactionDate = expenseDay(transaction);
  const invoiceDate = dayNumber(invoice.invoiceDate);
  return invoiceDate != null && transactionDate === invoiceDate;
}

function expenseDay(transaction: BankTransactionRow) {
  if (
    transaction.amount === 0 ||
    (transaction.accountType !== "credit" && transaction.amount > 0) ||
    transaction.currency !== "TWD"
  )
    return undefined;
  return dayNumber(transaction.authorizedAt ?? transaction.postedDate);
}

function dayNumber(value?: string) {
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
