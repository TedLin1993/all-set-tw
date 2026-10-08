import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";

export const taishinConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  sessionCookies: z.string().optional(),
  sessionCreatedAt: z.string().optional(),
  browserSessionId: z.string().optional(),
  browserSessionExpiresAt: z.string().optional(),
  captchaDigitCount: z.number().int().min(4).max(8).optional(),
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

export type TaishinConfig = z.infer<typeof taishinConfigSchema>;

export function parseTaishinConfig(config: unknown): TaishinConfig {
  return taishinConfigSchema.parse(config);
}

export type TaishinCreditCardPayloads = {
  hasCreditCard?: boolean;
  summary: unknown;
  overview?: unknown;
  bills: unknown[];
  realtime?: unknown;
  unbilled?: unknown;
};

export type TaishinCreditCardData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;
type TransactionCandidate = Omit<
  BankTransaction,
  "id" | "connectorId" | "accountId" | "sourceId"
> & {
  matchKey: string;
  identityKey: string;
  cardLast4: string;
};

const ACCOUNT_SOURCE_ID = "credit:taishin:main";

export function parseTaishinCreditCardData(
  payloads: TaishinCreditCardPayloads,
  now = new Date(),
): TaishinCreditCardData {
  if (payloads.hasCreditCard === false) {
    return {
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
      creditCardBills: [],
    };
  }
  const summary = responseValue(payloads.summary);
  const summaryTwd = firstRecordValue(summary) ?? {};
  const overview = currentPaymentOverview(responseValue(payloads.overview));
  const billValues = payloads.bills
    .map(responseValue)
    .filter((value): value is JsonRecord => Boolean(value));
  const billEntries = billValues
    .flatMap((value) => {
      const bill = parseBill(value);
      return bill ? [{ value, bill }] : [];
    })
    .sort((left, right) =>
      right.bill.billingPeriod.localeCompare(left.bill.billingPeriod),
    );
  const currentBillEntry = billEntries[0];
  const currentBill = currentBillEntry?.value;
  const unbilled = unbilledData(payloads.unbilled);
  const postedCandidates = mergePostedFeeds([
    ...billValues.map(postedTransactions),
    unbilled.transactions,
  ]);
  const pendingCandidates = realtimeTransactions(payloads.realtime);
  const transactions = mergeTransactionLifecycle(
    postedCandidates,
    pendingCandidates,
  );
  const cardLast4s = Array.from(
    new Set(
      [...postedCandidates, ...pendingCandidates]
        .map((transaction) => transaction.cardLast4)
        .filter((value) => value !== "unknown"),
    ),
  ).sort();

  const statementAmount = optionalAbsoluteNumber(
    currentBill?.showCbalance ?? summaryTwd["OUT-STMT-BALANCE"],
  );
  const availableCredit = optionalNumber(summaryTwd["OUT-AVAIL-CREDIT"]);
  const creditLimit = optionalNumber(summaryTwd["OUT-CRLIMIT-PERM"]);
  const paymentDueDate = normalizeDate(currentBill?.showDueDate);
  const statementClosingDate = normalizeDate(currentBill?.showStmtDate);
  const overviewMatchesCurrentBill =
    overview?.billingPeriod != null &&
    overview.billingPeriod === currentBillEntry?.bill.billingPeriod;
  const paidAmount = overviewMatchesCurrentBill
    ? overview.paidAmount
    : undefined;
  const remainingDue =
    overviewMatchesCurrentBill && overview.statementAmount != null
      ? Math.max(overview.statementAmount - (paidAmount ?? 0), 0)
      : undefined;
  const balance =
    remainingDue == null ? undefined : -(remainingDue + unbilled.totalAmount);
  const asOfAt = now.toISOString();

  const bills = billEntries
    .map(({ bill }) =>
      overviewMatchesCurrentBill &&
      bill.billingPeriod === overview.billingPeriod
        ? {
            ...bill,
            paidAmount,
            isPaid: remainingDue === 0,
          }
        : bill,
    )
    .slice(0, BANK_SYNC_MONTHS);

  return {
    bankAccounts: [
      {
        sourceId: ACCOUNT_SOURCE_ID,
        institutionName: "台新銀行",
        accountName: "台新信用卡",
        accountType: "credit",
        currency: "TWD",
        creditLimit,
        raw: { cardLast4s },
      },
    ],
    bankBalanceSnapshots:
      currentBill && balance != null
        ? [
            {
              accountId: ACCOUNT_SOURCE_ID,
              sourceId: `${ACCOUNT_SOURCE_ID}:${asOfAt.slice(0, 10)}`,
              balance: balance === 0 ? 0 : balance,
              availableBalance: availableCredit,
              statementBalance: statementAmount,
              paymentDueDate,
              statementClosingDate,
              noPaymentNeeded: remainingDue === 0,
              currency: "TWD",
              asOfAt,
              raw: {
                statementAmount,
                remainingDue,
                unbilledAmount: unbilled.totalAmount,
                availableCredit,
                paymentDueDate,
                statementClosingDate,
              },
            },
          ]
        : [],
    bankTransactions: transactions.map((transaction) => ({
      ...transaction,
      accountId: ACCOUNT_SOURCE_ID,
    })),
    creditCardBills: bills.map((bill) => ({
      ...bill,
      accountId: ACCOUNT_SOURCE_ID,
    })),
  };
}

