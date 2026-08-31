import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "@taiwan-fin-hub/core";
import forge from "node-forge";
import { z } from "zod";

/** 第一銀行網路銀行瀏覽器工作階段設定；機密欄位由 Worker 加密保存。 */
export const firstbankConfigSchema = z.object({
  userId: z.string().min(1).max(32).optional(),
  account: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(128).optional(),
  sessionCookies: z
    .string()
    .max(64 * 1024)
    .optional(),
  sessionCreatedAt: z.string().optional(),
  browserSessionId: z.string().max(256).optional(),
  browserSessionExpiresAt: z.string().optional(),
  captchaDigitCount: z.number().int().min(4).max(8).optional(),
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4,8}$/)
    .optional(),
});

export type FirstbankConfig = z.infer<typeof firstbankConfigSchema>;

export function parseFirstbankConfig(config: unknown): FirstbankConfig {
  return firstbankConfigSchema.parse(config);
}

/** 第一銀行網路銀行工作階段擷取的資料。 */
export type FirstbankPayloads = {
  depositOverviewHtml?: string;
  transactionHistoryHtml?: string;
  cardBill?: unknown;
  cardUnbilled?: unknown;
  recentPayments?: unknown;
};

export type FirstbankData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;
type HtmlRow = { attrs: string; cells: string[] };
const TWD = "TWD";

const SUPPORTED_CURRENCIES = new Set([
  "AED",
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "IDR",
  "INR",
  "JPY",
  "KRW",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "TWD",
  "USD",
  "VND",
  "ZAR",
]);

/** Provider HTML/JSON 變動時不得猜測欄位，交由同步流程顯示可重試的協定錯誤。 */
export class FirstbankProtocolError extends Error {
  constructor(message = "第一銀行回應格式已變更，暫時無法同步。") {
    super(message);
    this.name = "FirstbankProtocolError";
  }
}

type DepositAccount = {
  sourceId: string;
  accountKey: string;
  accountLast4?: string;
  accountName?: string;
  accountType: BankAccount["accountType"];
  currency: string;
  balance: number;
  availableBalance?: number;
};

type DepositParseResult = {
  accounts: DepositAccount[];
  bankAccounts: FirstbankData["bankAccounts"];
  snapshots: FirstbankData["bankBalanceSnapshots"];
};

type DepositHeader = {
  accountType?: number;
  account: number;
  currency: number;
  balance: number;
  availableBalance?: number;
};

type TransactionHeader = {
  date: number;
  debit?: number;
  credit?: number;
  amount?: number;
  balance?: number;
  currency?: number;
  type?: number;
  status?: number;
  memo?: number;
  summary?: number;
};

/**
 * 將第一銀行瀏覽器頁面與信用卡查詢回應轉成 core 的中立資料。
 *
 * HTML 只解析已知的 ResultHeader/ResultContent 表格；信用卡 JSON 僅接受
 * CMSQRY0014、CMSQRY0008、CMSQRY0006 的 CONTENT 結構。任何非空但無法
 * 識別的 payload 都會丟出 FirstbankProtocolError，避免把錯誤頁當成零資料。
 */
export function parseFirstbankData(
  payloads: FirstbankPayloads,
  now = new Date(),
): FirstbankData {
  if (!isRecord(payloads)) {
    throw new FirstbankProtocolError("第一銀行擷取資料格式已變更。");
  }
  const asOfAt = now.toISOString();
  const deposits = payloads.depositOverviewHtml
    ? parseDepositOverviewHtml(payloads.depositOverviewHtml, asOfAt)
    : emptyDepositParse();
  const bankTransactions = payloads.transactionHistoryHtml
    ? parseTransactionHistoryHtml(
        payloads.transactionHistoryHtml,
        deposits.accounts,
      )
    : [];
  const cards = parseCreditCards(
    payloads.cardBill,
    payloads.cardUnbilled,
    payloads.recentPayments,
    asOfAt,
  );
  return {
    bankAccounts: dedupeBySourceId([
      ...deposits.bankAccounts,
      ...cards.bankAccounts,
    ]),
    bankBalanceSnapshots: dedupeBySourceId([
      ...deposits.snapshots,
      ...cards.snapshots,
    ]),
    bankTransactions: dedupeBySourceId([
      ...bankTransactions,
      ...cards.transactions,
    ]),
    creditCardBills: dedupeBySourceId(cards.bills),
  };
}

function emptyDepositParse(): DepositParseResult {
  return { accounts: [], bankAccounts: [], snapshots: [] };
}

