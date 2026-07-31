import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "@taiwan-fin-hub/core";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "./sync-window";

/** 中國信託行動銀行 API 連接器設定。機密欄位由 Worker 加密保存。 */
export const ctbcConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
});

export type CtbcConfig = z.infer<typeof ctbcConfigSchema>;

export function parseCtbcConfig(config: unknown): CtbcConfig {
  return ctbcConfigSchema.parse(config);
}

export type CtbcPayloads = {
  depositOverview: unknown;
  depositTransactions: unknown;
  creditCards: unknown;
  unbilled?: unknown;
  realtime?: unknown;
};

export type CtbcData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

type JsonRecord = Record<string, unknown>;
type CtbcDepositAccount = {
  accountId: string;
  balance: number;
  availableBalance?: number;
  acctType?: string;
  accountNickName?: string;
  actDigSvType?: string;
};
type CreditCardGroup = {
  currency: string;
  currencyName?: string;
  billingPeriod: string;
  currentPayment?: number;
  minimumPayment?: number;
  paymentDueDate?: string;
  statementClosingDate?: string;
  statementAmount?: number;
  paidAmount?: number;
  adjustment?: number;
  raw: JsonRecord;
  bills: JsonRecord[];
};
type CtbcCardTransactionCandidate = Omit<
  BankTransaction,
  "id" | "connectorId" | "sourceId"
> & {
  matchKey: string;
  identityKey: string;
};

const TWD = "TWD";

/**
 * Converts the observed CTBC response envelopes into the project's neutral
 * bank records. The parser deliberately accepts unknown payloads so the Worker
 * adapter can surface a protocol error separately without leaking responses.
 */
export function parseCtbcData(
  payloads: CtbcPayloads,
  now = new Date(),
): CtbcData {
  const deposits = parseDepositAccounts(payloads.depositOverview);
  const accountSourceIds = new Map(
    deposits.map((account) => [
      account.accountId,
      depositSourceId(account.accountId),
    ]),
  );

  const bankAccounts: CtbcData["bankAccounts"] = deposits.map((account) => ({
    sourceId: accountSourceIds.get(account.accountId)!,
    institutionName: "中國信託商業銀行",
    accountName: account.accountNickName || "中國信託存款帳戶",
    accountType: depositAccountType(account),
    currency: TWD,
    raw: sanitizeDepositAccount(account),
  }));
  const bankBalanceSnapshots: CtbcData["bankBalanceSnapshots"] = deposits.map(
    (account) => {
      const sourceId = accountSourceIds.get(account.accountId)!;
      return {
        accountId: sourceId,
        sourceId: `${sourceId}:${now.toISOString()}`,
        balance: account.balance,
        availableBalance: account.availableBalance,
        currency: TWD,
        asOfAt: now.toISOString(),
        raw: sanitizeDepositAccount(account),
      };
    },
  );

  const bankTransactions = parseDepositTransactions(
    payloads.depositTransactions,
    accountSourceIds,
  );
  const creditCardGroups = parseCreditCardGroups(payloads.creditCards)
    .sort(compareCreditCardGroups)
    .slice(0, BANK_SYNC_MONTHS * 8);
  const selectedGroups = selectGroupsByCurrency(creditCardGroups);
  const unbilledTransactions = parseUnbilledTransactions(payloads.unbilled);
  const realtimeTransactions = parseRealtimeTransactions(payloads.realtime);
  const cardMetadata = parseCardMetadata(payloads.creditCards);
  const cardCurrencies = Array.from(
    new Set([
      ...selectedGroups.map((group) => group.currency),
      ...unbilledTransactions.map((transaction) => transaction.currency),
      ...realtimeTransactions.map((transaction) => transaction.currency),
    ]),
  );
  const cardAccounts = buildCreditCardAccounts(cardCurrencies, cardMetadata);
  bankAccounts.push(...cardAccounts);
  bankBalanceSnapshots.push(...buildCreditCardSnapshots(selectedGroups, now));

  const creditCardBills = selectedGroups.map((group) => ({
    accountId: creditCardSourceId(group.currency),
    sourceId: `${creditCardSourceId(group.currency)}:bill:${group.billingPeriod}`,
    billingPeriod: group.billingPeriod,
    statementAmount: group.statementAmount,
    minimumPayment: group.minimumPayment,
    paidAmount: group.paidAmount,
    isPaid:
      group.statementAmount != null && group.paidAmount != null
        ? group.paidAmount >= group.statementAmount
        : undefined,
    paymentDueDate: group.paymentDueDate,
    statementClosingDate: group.statementClosingDate,
    currency: group.currency,
    raw: sanitizeCreditCardGroup(group),
  }));
  bankTransactions.push(
    ...reconcileCreditCardLifecycle(
      [...parseCreditCardTransactions(selectedGroups), ...unbilledTransactions],
      realtimeTransactions,
    ),
  );

  return {
    bankAccounts: dedupeBySourceId(bankAccounts),
    bankBalanceSnapshots: dedupeBySourceId(bankBalanceSnapshots),
    bankTransactions: dedupeBySourceId(bankTransactions),
    creditCardBills: dedupeBySourceId(creditCardBills),
  };
}