function parseBill(
  value: JsonRecord,
): Omit<CreditCardBill, "id" | "connectorId" | "accountId"> | undefined {
  const billingPeriod = normalizePeriod(value.showAccoutnYM);
  if (!billingPeriod) return undefined;
  const statementAmount = optionalAbsoluteNumber(value.showCbalance);
  const minimumPayment = optionalAbsoluteNumber(value.showMinPay);
  const paymentDueDate = normalizeDate(value.showDueDate);
  const statementClosingDate = normalizeDate(value.showStmtDate);
  return {
    sourceId: `taishin:card:statement:${billingPeriod}:TWD`,
    billingPeriod,
    statementAmount,
    minimumPayment,
    paymentDueDate,
    statementClosingDate,
    currency: "TWD",
    raw: {
      billingPeriod,
      statementAmount,
      minimumPayment,
      paymentDueDate,
      statementClosingDate,
    },
  };
}

function currentPaymentOverview(value: JsonRecord | undefined) {
  const cardInfoList = isRecord(value?.carInfoList)
    ? value.carInfoList
    : undefined;
  const twd = isRecord(cardInfoList?.["001"]) ? cardInfoList["001"] : undefined;
  const year = stringValue(twd?.BillYear).trim();
  const month = Number(stringValue(twd?.BillMon).trim());
  if (!/^\d{4}$/.test(year) || month < 1 || month > 12) return undefined;
  return {
    billingPeriod: `${year}-${String(month).padStart(2, "0")}`,
    statementAmount: optionalAbsoluteNumber(twd?.StmtBalance),
    paidAmount: optionalAbsoluteNumber(twd?.LstPymtAmt),
  };
}

function postedTransactions(value: JsonRecord): TransactionCandidate[] {
  const groups = Array.isArray(value.newAcctDetailList)
    ? value.newAcctDetailList.filter(isRecord)
    : [];
  const candidates: TransactionCandidate[] = [];
  for (const group of groups) {
    const cardLast4 = last4(stringValue(group.order)) ?? "unknown";
    const details = Array.isArray(group.detail)
      ? group.detail.filter(isRecord)
      : [];
    for (const detail of details) {
      const transactionDate = normalizeDate(detail.showOutTXNDate);
      const postedDate = normalizeDate(detail.showOutPostDate);
      const rawAmount = optionalNumber(detail.showOutAmt);
      if (!transactionDate || rawAmount == null || rawAmount === 0) continue;
      const description =
        taishinCardText(detail.showOutDesc) || "台新信用卡交易";
      const amount = signedAmount(rawAmount, description);
      const currency = normalizeCurrency(detail.showOutCurrency);
      const matchKey = transactionMatchKey(
        currency,
        transactionDate,
        amount,
        cardLast4,
      );
      candidates.push({
        matchKey,
        identityKey: transactionIdentityKey(matchKey, description),
        cardLast4,
        authorizedAt: transactionDate,
        postedDate: postedDate ?? transactionDate,
        amount,
        currency,
        description,
        counterparty: description,
        status: "posted",
        raw: {
          cardLast4: cardLast4 === "unknown" ? undefined : cardLast4,
          transactionDate,
          postedDate: postedDate ?? transactionDate,
          description,
          amount,
          currency,
          country: taishinCardText(detail.showOutCountry) || undefined,
        },
      });
    }
  }
  return candidates;
}

const cardCellSchema = z.union([z.string(), z.number(), z.null()]);
const cardGroupSchema = z.object({
  cardname: z.string(),
  txlist: z.array(z.array(cardCellSchema).min(7)),
});