function parseDepositOverviewHtml(
  html: unknown,
  asOfAt: string,
): DepositParseResult {
  if (typeof html !== "string") {
    throw new FirstbankProtocolError("第一銀行存款總覽格式已變更。");
  }
  if (!html.trim()) return emptyDepositParse();
  const rows = extractHtmlRows(html);
  const pageText = stripTags(html);
  const headers = rows
    .map((row, index) => {
      const header = parseDepositHeader(row.cells);
      return header ? { index, header } : undefined;
    })
    .filter(
      (entry): entry is { index: number; header: DepositHeader } =>
        entry !== undefined,
    );
  if (headers.length === 0) {
    if (isNoDataText(pageText)) return emptyDepositParse();
    throw new FirstbankProtocolError("第一銀行存款總覽表頭格式已變更。");
  }

  const accounts: DepositAccount[] = [];
  let sawResultRow = false;
  let sawCandidate = false;
  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const current = headers[headerIndex];
    if (!current) continue;
    const end = headers[headerIndex + 1]?.index ?? rows.length;
    for (let index = current.index + 1; index < end; index += 1) {
      const row = rows[index];
      if (!row || hasClass(row.attrs, "ResultHeader")) continue;
      const resultRow = hasClass(row.attrs, "ResultContent");
      const accountCell = row.cells[current.header.account];
      const likelyAccountRow = Boolean(
        accountCell && extractAccountIdentity(accountCell),
      );
      if (!resultRow && !likelyAccountRow) continue;
      if (resultRow) sawResultRow = true;
      const parsed = parseDepositRow(row.cells, current.header);
      if (!parsed) {
        // VISA/金融卡列也會套用 ResultContent，但幣別與餘額都是 '-'
        // 並非存款帳戶，安全地忽略即可。
        if (likelyAccountRow && !isNonDepositRow(row.cells, current.header)) {
          throw new FirstbankProtocolError("第一銀行存款帳戶資料格式已變更。");
        }
        continue;
      }
      sawCandidate = true;
      accounts.push(parsed);
    }
  }
  if (sawResultRow && !sawCandidate && !isNoDataText(pageText)) {
    throw new FirstbankProtocolError("第一銀行存款資料格式已變更。");
  }

  const uniqueAccounts = dedupeBySourceId(accounts);
  return {
    accounts: uniqueAccounts,
    bankAccounts: uniqueAccounts.map((account) => ({
      sourceId: account.sourceId,
      institutionName: "第一銀行",
      accountName:
        account.accountName ||
        (account.accountLast4
          ? `第一銀行存款末四碼 ${account.accountLast4}`
          : "第一銀行存款帳戶"),
      accountType: account.accountType,
      currency: account.currency,
      raw: {
        accountLast4: account.accountLast4,
        accountType: account.accountType,
        currency: account.currency,
      },
    })),
    snapshots: uniqueAccounts.map((account) => ({
      accountId: account.sourceId,
      sourceId: `snapshot:firstbank:${stableHash(`${account.sourceId}:${asOfAt.slice(0, 10)}`)}`,
      balance: account.balance,
      availableBalance: account.availableBalance,
      currency: account.currency,
      asOfAt,
      raw: {
        accountLast4: account.accountLast4,
        currency: account.currency,
      },
    })),
  };
}

function parseDepositHeader(cells: string[]): DepositHeader | undefined {
  const labels = cells.map(normalizeLabel);
  // 英文 iBank 存款表頭：Account / nickname、Currency、Ledger/Book balance、
  // Available。不可只用 /account/，否則會誤把 Account Type 當帳號欄。
  const account = findHeaderIndex(labels, [
    /帳號.*暱稱/,
    /帳號/,
    /帳戶號碼/,
    /account(?:and)?nickname/,
    /account(?:no|number|num)(?:and)?nickname/,
    /^account(?:no|number|num)?$/,
  ]);
  const currency = findHeaderIndex(labels, [/幣別/, /^currency$/, /^ccy$/]);
  const balance = findHeaderIndex(labels, [
    /帳面餘額/,
    /存款餘額/,
    /^餘額$/,
    /ledger(?:book)?balance/,
    /bookbalance/,
    /depositbalance/,
    /^balance$/,
  ]);
  const availableBalance = findHeaderIndex(labels, [
    /可用餘額/,
    /可動用/,
    /^available(?:balance)?$/,
  ]);
  if (
    account === undefined ||
    currency === undefined ||
    balance === undefined
  ) {
    return undefined;
  }
  return {
    accountType: findHeaderIndex(labels, [
      /帳戶類別/,
      /帳戶類型/,
      /帳別/,
      /^accounttype$/,
      /accountcategory/,
    ]),
    account,
    currency,
    balance,
    availableBalance,
  };
}

function parseDepositRow(
  cells: string[],
  header: DepositHeader,
): DepositAccount | undefined {
  const currency = normalizeCurrency(cells[header.currency]);
  if (!currency) return undefined;
  const identity = extractAccountIdentity(cells[header.account] ?? "");
  if (!identity) return undefined;
  const balance = numberValue(cells[header.balance]);
  if (balance === undefined) {
    throw new FirstbankProtocolError("第一銀行帳面餘額格式已變更。");
  }
  const availableRaw =
    header.availableBalance === undefined
      ? undefined
      : cells[header.availableBalance];
  const availableBalance = numberValue(availableRaw);
  if (
    availableRaw !== undefined &&
    stripTags(availableRaw) !== "" &&
    !isDash(availableRaw) &&
    availableBalance === undefined
  ) {
    throw new FirstbankProtocolError("第一銀行可用餘額格式已變更。");
  }
  const accountType = accountTypeFor(
    header.accountType === undefined ? "" : (cells[header.accountType] ?? ""),
  );
  const accountKey = normalizeAccountIdentity(identity.token);
  const accountLast4 = last4(identity.token);
  const sourceId = `bank:firstbank:${accountLast4 || "unknown"}:${stableHash(`${accountKey}:${currency}:${accountType}`)}`;
  return {
    sourceId,
    accountKey,
    accountLast4,
    accountName: identity.nickname,
    accountType,
    currency,
    balance,
    availableBalance:
      availableBalance === undefined || isDash(availableRaw)
        ? undefined
        : availableBalance,
  };
}

