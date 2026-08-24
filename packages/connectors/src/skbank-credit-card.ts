import type {
  BankAccount,
  BankBalanceSnapshot,
  CreditCardBill,
} from "@taiwan-fin-hub/core";
import { BANK_SYNC_MONTHS } from "./sync-window";
import { SkbankProtocolError } from "./skbank";

type JsonRecord = Record<string, unknown>;

export type SkbankCreditCardPayloads = {
  assetsOverview: unknown;
  summary?: unknown;
  cards?: unknown;
  billingHistory?: unknown;
  remainingDue?: unknown;
};

export type SkbankCreditCardData = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

const CREDIT_ACCOUNT_SOURCE_ID = "credit:skbank:TWD";

export function hasSkbankCreditCard(payload: unknown) {
  const value = responseData(payload).HasValidCreditCard;
  if (typeof value !== "boolean") {
    warnSchemaMismatch("assetsOverview", "HasValidCreditCard", value);
    throw new SkbankProtocolError();
  }
  return value;
}

export function parseSkbankCreditCardData(
  payloads: SkbankCreditCardPayloads,
  now = new Date(),
): SkbankCreditCardData {
  if (!hasSkbankCreditCard(payloads.assetsOverview)) return emptyResult();

  const summary = responseData(payloads.summary);
  const cardsData = responseData(payloads.cards);
  const history = responseData(payloads.billingHistory);
  const remainingDueData = responseData(payloads.remainingDue);
  if (!Array.isArray(cardsData.CreditCardList)) {
    warnSchemaMismatch("cards", "CreditCardList", cardsData.CreditCardList);
    throw new SkbankProtocolError();
  }
  if (!Array.isArray(history.Bills)) {
    warnSchemaMismatch("billingHistory", "Bills", history.Bills);
    throw new SkbankProtocolError();
  }

  const cards = cardsData.CreditCardList.flatMap((value) => {
    if (!isRecord(value)) return [];
    const cardNumber = stringValue(value.CardNumber);
    const cardLast4 = lastDigits(cardNumber, 4);
    const cardName = safeText(value.CardName);
    return cardLast4 ? [{ cardLast4, cardName }] : [];
  });
  const creditLimit = numberValue(summary.CurrentCredit);
  const availableCredit = numberValue(summary.AvailableCredit);
  const statementBalance = numberValue(summary.CurrentStatementBalance);
  const minimumPayment = numberValue(summary.MinimumPaymentDue);
  const paymentDueDate = normalizeDate(summary.PaymentDueDate);
  const remainingDue = remainingDueValue(remainingDueData.RemainingDue);
  const statementMonth = numberValue(summary.StatementMonth);
  if (creditLimit == null) {
    warnSchemaMismatch("summary", "CurrentCredit", summary.CurrentCredit);
    throw new SkbankProtocolError();
  }
  if (availableCredit == null) {
    warnSchemaMismatch("summary", "AvailableCredit", summary.AvailableCredit);
    throw new SkbankProtocolError();
  }
  if (statementBalance == null) {
    warnSchemaMismatch(
      "summary",
      "CurrentStatementBalance",
      summary.CurrentStatementBalance,
    );
    throw new SkbankProtocolError();
  }
  if (minimumPayment == null) {
    warnSchemaMismatch(
      "summary",
      "MinimumPaymentDue",
      summary.MinimumPaymentDue,
    );
    throw new SkbankProtocolError();
  }
  if (remainingDue == null) {
    warnSchemaMismatch(
      "remainingDue",
      "RemainingDue",
      remainingDueData.RemainingDue,
    );
    throw new SkbankProtocolError();
  }
  if (
    statementMonth == null ||
    !Number.isInteger(statementMonth) ||
    statementMonth < 1 ||
    statementMonth > 12
  ) {
    warnSchemaMismatch("summary", "StatementMonth", summary.StatementMonth);
    throw new SkbankProtocolError();
  }
  const bills = history.Bills.flatMap((value) => parseBill(value))
    .sort((left, right) =>
      right.billingPeriod.localeCompare(left.billingPeriod),
    )
    .slice(0, BANK_SYNC_MONTHS);
  const currentBillIndex = bills.findIndex(
    ({ billingPeriod }) => Number(billingPeriod.slice(5, 7)) === statementMonth,
  );
  const currentPeriod = bills[currentBillIndex]?.billingPeriod;
  const statementClosingDate = currentPeriod
    ? dateFromPeriodAndDay(currentPeriod, summary.ClosingDate)
    : undefined;

  const bankAccounts: SkbankCreditCardData["bankAccounts"] = [
    {
      sourceId: CREDIT_ACCOUNT_SOURCE_ID,
      institutionName: "新光銀行",
      accountName:
        cards.length === 1 && cards[0]?.cardName
          ? cards[0].cardName
          : "新光銀行信用卡",
      accountType: "credit",
      currency: "TWD",
      creditLimit,
      raw: { cards },
    },
  ];
  const bankBalanceSnapshots: SkbankCreditCardData["bankBalanceSnapshots"] = [
    {
      accountId: CREDIT_ACCOUNT_SOURCE_ID,
      sourceId: `${CREDIT_ACCOUNT_SOURCE_ID}:${now.toISOString()}`,
      balance: remainingDue === 0 ? 0 : -Math.abs(remainingDue),
      availableBalance: availableCredit,
      statementBalance,
      paymentDueDate,
      statementClosingDate,
      noPaymentNeeded: remainingDue == null ? undefined : remainingDue === 0,
      currency: "TWD",
      asOfAt: now.toISOString(),
      raw: {
        currentStatementBalance: statementBalance,
        remainingDue,
        availableCredit,
      },
    },
  ];
  const creditCardBills = bills.map((bill, index) => {
    const isCurrent = index === currentBillIndex;
    const isInferredPaid =
      remainingDue === 0 &&
      currentPeriod != null &&
      bill.billingPeriod < currentPeriod;
    const paidAmount = isCurrent
      ? Math.max(bill.statementAmount - Math.max(remainingDue, 0), 0)
      : isInferredPaid
        ? bill.statementAmount
        : undefined;
    return {
      accountId: CREDIT_ACCOUNT_SOURCE_ID,
      sourceId: `${CREDIT_ACCOUNT_SOURCE_ID}:bill:${bill.billingPeriod}`,
      billingPeriod: bill.billingPeriod,
      statementAmount: bill.statementAmount,
      minimumPayment: isCurrent ? minimumPayment : undefined,
      paidAmount,
      isPaid: isCurrent ? remainingDue <= 0 : isInferredPaid || undefined,
      paymentDueDate: isCurrent ? paymentDueDate : undefined,
      statementClosingDate: isCurrent ? statementClosingDate : undefined,
      currency: "TWD",
      raw: {
        ...bill,
        ...(isInferredPaid
          ? { statusSource: "inferred_from_current_zero_remaining_due" }
          : {}),
      },
    };
  });

  return { bankAccounts, bankBalanceSnapshots, creditCardBills };
}

