import type { BankTransactionRow } from "@/data/bank/types";
import type {
  InvoiceSummaryRow,
  InvoiceTransactionPreference,
} from "@/data/invoices/types";

const MERCHANT_ENTITY_MARKERS = [
  "股份有限公司",
  "有限責任公司",
  "有限公司",
  "股份",
  "公司",
];
const MERCHANT_BRANCH_SUFFIXES = ["分公司", "門市"];
const LINE_PAY_PREFIXES = ["連加", "連支", "linepay"];
const PAYMENT_PROCESSOR_PREFIXES = ["全支付", ...LINE_PAY_PREFIXES];
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

type MatchCandidate = {
  invoice: InvoiceSummaryRow;
  transaction: BankTransactionRow;
  kind: "exact" | "payment-points";
};

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
  const allStrongCandidates = autoInvoices.flatMap((invoice) =>
    autoTransactions
      .map((transaction) => ({
        invoice,
        transaction,
        kind: matchCandidateKind(transaction, invoice),
      }))
      .filter(
        (candidate): candidate is MatchCandidate => candidate.kind != null,
      ),
  );
  const exactInvoiceIds = new Set(
    allStrongCandidates
      .filter(({ kind }) => kind === "exact")
      .map(({ invoice }) => invoice.id),
  );
  const exactTransactionIds = new Set(
    allStrongCandidates
      .filter(({ kind }) => kind === "exact")
      .map(({ transaction }) => transaction.id),
  );
  const strongCandidates = allStrongCandidates.filter(
    ({ invoice, transaction, kind }) =>
      kind === "exact" ||
      (!exactInvoiceIds.has(invoice.id) &&
        !exactTransactionIds.has(transaction.id)),
  );
  addUniqueMatches(
    strongCandidates,
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

function addUniqueMatches(
  candidates: MatchCandidate[],
  invoiceToTransactionId: Map<string, string>,
  transactionToInvoice: Map<string, InvoiceSummaryRow>,
) {
  const invoiceCandidateCount = countBy(
    candidates,
    ({ invoice }) => invoice.id,
  );
  const transactionCandidateCount = countBy(
    candidates,
    ({ transaction }) => transaction.id,
  );

  for (const { invoice, transaction } of candidates) {
    if (
      invoiceCandidateCount.get(invoice.id) !== 1 ||
      transactionCandidateCount.get(transaction.id) !== 1
    )
      continue;
    invoiceToTransactionId.set(invoice.id, transaction.id);
    transactionToInvoice.set(transaction.id, invoice);
  }
}

function matchCandidateKind(
  transaction: BankTransactionRow,
  invoice: InvoiceSummaryRow,
): MatchCandidate["kind"] | undefined {
  if (!isSameDayTwdExpense(transaction, invoice)) return undefined;

  const merchants = [transaction.counterparty, transaction.description];
  if (
    !merchants.some((merchant) =>
      merchantNamesMatch(invoice.sellerName, merchant),
    )
  )
    return undefined;

  const chargedAmount = Math.abs(transaction.amount);
  if (chargedAmount === invoice.amount) return "exact";
  if (
    transaction.accountType === "credit" &&
    chargedAmount < invoice.amount &&
    merchants.some(isPaymentProcessorMerchant)
  )
    return "payment-points";
  return undefined;
}

function isSameDayTwdExpense(
  transaction: BankTransactionRow,
  invoice: InvoiceSummaryRow,
) {
  if (
    transaction.amount === 0 ||
    (transaction.accountType !== "credit" && transaction.amount > 0) ||
    transaction.currency !== "TWD"
  )
    return false;

  const transactionDate = dayNumber(
    transaction.authorizedAt ?? transaction.postedDate,
  );
  const invoiceDate = dayNumber(invoice.invoiceDate);
  return invoiceDate != null && transactionDate === invoiceDate;
}

function isPaymentProcessorMerchant(value?: string) {
  const normalized = normalizeMerchantName(value);
  return PAYMENT_PROCESSOR_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function merchantNamesMatch(left?: string, right?: string) {
  const normalizedLeft = normalizeMerchantName(left);
  const normalizedRight = stripPaymentProcessorPrefix(
    normalizeMerchantName(right),
  );
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const shorter =
    normalizedLeft.length <= normalizedRight.length
      ? normalizedLeft
      : normalizedRight;
  const longer =
    normalizedLeft.length > normalizedRight.length
      ? normalizedLeft
      : normalizedRight;
  const isContainedName =
    (shorter.length >= 4 || isShortCjkBrand(shorter)) &&
    longer.includes(shorter);
  return isContainedName || hasHighCjkSubsequenceOverlap(shorter, longer);
}

function normalizeMerchantName(value?: string) {
  let normalized = (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  for (const marker of MERCHANT_ENTITY_MARKERS)
    normalized = normalized.replaceAll(marker, "");
  let removedSuffix = true;
  while (removedSuffix) {
    removedSuffix = false;
    for (const suffix of MERCHANT_BRANCH_SUFFIXES) {
      if (!normalized.endsWith(suffix)) continue;
      normalized = normalized.slice(0, -suffix.length);
      removedSuffix = true;
      break;
    }
  }
  return normalized;
}

function stripPaymentProcessorPrefix(value: string) {
  for (const prefix of PAYMENT_PROCESSOR_PREFIXES) {
    if (value.startsWith(prefix) && value.length - prefix.length >= 2)
      return value.slice(prefix.length);
  }
  return value;
}

function isShortCjkBrand(value: string) {
  return value.length >= 2 && /^[\p{Script=Han}]+$/u.test(value);
}

function hasHighCjkSubsequenceOverlap(shorter: string, longer: string) {
  if (
    shorter.length < 4 ||
    shorter.length / longer.length < 0.75 ||
    !isShortCjkBrand(shorter) ||
    !isShortCjkBrand(longer)
  )
    return false;

  let shorterIndex = 0;
  for (const character of longer) {
    if (character === shorter[shorterIndex]) shorterIndex += 1;
  }
  return shorterIndex === shorter.length;
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

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