function isNonDepositRow(cells: string[], header: DepositHeader) {
  const currency = stripTags(cells[header.currency] ?? "");
  return !currency || isDash(currency);
}

function accountTypeFor(value: unknown): BankAccount["accountType"] {
  const text = stripTags(String(value ?? ""));
  if (/信用卡|visa|master|金融卡|credit/i.test(text)) return "credit";
  if (/定存|定期|存單|time.?deposit/i.test(text)) return "time_deposit";
  if (/支票|活期|checking/i.test(text)) return "checking";
  if (/儲蓄|活存|iLEO|savings/i.test(text)) return "savings";
  return "unknown";
}

function parseTransactionHistoryHtml(
  html: unknown,
  accounts: DepositAccount[],
): FirstbankData["bankTransactions"] {
  if (typeof html !== "string") {
    throw new FirstbankProtocolError("第一銀行交易明細格式已變更。");
  }
  if (!html.trim()) return [];
  const rows = extractHtmlRows(html);
  const pageText = stripTags(html);
  const accountToken = findPageAccountIdentity(pageText);
  const headers = rows
    .map((row, index) => {
      const header = parseTransactionHeader(row.cells);
      return header ? { index, header } : undefined;
    })
    .filter(
      (entry): entry is { index: number; header: TransactionHeader } =>
        entry !== undefined,
    );
  if (headers.length === 0) {
    if (isNoDataText(pageText)) return [];
    throw new FirstbankProtocolError("第一銀行交易明細表頭格式已變更。");
  }

  const output: FirstbankData["bankTransactions"] = [];
  const occurrences = new Map<string, number>();
  let sawResult = false;
  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const current = headers[headerIndex];
    if (!current) continue;
    const end = headers[headerIndex + 1]?.index ?? rows.length;
    for (let index = current.index + 1; index < end; index += 1) {
      const row = rows[index];
      if (!row || !hasClass(row.attrs, "ResultContent")) continue;
      sawResult = true;
      const parsed = parseTransactionRow(row.cells, current.header);
      if (!parsed) continue;
      const currency = parsed.currency || TWD;
      const account = resolveTransactionAccount(
        accountToken,
        currency,
        accounts,
      );
      if (!account) {
        throw new FirstbankProtocolError(
          "第一銀行交易明細找不到對應的存款帳戶。",
        );
      }
      const identity = [
        account.sourceId,
        parsed.authorizedAt,
        parsed.amount,
        currency,
        parsed.balance ?? "",
        parsed.description,
        parsed.status,
      ].join("|");
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      output.push({
        accountId: account.sourceId,
        sourceId: `firstbank:deposit:tx:${stableHash(`${identity}|${occurrence}`)}`,
        postedDate: parsed.postedDate,
        authorizedAt: parsed.authorizedAt,
        amount: parsed.amount,
        currency,
        description: parsed.description,
        status: parsed.status,
        raw: {
          accountLast4: account.accountLast4,
          transactionDate: parsed.postedDate,
          amount: parsed.amount,
          balance: parsed.balance,
          currency,
          status: parsed.status,
        },
      });
    }
  }
  if (sawResult && output.length === 0 && !isNoDataText(pageText)) {
    throw new FirstbankProtocolError("第一銀行交易明細資料格式已變更。");
  }
  return output;
}

function parseTransactionHeader(
  cells: string[],
): TransactionHeader | undefined {
  const labels = cells.map(normalizeLabel);
  const date = findHeaderIndex(labels, [
    /交易日期/,
    /交易日/,
    /^日期$/,
    /transactiondate/,
    /txndate/,
    /^date$/,
  ]);
  if (date === undefined) return undefined;
  const debit = findHeaderIndex(labels, [
    /支出金額/,
    /^支出$/,
    /提款/,
    /扣款/,
    /^withdrawal(?:amount)?$/,
    /^debit(?:amount)?$/,
    /^withdraw(?:amount)?$/,
  ]);
  const credit = findHeaderIndex(labels, [
    /存入金額/,
    /^存入$/,
    /存款/,
    /^deposit(?:amount)?$/,
    /^credit(?:amount)?$/,
  ]);
  const amount = findHeaderIndex(labels, [
    /交易金額/,
    /^金額$/,
    /transactionamount/,
    /^amount$/,
  ]);
  if (debit === undefined && credit === undefined && amount === undefined) {
    return undefined;
  }
  return {
    date,
    debit,
    credit,
    amount,
    balance: findHeaderIndex(labels, [
      /餘額/,
      /結餘/,
      /^balance$/,
      /endingbalance/,
    ]),
    currency: findHeaderIndex(labels, [/幣別/, /^currency$/, /^ccy$/]),
    type: findHeaderIndex(labels, [
      /交易類別/,
      /^類別$/,
      /交易種類/,
      /transactiontype/,
      /txtype/,
    ]),
    status: findHeaderIndex(labels, [/交易狀態/, /^狀態$/, /^status$/]),
    memo: findHeaderIndex(labels, [
      /備註/,
      /說明/,
      /^memo$/,
      /^remarks?$/,
      /^description$/,
    ]),
    summary: findHeaderIndex(labels, [
      /摘要/,
      /明細/,
      /^summary$/,
      /^particulars?$/,
    ]),
  };
}