function parseDepositAccounts(payload: unknown): CtbcDepositAccount[] {
  const rsData = responseData(payload);
  const infoList = arrayAt(
    recordAt(
      recordAt(rsData, "twdAcctSummaryResponse"),
      "demDepBalSummaryResponse",
    ),
    "infoList",
  );
  return infoList.flatMap((value) => {
    if (!isRecord(value)) return [];
    const accountId = stringValue(value.accountId).trim();
    const balance = numberValue(value.balance);
    if (!accountId || balance == null) return [];
    return [
      {
        accountId,
        balance,
        availableBalance: numberValue(value.availableBalance),
        acctType: optionalString(value.acctType),
        accountNickName: optionalString(value.accountNickName),
        actDigSvType: optionalString(value.actDigSvType),
      },
    ];
  });
}

function parseDepositTransactions(
  payload: unknown,
  accountSourceIds: Map<string, string>,
) {
  const detailList = arrayAt(responseData(payload), "detailList");
  const occurrences = new Map<string, number>();
  return detailList.flatMap<Omit<BankTransaction, "id" | "connectorId">>(
    (value) => {
      if (!isRecord(value)) return [];
      // `acctId` is the counterparty account in CTBC's detail response. The
      // Worker adapter adds the selected account separately while the response
      // is still associated with its request envelope.
      const accountId = stringValue(value.sourceAccountId).trim();
      const rawDebit = numberValue(value.dbAmt) ?? 0;
      const rawCredit = numberValue(value.crAmt) ?? 0;
      const amount =
        rawCredit !== 0 ? Math.abs(rawCredit) : -Math.abs(rawDebit);
      if (!accountId || amount === 0) return [];
      const sourceAccountId =
        accountSourceIds.get(accountId) ?? depositSourceId(accountId);
      const postedDate = normalizeDate(value.trnDtFull) ?? undefined;
      const description =
        optionalString(value.memo1) ||
        optionalString(value.passBookMemo) ||
        optionalString(value.memo2) ||
        "中國信託帳戶交易";
      const sourceKey = [
        sourceAccountId,
        postedDate ?? "",
        amount,
        description,
        stringValue(value.defaultSeq),
        numberValue(value.balanceAmt) ?? "",
      ].join(":");
      const occurrence = (occurrences.get(sourceKey) ?? 0) + 1;
      occurrences.set(sourceKey, occurrence);
      return [
        {
          accountId: sourceAccountId,
          sourceId: `ctbc:deposit:tx:${stableHash(sourceKey)}:${occurrence}`,
          postedDate,
          amount,
          currency: TWD,
          description,
          counterparty: optionalString(value.memo2),
          status: "posted",
          raw: sanitizeDepositTransaction(value, accountId),
        },
      ];
    },
  );
}