export function isTaishinNoConsumption(value: unknown) {
  return (
    stringValue(isRecord(value) ? value.message : value).trim() ===
    "(CRXTIKE004)無消費資料"
  );
}

export function taishinCardText(value: unknown) {
  return stringValue(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim()
    .replace(/[A-Z][12]\d{8}/gi, "[身分證已遮罩]")
    .replace(
      /\d(?:[ -]?\d){7,}/g,
      (match) => `****${match.replace(/\D/g, "").slice(-4)}`,
    );
}

function cardAmount(value: unknown) {
  const text = stringValue(value)
    .replace(/<[^>]*>/g, "")
    .replaceAll(",", "")
    .trim();
  if (!/^(?:[+-]?\d+(?:\.\d+)?|\(\d+(?:\.\d+)?\))$/.test(text))
    throw new Error("台新信用卡交易金額格式已改變。");
  const number = optionalNumber(text);
  if (number == null) throw new Error("台新信用卡交易金額無效。");
  return number;
}

function realtimeTransactions(payload: unknown): TransactionCandidate[] {
  if (isRecord(payload) && isTaishinNoConsumption(payload.error)) return [];
  const parsed = z
    .object({ fmtRealTxListMap: z.array(cardGroupSchema) })
    .safeParse(responseValue(payload));
  if (!parsed.success) throw new Error("台新即時消費回應缺少完整清單。");
  const candidates: TransactionCandidate[] = [];
  for (const group of parsed.data.fmtRealTxListMap) {
    const cardName = stringValue(group.cardname);
    const cardLast4 = last4(cardName) ?? "unknown";
    for (const row of group.txlist) {
      // The official page sums only exact 成功; 未成功 must never count as spending.
      const authorizationResult = stringValue(row[5]).trim();
      if (authorizationResult !== "成功") continue;
      const transactionDate = normalizeDate(row[0]);
      const time = stringValue(row[1]).trim();
      // RB0708 displays row[6]. Keep row[2] for the existing v2 identity.
      const identityDescription = taishinCardText(row[2]) || "台新信用卡交易";
      const description = taishinCardText(row[6]) || identityDescription;
      const rawAmount = cardAmount(row[3]);
      const country = taishinCardText(row[4]);
      if (!transactionDate) throw new Error("台新即時消費日期無效。");
      if (rawAmount === 0) continue;
      const amount = signedAmount(rawAmount, identityDescription);
      const currency = "TWD";
      const authorizedAt = dateTimeWithTaipeiOffset(transactionDate, time);
      const matchKey = transactionMatchKey(
        currency,
        transactionDate,
        amount,
        cardLast4,
      );
      candidates.push({
        matchKey,
        identityKey: transactionIdentityKey(matchKey, identityDescription),
        cardLast4,
        authorizedAt,
        amount,
        currency,
        description,
        counterparty: description,
        status: "pending",
        raw: {
          cardLast4: cardLast4 === "unknown" ? undefined : cardLast4,
          authorizedAt,
          description,
          amount,
          currency,
          country: country || undefined,
          authorizationResult,
          identityDescription,
          amountBasis: "TWD authorization",
        },
      });
    }
  }
  return candidates;
}

function unbilledData(payload: unknown): {
  transactions: TransactionCandidate[];
  totalAmount: number;
} {
  if (isRecord(payload) && isTaishinNoConsumption(payload.error))
    return { transactions: [], totalAmount: 0 };
  const value = responseValue(payload);
  if (
    !isRecord(value?.unpostedTx) &&
    !(Array.isArray(value?.unpostedTx) && value.unpostedTx.length === 0)
  )
    throw new Error("台新未出帳消費回應缺少完整清單。");
  const candidates: TransactionCandidate[] = [];
  let hasRows = false;
  for (const [key, group] of Object.entries(value.unpostedTx)) {
    if (!isRecord(group)) throw new Error("台新未出帳消費幣別清單格式已改變。");
    if (group.ErrMsg) {
      if (isTaishinNoConsumption(group.ErrMsg)) continue;
      throw new Error("台新未出帳消費幣別查詢失敗。");
    }
    const currency = key.match(/^(?:\d{3})?([A-Z]{3})$/)?.[1];
    const parsed = z
      .array(
        cardGroupSchema.extend({
          txlist: z.array(z.array(cardCellSchema).min(8)),
        }),
      )
      .safeParse(group.data);
    if (!currency || !parsed.success)
      throw new Error("台新未出帳消費格式已改變。");
    for (const card of parsed.data) {
      if (card.txlist.length > 0) hasRows = true;
      const cardLast4 = last4(card.cardname) ?? "unknown";
      for (const row of card.txlist) {
        const transactionDate = normalizeDate(row[0]);
        const postedDate = normalizeDate(row[1]);
        if (!transactionDate || !postedDate)
          throw new Error("台新未出帳消費日期無效。");
        if (
          stringValue(row[7]).trim() &&
          (!/^(?:[A-Z]{3}|新臺幣|台幣|臺幣|美元|日圓|日幣|歐元)$/.test(
            stringValue(row[7]).trim(),
          ) ||
            normalizeCurrency(row[7]) !== currency)
        )
          throw new Error("台新未出帳消費幣別與分組不符。");
        const description = taishinCardText(row[2]) || "台新信用卡交易";
        const amount = signedAmount(cardAmount(row[3]), description);
        if (amount === 0) continue;
        const matchKey = transactionMatchKey(
          currency,
          transactionDate,
          amount,
          cardLast4,
        );
        candidates.push({
          matchKey,
          identityKey: transactionIdentityKey(matchKey, description),
          cardLast4,
          authorizedAt: transactionDate,
          postedDate,
          amount,
          currency,
          description,
          counterparty: description,
          status: "posted",
          raw: {
            cardLast4: cardLast4 === "unknown" ? undefined : cardLast4,
            transactionDate,
            postedDate,
            amount,
            currency,
            description,
            country: taishinCardText(row[5]) || undefined,
          },
        });
      }
    }
  }
  if (value.showRB0712_SUBTOTAL == null && hasRows)
    throw new Error("台新未出帳消費回應缺少新臺幣總額。");
  // The bank's TWD subtotal includes refunds and excludes payments. Summing
  // transaction rows would deduct payments twice and mix unconverted currencies.
  return {
    transactions: candidates,
    totalAmount:
      value.showRB0712_SUBTOTAL == null
        ? 0
        : cardAmount(value.showRB0712_SUBTOTAL),
  };
}

function mergePostedFeeds(feeds: TransactionCandidate[][]) {
  const merged = new Map<string, TransactionCandidate>();
  for (const feed of feeds) {
    const occurrences = new Map<string, number>();
    for (const transaction of feed) {
      const occurrence = (occurrences.get(transaction.identityKey) ?? 0) + 1;
      occurrences.set(transaction.identityKey, occurrence);
      const key = `${transaction.identityKey}:${occurrence}`;
      if (!merged.has(key)) merged.set(key, transaction);
    }
  }
  return [...merged.values()];
}

function mergeTransactionLifecycle(
  posted: TransactionCandidate[],
  pending: TransactionCandidate[],
) {
  const postedIdentityKeys = new Map<
    TransactionCandidate,
    { identityKey: string; authorizedAt?: string }
  >();
  const consumedPending = new Set<TransactionCandidate>();

  // Only identical v2 identities collapse here. Different merchant names are
  // linked against saved authorizations in D1, without changing the posted ID
  // when the bank stops returning the authorization on a later sync.
  for (const postedTransaction of posted) {
    if (postedIdentityKeys.has(postedTransaction)) continue;
    const pendingTransaction = pending.find(
      (candidate) =>
        !consumedPending.has(candidate) &&
        candidate.identityKey === postedTransaction.identityKey,
    );
    if (!pendingTransaction) continue;
    postedIdentityKeys.set(postedTransaction, {
      identityKey: pendingTransaction.identityKey,
      authorizedAt: preferredAuthorizedAt(
        postedTransaction.authorizedAt,
        pendingTransaction.authorizedAt,
      ),
    });
    consumedPending.add(pendingTransaction);
  }

  const candidates = [
    ...posted.map((transaction) => ({
      transaction,
      identityKey:
        postedIdentityKeys.get(transaction)?.identityKey ??
        transaction.identityKey,
      authorizedAt:
        postedIdentityKeys.get(transaction)?.authorizedAt ??
        transaction.authorizedAt,
    })),
    ...pending
      .filter((transaction) => !consumedPending.has(transaction))
      .map((transaction) => ({
        transaction,
        identityKey: transaction.identityKey,
        authorizedAt: transaction.authorizedAt,
      })),
  ];
  const occurrences = new Map<string, number>();
  return candidates.map(({ transaction, identityKey, authorizedAt }) => {
    const occurrence = (occurrences.get(identityKey) ?? 0) + 1;
    occurrences.set(identityKey, occurrence);
    return assignSourceId(
      { ...transaction, authorizedAt },
      identityKey,
      occurrence,
    );
  });
}

function preferredAuthorizedAt(
  postedAuthorizedAt: string | undefined,
  pendingAuthorizedAt: string | undefined,
) {
  const postedHasTime = hasTimeComponent(postedAuthorizedAt);
  const pendingHasTime = hasTimeComponent(pendingAuthorizedAt);
  if (pendingHasTime && !postedHasTime) return pendingAuthorizedAt;
  return postedAuthorizedAt;
}

function hasTimeComponent(value: string | undefined) {
  return Boolean(value && /T\d{2}:\d{2}(?::\d{2})?/.test(value));
}

function assignSourceId(
  candidate: TransactionCandidate,
  identityKey: string,
  occurrence: number,
) {
  const {
    matchKey: _matchKey,
    identityKey: _identityKey,
    cardLast4: _cardLast4,
    ...transaction
  } = candidate;
  return {
    ...transaction,
    sourceId: taishinTransactionSourceId(identityKey, occurrence),
    raw: {
      ...(candidate.raw as JsonRecord),
      duplicateOccurrence: occurrence,
    },
  };
}

function taishinTransactionSourceId(identityKey: string, occurrence: number) {
  return `taishin:card:tx:v2:${identityKey}:${occurrence}`;
}

export function normalizeMerchantName(value: string | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s()[\]{}（）【】〈〉《》,，.。:：/\\_-]+/g, "");
}