function parseTransactionRow(
  cells: string[],
  header: TransactionHeader,
):
  | {
      amount: number;
      currency?: string;
      balance?: number;
      postedDate: string;
      authorizedAt: string;
      description: string;
      status: "pending" | "posted";
    }
  | undefined {
  const date = normalizeDateTime(cells[header.date]);
  if (!date) return undefined;
  const debit = numberValue(
    header.debit === undefined ? undefined : cells[header.debit],
  );
  const credit = numberValue(
    header.credit === undefined ? undefined : cells[header.credit],
  );
  const fallback = numberValue(
    header.amount === undefined ? undefined : cells[header.amount],
  );
  let amount: number | undefined;
  if (credit !== undefined && credit !== 0) amount = Math.abs(credit);
  else if (debit !== undefined && debit !== 0) amount = -Math.abs(debit);
  else if (fallback !== undefined && fallback !== 0) amount = fallback;
  if (amount === undefined || amount === 0) return undefined;
  const type = textAt(cells, header.type);
  const memo = textAt(cells, header.memo);
  const summary = textAt(cells, header.summary);
  const description = summary || memo || type || "第一銀行帳戶交易";
  const statusText = textAt(cells, header.status);
  return {
    amount,
    currency:
      header.currency === undefined
        ? undefined
        : normalizeCurrency(cells[header.currency]),
    balance:
      header.balance === undefined
        ? undefined
        : numberValue(cells[header.balance]),
    postedDate: date.date,
    authorizedAt: date.dateTime,
    description,
    status: /待處理|處理中|未入帳|圈存|pending|processing/i.test(statusText)
      ? "pending"
      : "posted",
  };
}

function resolveTransactionAccount(
  token: string | undefined,
  currency: string,
  accounts: DepositAccount[],
) {
  if (accounts.length === 0) {
    return undefined;
  }
  if (token) {
    const key = normalizeAccountIdentity(token);
    const matching = accounts.find(
      (account) => account.accountKey === key && account.currency === currency,
    );
    if (matching) return matching;
    const sameToken = accounts.find((account) => account.accountKey === key);
    if (sameToken) return sameToken;
  }
  return accounts.length === 1 ? accounts[0] : undefined;
}

type CardPayment = {
  cardKey: string;
  currency: string;
  date: string;
  amount: number;
  description: string;
};

type CardBill = {
  cardKey: string;
  currency: string;
  billingPeriod: string;
  statementAmount?: number;
  minimumPayment?: number;
  creditLimit?: number;
  paymentDueDate?: string;
  statementClosingDate?: string;
  paidAmount?: number;
  isPaid?: boolean;
  transactions: CardTransaction[];
};

type CardTransaction = {
  cardKey: string;
  currency: string;
  authorizedAt: string;
  postedDate?: string;
  amount: number;
  description: string;
  status: "pending" | "posted";
};

type CardParseResult = {
  bankAccounts: FirstbankData["bankAccounts"];
  snapshots: FirstbankData["bankBalanceSnapshots"];
  transactions: FirstbankData["bankTransactions"];
  bills: FirstbankData["creditCardBills"];
};