function parseCreditCardGroups(payload: unknown): CreditCardGroup[] {
  const rsData = responseData(payload);
  const billData = recordAt(rsData, "billData");
  if (!isRecord(billData)) return [];
  const currencyNames = new Map(
    arrayAt(rsData, "curDataList").flatMap((value) => {
      if (!isRecord(value)) return [];
      const code = normalizeCurrency(value.curCode);
      return code ? [[code, optionalString(value.curName)] as const] : [];
    }),
  );
  const groups: CreditCardGroup[] = [];
  for (const [currencyKey, currencyValue] of Object.entries(billData)) {
    const currency = normalizeCurrency(currencyKey) ?? TWD;
    if (!isRecord(currencyValue)) continue;
    for (const [periodKey, groupValue] of Object.entries(currencyValue)) {
      if (!isRecord(groupValue)) continue;
      const summary = isRecord(groupValue.summary)
        ? groupValue.summary
        : groupValue;
      const billingPeriod =
        normalizeBillingPeriod(periodKey) ??
        billingPeriodFromDate(summary.billDt) ??
        billingPeriodFromDate(summary.pmtExpDt);
      if (!billingPeriod) continue;
      groups.push({
        currency,
        currencyName: currencyNames.get(currency),
        billingPeriod,
        currentPayment: numberValue(summary.currPmtAmt),
        minimumPayment: numberValue(summary.minPmtAmt),
        paymentDueDate: normalizeDate(summary.pmtExpDt) ?? undefined,
        statementClosingDate: normalizeDate(summary.billDt) ?? undefined,
        statementAmount: numberValue(summary.billAmt),
        paidAmount: numberValue(summary.pmtAmt),
        adjustment: numberValue(summary.adjust),
        raw: summary,
        bills: arrayAt(groupValue, "bills").filter(isRecord),
      });
    }
  }
  return groups;
}

function selectGroupsByCurrency(groups: CreditCardGroup[]) {
  const selected: CreditCardGroup[] = [];
  const byCurrency = new Map<string, CreditCardGroup[]>();
  for (const group of groups) {
    const list = byCurrency.get(group.currency) ?? [];
    list.push(group);
    byCurrency.set(group.currency, list);
  }
  for (const currencyGroups of byCurrency.values()) {
    selected.push(
      ...currencyGroups
        .sort(compareCreditCardGroups)
        .slice(0, BANK_SYNC_MONTHS),
    );
  }
  return selected;
}

function buildCreditCardAccounts(
  currencies: string[],
  metadata: Array<{
    cardLast4?: string;
    cardName?: string;
    positiveOrAttached?: string;
  }>,
) {
  return currencies.map((currency) => ({
    sourceId: creditCardSourceId(currency),
    institutionName: "中國信託商業銀行",
    accountName:
      metadata[0]?.cardName ||
      `${metadata[0]?.positiveOrAttached || ""}中國信託信用卡`.trim(),
    accountType: "credit" as const,
    currency,
    raw: {
      cards: metadata.map((card) => ({
        cardLast4: card.cardLast4,
        cardName: card.cardName,
        positiveOrAttached: card.positiveOrAttached,
      })),
    },
  }));
}

function buildCreditCardSnapshots(groups: CreditCardGroup[], now: Date) {
  const newestByCurrency = new Map<string, CreditCardGroup>();
  for (const group of groups.sort(compareCreditCardGroups)) {
    if (!newestByCurrency.has(group.currency))
      newestByCurrency.set(group.currency, group);
  }
  return Array.from(newestByCurrency.values()).map((group) => {
    const remainingDue = remainingDueForGroup(group);
    const sourceId = creditCardSourceId(group.currency);
    return {
      accountId: sourceId,
      sourceId: `${sourceId}:${now.toISOString()}`,
      balance: remainingDue == null ? 0 : -Math.abs(remainingDue),
      statementBalance: group.statementAmount,
      availableBalance: undefined,
      paymentDueDate: group.paymentDueDate,
      statementClosingDate: group.statementClosingDate,
      noPaymentNeeded: remainingDue == null ? undefined : remainingDue === 0,
      currency: group.currency,
      asOfAt: now.toISOString(),
      raw: sanitizeCreditCardGroup(group),
    };
  });
}