function responseValue(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (Boolean(value.error)) {
    throw new Error("台新信用卡 API 回傳錯誤。");
  }
  return isRecord(value.value) ? value.value : undefined;
}

function firstRecordValue(value: JsonRecord | undefined) {
  if (!value) return undefined;
  return Object.values(value).find(isRecord);
}

function transactionMatchKey(
  currency: string,
  transactionDate: string,
  amount: number,
  cardLast4: string,
) {
  return [currency, transactionDate, amount, cardLast4].join(":");
}

function transactionIdentityKey(matchKey: string, description: string) {
  return [matchKey, normalizeMerchantName(description) || "unknown"].join(":");
}

function signedAmount(rawAmount: number, description: string) {
  const isCredit =
    rawAmount < 0 ||
    /退款|退貨|折抵|折讓|回饋|沖銷|繳款|自動轉帳扣繳|refund|credit|payment/i.test(
      description,
    );
  return isCredit ? Math.abs(rawAmount) : -Math.abs(rawAmount);
}

function normalizeCurrency(value: unknown) {
  const text = stringValue(value).trim().toUpperCase();
  if (!text || /新臺幣|台幣|臺幣|TWD|NTD/.test(text)) return "TWD";
  if (/美元|USD/.test(text)) return "USD";
  if (/日圓|日幣|JPY/.test(text)) return "JPY";
  if (/歐元|EUR/.test(text)) return "EUR";
  return text.length === 3 ? text : "TWD";
}