function parseCreditCards(
  cardBillPayload: unknown,
  cardUnbilledPayload: unknown,
  recentPaymentsPayload: unknown,
  asOfAt: string,
): CardParseResult {
  const bills = parseCardBills(cardBillPayload);
  const pending = parseCardUnbilled(cardUnbilledPayload);
  const payments = parseRecentPayments(recentPaymentsPayload);
  // 0006 繳款回應通常不帶卡號；只有一張卡時沿用該卡的穩定末四碼，
  // 避免同一張卡被拆成一個「main」與一個末四碼帳戶。
  const identifiedCardKeys = new Set(
    [
      ...bills.map((bill) => bill.cardKey),
      ...pending.map((tx) => tx.cardKey),
    ].filter((key) => key !== "main"),
  );
  if (identifiedCardKeys.size === 1) {
    const [identifiedCardKey] = identifiedCardKeys;
    if (identifiedCardKey) {
      for (const payment of payments) {
        if (payment.cardKey === "main") payment.cardKey = identifiedCardKey;
      }
      for (const transaction of pending) {
        if (transaction.cardKey === "main") {
          transaction.cardKey = identifiedCardKey;
        }
      }
      for (const bill of bills) {
        if (bill.cardKey === "main") bill.cardKey = identifiedCardKey;
      }
    }
  }
  assignPaymentsToBills(bills, payments);
  const cardKeys = new Set<string>([
    ...bills.map((bill) => bill.cardKey),
    ...pending.map((transaction) => transaction.cardKey),
    ...payments.map((payment) => payment.cardKey),
  ]);
  if (cardKeys.size === 0) {
    return { bankAccounts: [], snapshots: [], transactions: [], bills: [] };
  }

  const cardsByKey = new Map<
    string,
    { currency: string; creditLimit?: number }
  >();
  for (const bill of bills) {
    const previous = cardsByKey.get(bill.cardKey);
    cardsByKey.set(bill.cardKey, {
      currency: previous?.currency || bill.currency,
      creditLimit:
        previous?.creditLimit === undefined
          ? bill.creditLimit
          : bill.creditLimit === undefined
            ? previous.creditLimit
            : Math.max(previous.creditLimit, bill.creditLimit),
    });
  }
  for (const transaction of pending) {
    if (!cardsByKey.has(transaction.cardKey)) {
      cardsByKey.set(transaction.cardKey, { currency: transaction.currency });
    }
  }
  for (const payment of payments) {
    if (!cardsByKey.has(payment.cardKey)) {
      cardsByKey.set(payment.cardKey, { currency: payment.currency });
    }
  }

  const bankAccounts: CardParseResult["bankAccounts"] = [];
  for (const [cardKey, metadata] of cardsByKey) {
    const accountId = cardAccountId(cardKey);
    bankAccounts.push({
      sourceId: accountId,
      institutionName: "第一銀行",
      accountName:
        cardKey === "main"
          ? "第一銀行信用卡"
          : `第一銀行信用卡末四碼 ${cardKey}`,
      accountType: "credit",
      currency: metadata.currency,
      creditLimit: metadata.creditLimit,
      raw: { cardLast4: cardKey === "main" ? undefined : cardKey },
    });
  }

  const transactions: CardParseResult["transactions"] = [];
  for (const bill of bills) {
    transactions.push(
      ...bill.transactions.map((transaction) =>
        cardTransactionRecord(transaction),
      ),
    );
  }
  transactions.push(
    ...pending.map((transaction) => cardTransactionRecord(transaction)),
  );
  transactions.push(
    ...payments.map((payment) => ({
      accountId: cardAccountId(payment.cardKey),
      sourceId: `firstbank:card:payment:${stableHash(`${payment.cardKey}|${payment.date}|${payment.amount}|${payment.currency}|${payment.description}`)}`,
      postedDate: payment.date,
      authorizedAt: payment.date,
      amount: Math.abs(payment.amount),
      currency: payment.currency,
      description: payment.description,
      status: "posted" as const,
      raw: {
        cardLast4: payment.cardKey === "main" ? undefined : payment.cardKey,
        paymentDate: payment.date,
        amount: Math.abs(payment.amount),
        currency: payment.currency,
      },
    })),
  );

  const creditCardBills: CardParseResult["bills"] = bills.map((bill) => {
    const accountId = cardAccountId(bill.cardKey);
    return {
      accountId,
      sourceId: `firstbank:card:bill:${stableHash(`${bill.cardKey}|${bill.billingPeriod}|${bill.currency}`)}`,
      billingPeriod: bill.billingPeriod,
      statementAmount: bill.statementAmount,
      minimumPayment: bill.minimumPayment,
      paidAmount: bill.paidAmount,
      isPaid: bill.isPaid,
      paymentDueDate: bill.paymentDueDate,
      statementClosingDate: bill.statementClosingDate,
      currency: bill.currency,
      raw: {
        cardLast4: bill.cardKey === "main" ? undefined : bill.cardKey,
        billingPeriod: bill.billingPeriod,
        statementAmount: bill.statementAmount,
        minimumPayment: bill.minimumPayment,
      },
    };
  });

  const snapshots: CardParseResult["snapshots"] = [];
  for (const [cardKey, metadata] of cardsByKey) {
    const accountBills = bills
      .filter((bill) => bill.cardKey === cardKey)
      .sort((left, right) =>
        right.billingPeriod.localeCompare(left.billingPeriod),
      );
    const currentBill = accountBills[0];
    const pendingForCard = pending.filter(
      (transaction) => transaction.cardKey === cardKey,
    );
    const pendingLiability = pendingForCard.reduce(
      (sum, transaction) => sum + -transaction.amount,
      0,
    );
    const statementAmount = currentBill?.statementAmount ?? 0;
    const paidAmount = currentBill?.paidAmount ?? 0;
    const liability = Math.max(
      statementAmount - paidAmount + pendingLiability,
      0,
    );
    if (!currentBill && pendingForCard.length === 0) continue;
    const accountId = cardAccountId(cardKey);
    snapshots.push({
      accountId,
      sourceId: `snapshot:firstbank:card:${stableHash(`${cardKey}:${asOfAt.slice(0, 10)}`)}`,
      balance: -Math.abs(liability),
      statementBalance: currentBill?.statementAmount,
      paymentDueDate: currentBill?.paymentDueDate,
      statementClosingDate: currentBill?.statementClosingDate,
      noPaymentNeeded: liability === 0,
      currency: metadata.currency,
      asOfAt,
      raw: {
        cardLast4: cardKey === "main" ? undefined : cardKey,
        statementAmount: currentBill?.statementAmount,
        paidAmount: currentBill?.paidAmount,
        pendingLiability,
      },
    });
  }
  return {
    bankAccounts: dedupeBySourceId(bankAccounts),
    snapshots: dedupeBySourceId(snapshots),
    transactions: dedupeBySourceId(transactions),
    bills: dedupeBySourceId(creditCardBills),
  };
}

function cardTransactionRecord(
  transaction: CardTransaction,
): Omit<BankTransaction, "id" | "connectorId"> {
  const identity = [
    transaction.cardKey,
    transaction.authorizedAt,
    transaction.postedDate ?? "",
    transaction.amount,
    transaction.currency,
    transaction.description,
    transaction.status,
  ].join("|");
  return {
    accountId: cardAccountId(transaction.cardKey),
    sourceId: `firstbank:card:tx:${stableHash(identity)}`,
    postedDate:
      transaction.status === "posted" ? transaction.postedDate : undefined,
    authorizedAt: transaction.authorizedAt,
    amount: transaction.amount,
    currency: transaction.currency,
    description: transaction.description,
    status: transaction.status,
    raw: {
      cardLast4:
        transaction.cardKey === "main" ? undefined : transaction.cardKey,
      authorizedAt: transaction.authorizedAt,
      postedDate: transaction.postedDate,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
    },
  };
}