function parseCreditCardTransactions(groups: CreditCardGroup[]) {
  const transactions: CtbcCardTransactionCandidate[] = [];
  for (const group of groups) {
    for (const bill of group.bills) {
      const purchaseDate = normalizeDate(bill.purchaseDt) ?? undefined;
      const postedDate =
        normalizeDate(bill.postingDt) ??
        normalizeDate(bill.clearingDt) ??
        purchaseDate;
      const description =
        optionalString(bill.merchantChiName) || "中國信託信用卡消費";
      const rawAmount =
        group.currency === TWD
          ? numberValue(bill.ntAmt)
          : (numberValue(bill.foreignAmt) ?? numberValue(bill.ntAmt));
      if (rawAmount == null || rawAmount === 0) continue;
      const refund =
        rawAmount < 0 ||
        /退款|退貨|折讓|沖銷|回饋|繳款|refund|credit|payment/i.test(
          description,
        );
      const amount = refund ? Math.abs(rawAmount) : -Math.abs(rawAmount);
      const cardLast4 =
        last4(stringValue(bill.cardNo)) ?? last4(stringValue(bill.fullCardNo));
      const matchKey = [
        group.currency,
        purchaseDate ?? "",
        amount,
        cardLast4,
      ].join(":");
      const identityKey = [
        matchKey,
        normalizeMerchantName(description),
        stringValue(bill.sorting),
      ].join(":");
      transactions.push({
        accountId: creditCardSourceId(group.currency),
        postedDate,
        authorizedAt: purchaseDate,
        amount,
        currency: group.currency,
        description,
        counterparty: description,
        status: "posted",
        raw: sanitizeCreditCardTransaction(bill),
        matchKey,
        identityKey,
      });
    }
  }
  return transactions;
}

function parseRealtimeTransactions(payload: unknown) {
  const items = arrayAt(responseData(payload), "allItems");
  return items.flatMap<CtbcCardTransactionCandidate>((value) => {
    if (!isRecord(value)) return [];
    const authorizedAt =
      normalizeDate(value.txnDate) ?? normalizeDate(value.txnDateTime);
    const rawAmount = numberValue(value.txnAmt);
    if (!authorizedAt || rawAmount == null || rawAmount === 0) return [];
    const description = optionalString(value.merchName) || "中國信託信用卡消費";
    const transactionType = optionalString(value.txnType) ?? "";
    const refund =
      rawAmount < 0 ||
      /退款|退貨|折讓|沖銷|回饋|繳款|refund|credit|payment/i.test(
        `${description} ${transactionType}`,
      );
    const amount = refund ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    const cardLast4 =
      last4(stringValue(value.cardNoSuffixFour)) ??
      last4(stringValue(value.cardNo));
    const matchKey = [TWD, authorizedAt, amount, cardLast4].join(":");
    return [
      {
        accountId: creditCardSourceId(TWD),
        authorizedAt,
        amount,
        currency: TWD,
        description,
        counterparty: description,
        status: "pending",
        raw: sanitizeRealtimeTransaction(value),
        matchKey,
        identityKey: [
          matchKey,
          normalizeMerchantName(description),
          stringValue(value.authCode),
        ].join(":"),
      },
    ];
  });
}

function parseUnbilledTransactions(payload: unknown) {
  const items = arrayAt(responseData(payload), "allItems");
  return items.flatMap<CtbcCardTransactionCandidate>((value) => {
    if (!isRecord(value)) return [];
    const purchaseDate = normalizeDate(value.purchaseDt) ?? undefined;
    const postedDate = normalizeDate(value.postingDt) ?? purchaseDate;
    const rawAmount = numberValue(value.ntAmt) ?? numberValue(value.txnAmt);
    if (!postedDate || rawAmount == null || rawAmount === 0) return [];
    const description =
      optionalString(value.merchantChiName) ||
      optionalString(value.merchName) ||
      "中國信託信用卡消費";
    const transactionType = optionalString(value.txnType) ?? "";
    const refund =
      rawAmount < 0 ||
      /退款|退貨|折讓|沖銷|回饋|繳款|refund|credit|payment/i.test(
        `${description} ${transactionType}`,
      );
    const amount = refund ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    const currency =
      normalizeCurrency(value.sourceCurrency ?? value.curCode) ?? TWD;
    const cardLast4 =
      last4(stringValue(value.cardNoSuffixFour)) ??
      last4(stringValue(value.cardNo));
    const matchKey = [
      currency,
      purchaseDate ?? postedDate,
      amount,
      cardLast4,
    ].join(":");
    return [
      {
        accountId: creditCardSourceId(currency),
        postedDate,
        authorizedAt: purchaseDate,
        amount,
        currency,
        description,
        counterparty: description,
        status: "posted",
        raw: sanitizeCreditCardTransaction(value),
        matchKey,
        identityKey: [
          matchKey,
          normalizeMerchantName(description),
          stringValue(value.authCode),
          stringValue(value.acwRefNbr),
        ].join(":"),
      },
    ];
  });
}