function normalizePeriod(value: unknown) {
  const text = stringValue(value).trim();
  const match = text.match(/(\d{4})[/-]?(\d{1,2})/);
  if (!match) return undefined;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function normalizeDate(value: unknown) {
  const text = stringValue(value).trim();
  const match = text.match(
    /(\d{4})(?:[/-](\d{1,2})[/-](\d{1,2})|(\d{2})(\d{2}))/,
  );
  if (!match) return undefined;
  const month = Number(match[2] ?? match[4]);
  const day = Number(match[3] ?? match[5]);
  const date = `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    return undefined;
  return date;
}

function dateTimeWithTaipeiOffset(date: string, time: string) {
  const match = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!time) return date;
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3] ?? 0) > 59
  )
    throw new Error("台新即時消費時間無效。");
  return `${date}T${String(Number(match[1])).padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}+08:00`;
}

function optionalNumber(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const text = stringValue(value)
    .replaceAll(",", "")
    .replace(/[^\d().+-]/g, "")
    .trim();
  if (!text) return undefined;
  const negative = /^\(.*\)$/.test(text);
  const number = Number(text.replace(/[()]/g, ""));
  if (!Number.isFinite(number)) return undefined;
  return negative ? -Math.abs(number) : number;
}

function optionalAbsoluteNumber(value: unknown) {
  const number = optionalNumber(value);
  return number == null ? undefined : Math.abs(number);
}

function last4(value: string) {
  return value.match(/(?:末四碼\s*[:：]?\s*|[*xX])(\d{4})\D*$/)?.[1];
}

function stringValue(value: unknown) {
  return value == null ? "" : String(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