function parseCardBills(payload: unknown): CardBill[] {
  const records = cardEnvelopeRecords(payload, "0014", "BillRecords");
  return records.map((record, index) => {
    const nested = property(record, "Records");
    if (nested !== undefined && !Array.isArray(nested)) {
      throw new FirstbankProtocolError(
        `第一銀行信用卡帳單明細格式已變更（第 ${index + 1} 筆）。`,
      );
    }
    const nestedRecords = (nested ?? []) as unknown[];
    const firstCardKey =
      last4(propertyString(record, "CardNo")) ||
      nestedRecords
        .filter(isRecord)
        .map((entry) => last4(propertyString(entry, "CardNo")))
        .find((value): value is string => Boolean(value)) ||
      "main";
    const statementClosingDate = normalizeDate(
      property(record, "BillDate", "statementClosingDate", "statementDate"),
    );
    const billingPeriod = normalizeBillingPeriod(
      property(record, "BillingPeriod", "billingPeriod", "BillDate", "BillYM"),
    );
    if (!billingPeriod) {
      throw new FirstbankProtocolError(
        `第一銀行信用卡帳單期間格式已變更（第 ${index + 1} 筆）。`,
      );
    }
    const currency =
      normalizeCurrency(property(record, "Currency", "currency")) || TWD;
    const transactions: CardTransaction[] = [];
    for (const [nestedIndex, value] of nestedRecords.entries()) {
      if (!isRecord(value)) {
        throw new FirstbankProtocolError(
          `第一銀行信用卡交易格式已變更（第 ${nestedIndex + 1} 筆）。`,
        );
      }
      const date = normalizeDate(
        property(value, "TransDate", "transactionDate", "authorizedAt"),
      );
      const rawAmount = firstDefinedNumber(
        property(value, "AcctAmount", "Amount", "LocalAmount", "amount"),
      );
      const description =
        propertyString(value, "TransDetail", "description", "Memo") ||
        "第一銀行信用卡消費";
      if (
        date === undefined &&
        (rawAmount === undefined || isCardSummary(description))
      ) {
        continue;
      }
      if (date === undefined || rawAmount === undefined) {
        throw new FirstbankProtocolError("第一銀行信用卡交易欄位格式已變更。");
      }
      if (rawAmount === 0 || isCardSummary(description)) continue;
      const cardKey = last4(propertyString(value, "CardNo")) || firstCardKey;
      const postedDate = normalizeDate(
        property(value, "AcctDate", "postedDate", "postingDate"),
      );
      transactions.push({
        cardKey,
        currency,
        authorizedAt: date,
        postedDate: postedDate || date,
        amount: signedCardAmount(rawAmount, description),
        description,
        status: "posted",
      });
    }
    const statementAmount = firstDefinedNumber(
      property(
        record,
        "TotalAmount",
        "StatementAmount",
        "statementAmount",
        "CurrentPeriodAmount",
      ),
    );
    const minimumPayment = firstDefinedNumber(
      property(record, "MinAmount", "MinimumPayment", "minimumPayment"),
    );
    const creditLimit = firstDefinedNumber(
      property(record, "CreditAmount", "CreditLimit", "creditLimit"),
    );
    return {
      cardKey: firstCardKey,
      currency,
      billingPeriod,
      statementAmount,
      minimumPayment,
      creditLimit,
      paymentDueDate: normalizeDate(
        property(record, "PayEndDate", "PaymentDueDate", "paymentDueDate"),
      ),
      statementClosingDate,
      transactions,
    };
  });
}

function parseCardUnbilled(payload: unknown): CardTransaction[] {
  const records = cardEnvelopeRecords(payload, "0008", "Records");
  const output: CardTransaction[] = [];
  for (const [index, record] of records.entries()) {
    const date = normalizeDate(
      property(record, "TransDate", "transactionDate", "authorizedAt"),
    );
    const rawAmount = firstDefinedNumber(
      property(record, "TransAmount", "Amount", "LocalAmount", "amount"),
    );
    const description =
      propertyString(record, "TransDetail", "description", "Memo") ||
      "第一銀行信用卡待入帳消費";
    if (
      date === undefined &&
      (rawAmount === undefined || isCardSummary(description))
    ) {
      continue;
    }
    if (date === undefined || rawAmount === undefined) {
      throw new FirstbankProtocolError(
        `第一銀行未入帳信用卡交易格式已變更（第 ${index + 1} 筆）。`,
      );
    }
    if (rawAmount === 0 || isCardSummary(description)) continue;
    output.push({
      cardKey: last4(propertyString(record, "CardNo")) || "main",
      currency:
        normalizeCurrency(property(record, "Currency", "currency")) || TWD,
      authorizedAt: date,
      amount: signedCardAmount(rawAmount, description),
      description,
      status: "pending",
    });
  }
  return output;
}

function parseRecentPayments(payload: unknown): CardPayment[] {
  const records = cardEnvelopeRecords(payload, "0006", "Records");
  const output: CardPayment[] = [];
  for (const [index, record] of records.entries()) {
    const date = normalizeDate(
      property(record, "PayDate", "PaymentDate", "paymentDate", "date"),
    );
    const amount = firstDefinedNumber(
      property(record, "Amount", "PaymentAmount", "paymentAmount"),
    );
    if (date === undefined && amount === undefined) continue;
    if (date === undefined || amount === undefined) {
      throw new FirstbankProtocolError(
        `第一銀行信用卡繳款格式已變更（第 ${index + 1} 筆）。`,
      );
    }
    if (amount === 0) continue;
    output.push({
      cardKey: last4(propertyString(record, "CardNo")) || "main",
      currency:
        normalizeCurrency(property(record, "Currency", "currency")) || TWD,
      date,
      amount: Math.abs(amount),
      description:
        propertyString(record, "Memo", "Description", "description") ||
        "第一銀行信用卡繳款",
    });
  }
  return output;
}