function parseBill(value: unknown) {
  if (!isRecord(value)) return [];
  const rawYear = numberValue(value.Year);
  const month = numberValue(value.Month);
  const statementAmount = numberValue(value.StatementBalance);
  if (rawYear == null || month == null || statementAmount == null) return [];
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return [];
  }
  const billingPeriod = `${year}-${String(month).padStart(2, "0")}`;
  return [{ billingPeriod, statementAmount: Math.abs(statementAmount) }];
}

function dateFromPeriodAndDay(period: string, value: unknown) {
  const day = numberValue(value);
  if (day == null || !Number.isInteger(day) || day < 1 || day > 31) {
    return undefined;
  }
  return normalizeDate(`${period}-${String(day).padStart(2, "0")}`);
}

function normalizeDate(value: unknown) {
  const text = stringValue(value).trim().replace(/[./]/g, "-");
  const match = /^(\d{3,4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = rawYear < 1911 ? rawYear + 1911 : rawYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
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

function responseData(payload: unknown): JsonRecord {
  if (!isRecord(payload)) return {};
  return isRecord(payload.Data) ? payload.Data : payload;
}

function safeText(value: unknown) {
  const text = stringValue(value).trim();
  return (
    text
      .replace(/\d(?:[\s-]*\d){4,}/g, (matched) => {
        const digits = matched.replace(/\D/g, "");
        return `••••${digits.slice(-4)}`;
      })
      .trim() || undefined
  );
}

function lastDigits(value: string, count: number) {
  return value.replace(/\D/g, "").slice(-count);
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[,$\s]/g, "").trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function remainingDueValue(value: unknown) {
  if (typeof value === "string" && value.trim() === "本期帳單無欠款") {
    return 0;
  }
  return numberValue(value);
}

function warnSchemaMismatch(
  section:
    "assetsOverview" | "cards" | "billingHistory" | "summary" | "remainingDue",
  field:
    | "HasValidCreditCard"
    | "CreditCardList"
    | "Bills"
    | "CurrentCredit"
    | "AvailableCredit"
    | "CurrentStatementBalance"
    | "MinimumPaymentDue"
    | "RemainingDue"
    | "StatementMonth",
  value: unknown,
) {
  console.warn({
    event: "skbank_credit_card_schema_mismatch",
    section,
    field,
    valueType: valueType(value),
  });
}

function valueType(value: unknown) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "string_empty";
    if (text === "查無資料") return "string_no_data";
    if (/^[-–—]+$/u.test(text)) return "string_placeholder";
    if (/^\([\d,.\s]+\)$/u.test(text)) return "string_parenthesized_amount";
    const withoutCurrency = text
      .replace(/新臺幣|臺幣|台幣|NT\$|TWD|NTD|元/giu, "")
      .replace(/[$,\s]/gu, "");
    if (/^[+-]?\d+(?:\.\d+)?$/u.test(withoutCurrency)) {
      return "string_currency_amount";
    }
    return "string_other";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return typeof value;
  }
  return "unknown";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function emptyResult(): SkbankCreditCardData {
  return { bankAccounts: [], bankBalanceSnapshots: [], creditCardBills: [] };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