function reconcileCreditCardLifecycle(
  posted: CtbcCardTransactionCandidate[],
  pending: CtbcCardTransactionCandidate[],
) {
  const pendingByMatchKey = new Map<string, CtbcCardTransactionCandidate[]>();
  for (const transaction of pending) {
    const candidates = pendingByMatchKey.get(transaction.matchKey) ?? [];
    candidates.push(transaction);
    pendingByMatchKey.set(transaction.matchKey, candidates);
  }
  const consumedPending = new Set<CtbcCardTransactionCandidate>();
  const reconciledPosted = posted.map((transaction) => {
    const candidates = (
      pendingByMatchKey.get(transaction.matchKey) ?? []
    ).filter(
      (candidate) =>
        !consumedPending.has(candidate) &&
        merchantsMatch(transaction.description, candidate.description),
    );
    // A same-day, same-amount group must have exactly one merchant-confirmed
    // candidate before it can replace a pending authorization.
    if (candidates.length !== 1) return transaction;
    const candidate = candidates[0]!;
    consumedPending.add(candidate);
    return { ...transaction, identityKey: candidate.identityKey };
  });
  const all = [
    ...reconciledPosted,
    ...pending.filter((transaction) => !consumedPending.has(transaction)),
  ];
  const occurrences = new Map<string, number>();
  return all.map(({ matchKey: _matchKey, identityKey, ...transaction }) => {
    const occurrence = (occurrences.get(identityKey) ?? 0) + 1;
    occurrences.set(identityKey, occurrence);
    return {
      ...transaction,
      sourceId: `ctbc:card:tx:${stableHash(identityKey)}:${occurrence}`,
    };
  });
}

function merchantsMatch(left: string | undefined, right: string | undefined) {
  const leftNormalized = normalizeMerchantName(left ?? "");
  const rightNormalized = normalizeMerchantName(right ?? "");
  return (
    leftNormalized.length >= 2 &&
    rightNormalized.length >= 2 &&
    leftNormalized === rightNormalized
  );
}

function parseCardMetadata(payload: unknown) {
  return arrayAt(responseData(payload), "cardDataList").flatMap((value) => {
    if (!isRecord(value)) return [];
    return [
      {
        cardLast4: last4(stringValue(value.cardNoSuffixFour || value.cardNo)),
        cardName: optionalString(value.cardName),
        positiveOrAttached: optionalString(value.positiveOrAttached),
      },
    ];
  });
}

function remainingDueForGroup(group: CreditCardGroup) {
  if (group.currentPayment != null) return Math.max(0, group.currentPayment);
  if (group.statementAmount == null) return undefined;
  return Math.max(
    0,
    group.statementAmount - (group.paidAmount ?? 0) + (group.adjustment ?? 0),
  );
}

function sanitizeDepositAccount(account: CtbcDepositAccount) {
  return {
    accountLast4: last4(account.accountId),
    acctType: account.acctType,
    accountNickName: account.accountNickName,
    actDigSvType: account.actDigSvType,
  };
}

function sanitizeDepositTransaction(value: JsonRecord, accountId: string) {
  return {
    accountLast4: last4(accountId),
    trnDtFull: normalizeDate(value.trnDtFull),
    memo1: optionalString(value.memo1),
    memo2: optionalString(value.memo2),
    passBookMemo: optionalString(value.passBookMemo),
    defaultSeq: optionalString(value.defaultSeq),
    dbAmt: numberValue(value.dbAmt),
    crAmt: numberValue(value.crAmt),
    balanceAmt: numberValue(value.balanceAmt),
  };
}

function sanitizeCreditCardGroup(group: CreditCardGroup) {
  return {
    currency: group.currency,
    currencyName: group.currencyName,
    billingPeriod: group.billingPeriod,
    currPmtAmt: group.currentPayment,
    minPmtAmt: group.minimumPayment,
    pmtExpDt: group.paymentDueDate,
    billDt: group.statementClosingDate,
    prevBal: numberValue(group.raw.prevBal),
    billAmt: group.statementAmount,
    pmtAmt: group.paidAmount,
    adjust: group.adjustment,
  };
}