function assignPaymentsToBills(bills: CardBill[], payments: CardPayment[]) {
  const assigned = new Set<number>();
  const sortedBills = [...bills].sort((left, right) =>
    right.billingPeriod.localeCompare(left.billingPeriod),
  );
  for (const payment of payments) {
    const paymentPeriod = payment.date.slice(0, 7);
    const candidate =
      sortedBills.find(
        (bill) =>
          !assigned.has(bills.indexOf(bill)) &&
          bill.currency === payment.currency &&
          bill.cardKey === payment.cardKey &&
          (bill.billingPeriod === paymentPeriod ||
            bill.paymentDueDate?.slice(0, 7) === paymentPeriod),
      ) ||
      sortedBills.find(
        (bill) =>
          !assigned.has(bills.indexOf(bill)) &&
          bill.currency === payment.currency &&
          bill.cardKey === payment.cardKey,
      );
    if (!candidate) continue;
    const index = bills.indexOf(candidate);
    assigned.add(index);
    candidate.paidAmount = (candidate.paidAmount ?? 0) + payment.amount;
  }
  for (const bill of bills) {
    if (bill.statementAmount !== undefined && bill.paidAmount !== undefined) {
      bill.isPaid = bill.paidAmount >= bill.statementAmount;
    }
  }
}

function signedCardAmount(rawAmount: number, description: string) {
  if (
    rawAmount < 0 ||
    /退款|退貨|折讓|沖銷|回饋|繳款|還款|refund|credit|payment/i.test(
      description,
    )
  ) {
    return Math.abs(rawAmount);
  }
  return -Math.abs(rawAmount);
}

function cardAccountId(cardKey: string) {
  return `credit:firstbank:${cardKey}`;
}

function cardEnvelopeRecords(
  payload: unknown,
  code: string,
  key: string,
): JsonRecord[] {
  if (payload === undefined || payload === null) return [];
  if (typeof payload === "string" && !payload.trim()) return [];
  let parsed: unknown = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new FirstbankProtocolError(
        `第一銀行信用卡 ${code} 回應不是有效 JSON。`,
      );
    }
  }
  if (!isRecord(parsed)) {
    throw new FirstbankProtocolError(`第一銀行信用卡 ${code} 回應格式已變更。`);
  }
  const head = recordProperty(parsed, "HEAD", "head");
  const content = recordProperty(parsed, "CONTENT", "content");
  if (!head || !content) {
    throw new FirstbankProtocolError(
      `第一銀行信用卡 ${code} 回應缺少 HEAD 或 CONTENT。`,
    );
  }
  {
    const messageId = propertyString(head, "MSGID", "msgid");
    if (messageId && !messageId.includes(code)) {
      throw new FirstbankProtocolError(
        `第一銀行信用卡回應代碼不符（需要 ${code}）。`,
      );
    }
    const returnCode = propertyString(
      head,
      "RETURNCODE",
      "ReturnCode",
      "returnCode",
      "STATUSCODE",
      "statusCode",
    );
    if (returnCode && !/^0{1,4}$/.test(returnCode)) {
      throw new FirstbankProtocolError(`第一銀行信用卡 ${code} 查詢未完成。`);
    }
  }
  const records = property(content, key);
  if (!Array.isArray(records)) {
    throw new FirstbankProtocolError(
      `第一銀行信用卡 ${code} 回應缺少 ${key}。`,
    );
  }
  return records.map((value, index) => {
    if (!isRecord(value)) {
      throw new FirstbankProtocolError(
        `第一銀行信用卡 ${code} 第 ${index + 1} 筆格式已變更。`,
      );
    }
    return value;
  });
}

function extractHtmlRows(html: string): HtmlRow[] {
  const rows: HtmlRow[] = [];
  const rowRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(html)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(match[2] ?? "")) !== null) {
      cells.push(stripTags(cellMatch[1] ?? ""));
    }
    rows.push({ attrs: match[1] ?? "", cells });
  }
  return rows;
}

function findPageAccountIdentity(text: string) {
  const accountLabel =
    /(?:帳號|帳戶|賬號|account(?:\s*(?:no\.?|number))?)\s*[：:]?\s*([^\s，,；;|<]+)/i.exec(
      text,
    );
  return accountLabel?.[1]
    ? extractAccountIdentity(accountLabel[1])?.token
    : undefined;
}

function extractAccountIdentity(value: unknown) {
  const text = stripTags(String(value ?? ""));
  const candidates =
    text.match(/(?<!\d)[0-9][0-9*Xx#\-\s]{5,}[0-9](?!\d)/g) ?? [];
  const candidate = candidates
    .map((item) => item.trim())
    .filter((item) => item.replace(/\D/g, "").length >= 6)
    .sort((left, right) => right.length - left.length)[0];
  if (!candidate) return undefined;
  const token = candidate.replace(/\s+/g, "");
  const nickname = text
    .replace(candidate, " ")
    .replace(/[()（）【】\[\]：:|]/g, " ")
    .replace(
      /帳號與暱稱|帳號|暱稱|account\s*and\s*nickname|account\s*\/?\s*nickname|nickname|account(?:\s*(?:no\.?|number))?/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return {
    token,
    nickname: nickname && !isDash(nickname) ? nickname : undefined,
  };
}

function findHeaderIndex(labels: string[], patterns: RegExp[]) {
  const index = labels.findIndex((label) =>
    patterns.some((pattern) => pattern.test(label)),
  );
  return index >= 0 ? index : undefined;
}

function hasClass(attrs: string, name: string) {
  const classValue = /\bclass\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(classValue);
}

function normalizeLabel(value: unknown) {
  return stripTags(String(value ?? ""))
    .toLowerCase()
    .replace(/[\s\u00a0\u3000:：()（）【】「」『』、,./\\_-]+/g, "");
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim().toUpperCase();
  if (!text || isDash(text)) return undefined;
  if (/新臺?幣|臺幣|台幣|NTD?|NT\$|NEW\s*TAIWAN\s*DOLLAR/.test(text)) {
    return TWD;
  }
  if (/美金|美元|US\s*DOLLAR/.test(text)) return "USD";
  if (/日圓|日元|JAPANESE\s*YEN/.test(text)) return "JPY";
  if (/歐元|EURO/.test(text)) return "EUR";
  if (/英鎊|POUND\s*STERLING/.test(text)) return "GBP";
  if (/港幣|港元|HONG\s*KONG\s*DOLLAR/.test(text)) return "HKD";
  const code = text.match(/\b[A-Z]{3}\b/)?.[0] ?? text;
  return SUPPORTED_CURRENCIES.has(code) ? code : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  let text = stripTags(value).trim();
  if (!text || isDash(text)) return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  }
  text = text
    .replace(/,/g, "")
    .replace(/\s/g, "")
    .replace(/[^0-9.+-]/g, "");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return undefined;
  return negative ? -Math.abs(parsed) : parsed;
}

function firstDefinedNumber(value: unknown) {
  return numberValue(value);
}

function normalizeDate(value: unknown): string | undefined {
  const text = stripTags(String(value ?? "")).trim();
  if (!text) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  const match =
    compact ||
    /^(\d{3,4})\s*[^0-9]\s*(\d{1,2})\s*[^0-9]\s*(\d{1,2})/.exec(text);
  if (!match) return undefined;
  let year = Number(match[1]);
  if (year < 1911) year += 1911;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDateParts(year, month, day)) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateTime(value: unknown) {
  const text = stripTags(String(value ?? "")).trim();
  const date = normalizeDate(text);
  if (!date) return undefined;
  const time = /(?:T|\s+)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/.exec(text);
  if (!time) return { date, dateTime: date };
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const second = Number(time[3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return {
    date,
    dateTime: `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
  };
}

function normalizeBillingPeriod(value: unknown): string | undefined {
  const text = stripTags(String(value ?? "")).trim();
  if (!text) return undefined;
  const compact = /^(\d{4})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}`;
  const date = normalizeDate(text);
  if (date) return date.slice(0, 7);
  const yearMonth = /^(\d{3,4})\s*[^0-9]\s*(\d{1,2})/.exec(text);
  if (!yearMonth) return undefined;
  let year = Number(yearMonth[1]);
  if (year < 1911) year += 1911;
  const month = Number(yearMonth[2]);
  if (month < 1 || month > 12) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function isValidDateParts(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function property(record: JsonRecord, ...names: string[]) {
  for (const name of names) {
    if (name in record) return record[name];
  }
  const normalized = new Map(
    Object.keys(record).map((key) => [normalizeKey(key), key] as const),
  );
  for (const name of names) {
    const key = normalized.get(normalizeKey(name));
    if (key !== undefined) return record[key];
  }
  return undefined;
}

function recordProperty(record: JsonRecord, ...names: string[]) {
  for (const name of names) {
    const value = property(record, name);
    if (isRecord(value)) return value;
  }
  return undefined;
}

function propertyString(record: JsonRecord, ...names: string[]) {
  const value = property(record, ...names);
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function textAt(cells: string[], index: number | undefined) {
  return index === undefined ? "" : stripTags(cells[index] ?? "");
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[\s_\-:]/g, "");
}

function normalizeAccountIdentity(value: string) {
  const normalized = value.replace(/[\s-]/g, "").toUpperCase();
  return /[*X#]/.test(normalized) ? normalized : normalized.replace(/\D/g, "");
}

function last4(value: unknown) {
  return String(value ?? "")
    .replace(/\D/g, "")
    .match(/(\d{4})$/)?.[1];
}

function isCardSummary(value: string) {
  const normalized = value.replace(/\s+/g, "");
  return /小計|合計|總計|本期金額|前期帳單|^一銀自動扣款$|記名式.*卡號|將於.*自動扣繳/i.test(
    normalized,
  );
}

function isNoDataText(value: string) {
  return /查無(?:資料|符合)|無符合資料|沒有資料|no\s+data|no\s+records?/i.test(
    value,
  );
}

function isDash(value: unknown) {
  return /^[\-—–－﹣]+$/.test(stripTags(String(value ?? "")).trim());
}

function stripTags(value: string) {
  return decodeEntities(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u00a0\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function stableHash(value: string) {
  return forge.md.sha256
    .create()
    .update(value, "utf8")
    .digest()
    .toHex()
    .slice(0, 16);
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