function sanitizeCreditCardTransaction(value: JsonRecord) {
  return {
    purchaseDt: normalizeDate(value.purchaseDt),
    postingDt: normalizeDate(value.postingDt),
    clearingDt: normalizeDate(value.clearingDt),
    merchantChiName: optionalString(value.merchantChiName),
    occCurCode: normalizeCurrency(value.occCurCode),
    foreignAmt: numberValue(value.foreignAmt),
    ntAmt: numberValue(value.ntAmt),
    cardLast4:
      last4(stringValue(value.cardNo)) ?? last4(stringValue(value.fullCardNo)),
    txCode: optionalString(value.txCode),
  };
}

function sanitizeRealtimeTransaction(value: JsonRecord) {
  return {
    txnCountry: optionalString(value.txnCountry),
    origCurCode: normalizeCurrency(value.origCurCode ?? value.origCurCo),
    merchName: optionalString(value.merchName),
    txnType: optionalString(value.txnType),
    cardLast4:
      last4(stringValue(value.cardNoSuffixFour)) ??
      last4(stringValue(value.cardNo)),
    txnDateTime: optionalString(value.txnDateTime),
    isDoubleCoinCard: value.isDoubleCoinCard === true,
    mccCode: optionalString(value.mccCode),
    txnDate: normalizeDate(value.txnDate),
    txnAmt: numberValue(value.txnAmt),
    txnDateMMDD: optionalString(value.txnDateMMDD),
  };
}

function depositSourceId(accountId: string) {
  return `bank:ctbc:${last4(accountId) || "unknown"}:${stableHash(accountId)}`;
}

function creditCardSourceId(currency: string) {
  return `credit:ctbc:${currency}`;
}

function depositAccountType(
  account: CtbcDepositAccount,
): "checking" | "savings" {
  const description = `${account.acctType ?? ""} ${account.actDigSvType ?? ""}`;
  return /支票|checking/i.test(description) ? "checking" : "savings";
}

function responseData(payload: unknown) {
  return recordAt(payload, "rsData");
}

function recordAt(value: unknown, key: string) {
  return isRecord(value) && isRecord(value[key]) ? value[key] : {};
}

function arrayAt(value: unknown, key: string) {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function compareCreditCardGroups(
  left: CreditCardGroup,
  right: CreditCardGroup,
) {
  return right.billingPeriod.localeCompare(left.billingPeriod);
}

function normalizeBillingPeriod(value: string) {
  const separated = value.match(/^(\d{3,4})[/-](\d{1,2})$/);
  if (separated)
    return periodFromParts(Number(separated[1]), Number(separated[2]));
  const compact = value.match(/^(\d{3,4})(\d{2})$/);
  return compact
    ? periodFromParts(Number(compact[1]), Number(compact[2]))
    : undefined;
}

function billingPeriodFromDate(value: unknown) {
  const normalized = normalizeDate(value);
  return normalized?.slice(0, 7);
}

function periodFromParts(year: number, month: number) {
  if (month < 1 || month > 12) return undefined;
  const fullYear = year < 1911 ? year + 1911 : year;
  return fullYear >= 2000 && fullYear <= 2200
    ? `${fullYear}-${String(month).padStart(2, "0")}`
    : undefined;
}

function normalizeDate(value: unknown) {
  const text = stringValue(value).trim().replace(/\./g, "/");
  const separated = /^(\d{3,4})[/-](\d{1,2})[/-](\d{1,2})/.exec(text);
  const compact = /^(\d{3,4})(\d{2})(\d{2})$/.exec(text);
  const parts = separated ?? compact;
  if (!parts) return undefined;
  const year =
    Number(parts[1]) < 1911 ? Number(parts[1]) + 1911 : Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeCurrency(value: unknown) {
  const code = stringValue(value).trim().toUpperCase();
  if (!code || code === "000" || code === "NTD") return TWD;
  if (code === "840") return "USD";
  if (code === "392") return "JPY";
  if (code === "978") return "EUR";
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function numberValue(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const normalized = stringValue(value)
    .trim()
    .replace(/[,$\s]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function optionalString(value: unknown) {
  const result = stringValue(value).trim();
  return result || undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function last4(value: string) {
  return value.match(/(\d{4})\D*$/)?.[1];
}

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeMerchantName(value: string) {
  return value.replace(/[\s\-_－—*＊()（）,.，。]/g, "").toLowerCase();
}

function dedupeBySourceId<T extends { sourceId: string }>(records: T[]) {
  return Array.from(
    new Map(records.map((record) => [record.sourceId, record])).values(),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
