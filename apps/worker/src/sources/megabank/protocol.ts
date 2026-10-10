import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
} from "@taiwan-fin-hub/shared";
import { z } from "zod";
import { BANK_SYNC_MONTHS } from "../sync-window";

export const megabankConfigSchema = z.object({
  userId: z.string().min(1).optional(),
  account: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  pendingSession: z.string().optional(),
  pendingSessionExpiresAt: z.string().optional(),
  captcha: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  otp: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
  deviceCode: z.string().min(1).max(64).optional(),
  deviceUKey: z.string().min(1).max(64).optional(),
  deviceSeed: z.string().min(1).max(64).optional(),
});

export type MegabankConfig = z.infer<typeof megabankConfigSchema>;
export const parseMegabankConfig = (config: unknown) =>
  megabankConfigSchema.parse(config);

type JsonRecord = Record<string, unknown>;
type Account = Omit<BankAccount, "id" | "connectorId">;
type Snapshot = Omit<BankBalanceSnapshot, "id" | "connectorId">;
type Transaction = Omit<BankTransaction, "id" | "connectorId">;
type Bill = Omit<CreditCardBill, "id" | "connectorId">;

export type MegabankPayloads = {
  deposits: unknown;
  depositTransactions: Array<{
    accountNo: string;
    currency: string;
    response: unknown;
  }>;
  cardOverview: unknown;
  cardBills: unknown;
  cardHome: unknown;
  cardTransactions: unknown;
};

export type MegabankData = {
  bankAccounts: Account[];
  bankBalanceSnapshots: Snapshot[];
  bankTransactions: Transaction[];
  creditCardBills: Bill[];
};

export function parseMegabankData(
  payloads: MegabankPayloads,
  now = new Date(),
): MegabankData {
  const asOfAt = now.toISOString();
  const depositRows = arrayAt(dataAt(payloads.deposits), "depositInfoList");
  const bankAccounts: Account[] = [];
  const bankBalanceSnapshots: Snapshot[] = [];
  const accountIds = new Map<string, string>();
  const deposits = new Map<
    string,
    {
      accountNo: string;
      currency: string;
      balance: number;
      name: string;
    }
  >();
  for (const row of depositRows) {
    if (!isRecord(row)) throw new Error("兆豐存款清單格式無法辨識。");
    const accountNo = stringAt(row, "DRACT");
    const currency = currencyAt(row.DRCUR);
    const balance = numberAt(row.AVLBA);
    if (!accountNo || !currency || balance === undefined) {
      throw new Error("兆豐存款帳戶或餘額欄位無法辨識。");
    }
    const key = `${accountNo}:${currency}`;
    const previous = deposits.get(key);
    deposits.set(key, {
      accountNo,
      currency,
      balance: (previous?.balance ?? 0) + balance,
      name: previous?.name || stringAt(row, "NAME"),
    });
  }
  for (const { accountNo, currency, balance, name } of deposits.values()) {
    const sourceId = `bank:megabank:${last4(accountNo)}:${hash(accountNo)}:${currency}`;
    accountIds.set(`${accountNo}:${currency}`, sourceId);
    bankAccounts.push({
      sourceId,
      institutionName: "兆豐銀行",
      accountName:
        name.replace(/\d{6,}/g, "••••") || `兆豐存款末四碼 ${last4(accountNo)}`,
      accountType: /定存|定期/.test(name) ? "time_deposit" : "savings",
      currency,
      raw: { last4: last4(accountNo) },
    });
    bankBalanceSnapshots.push({
      accountId: sourceId,
      sourceId: `${sourceId}:${asOfAt}`,
      balance,
      availableBalance: balance,
      currency,
      asOfAt,
    });
  }

  const bankTransactions: Transaction[] = [];
  const depositOccurrences = new Map<string, number>();
  for (const item of payloads.depositTransactions) {
    const accountId = accountIds.get(`${item.accountNo}:${item.currency}`);
    if (!accountId) continue;
    for (const value of arrayAt(dataAt(item.response), "list")) {
      if (!isRecord(value)) throw new Error("兆豐存款交易格式無法辨識。");
      const amountValue = numberAt(value.amount);
      const date = dateAt(value.txDate);
      if (amountValue === undefined || !date) {
        throw new Error("兆豐存款交易日期或金額無法辨識。");
      }
      const direction = stringAt(value, "DRCR").toUpperCase();
      if (direction !== "C" && direction !== "D") {
        throw new Error("兆豐存款交易方向無法辨識。");
      }
      const amount = (direction === "D" ? -1 : 1) * Math.abs(amountValue);
      const description = stringAt(value, "paymentItem") || "兆豐存款交易";
      // 不可納入 serialNo／seq：實際上它們是當天的交易順序而非穩定編號，同一天稍後
      // 又有新交易入帳時，先前交易的順序欄位會跟著變動，導致同一筆被當成新交易重複寫入。
      // 同日同額同摘要的多筆交易以 occurrence 區分。
      const key = [accountId, date, amount, description].join("|");
      const occurrence = depositOccurrences.get(key) ?? 0;
      depositOccurrences.set(key, occurrence + 1);
      bankTransactions.push({
        accountId,
        sourceId: `megabank:deposit:tx:${hash(key)}:${occurrence}`,
        postedDate: date,
        authorizedAt: date,
        amount,
        currency: item.currency,
        description,
        status: "posted",
      });
    }
  }

  const billValues = [
    "generalRecordList",
    "fancyRecordList",
    "ridoRecordList",
  ].flatMap((key) => arrayAt(dataAt(payloads.cardBills), key));
  if (billValues.some((value) => !isRecord(value))) {
    throw new Error("兆豐信用卡帳單格式無法辨識。");
  }
  const billRows = billValues.filter(isRecord);
  const overviewRows = arrayAt(
    dataAt(payloads.cardOverview),
    "creditCardBillInfoList",
  ).filter(isRecord);
  const cardGroups = new Map<
    string,
    {
      amount: number;
      minimum: number;
      paid: number;
      due?: string;
      minimumKnown: boolean;
      paidKnown: boolean;
    }
  >();
  for (const row of billRows) {
    if (stringAt(row, "acctMon") === "999912") continue;
    const currency = currencyAt(row.currCode);
    const period = periodAt(row.acctMon);
    const amount = numberAt(row.thisTtlAmt);
    if (!currency || !period || amount === undefined) {
      throw new Error("兆豐信用卡帳單欄位無法辨識。");
    }
    const key = `${currency}:${period}`;
    const group = cardGroups.get(key) ?? {
      amount: 0,
      minimum: 0,
      paid: 0,
      minimumKnown: true,
      paidKnown: true,
    };
    group.amount += amount;
    const minimum = numberAt(row.minPay);
    const paid = numberAt(row.thisPayAmt);
    group.minimum += minimum ?? 0;
    group.paid += paid ?? 0;
    group.minimumKnown &&= minimum !== undefined;
    group.paidKnown &&= paid !== undefined;
    group.due = dateAt(row.lastpayDate) ?? group.due;
    cardGroups.set(key, group);
  }
  const latestPeriods = [
    ...new Set([...cardGroups.keys()].map((key) => key.slice(4))),
  ]
    .sort()
    .reverse()
    .slice(0, BANK_SYNC_MONTHS);
  const creditCardBills: Bill[] = [];
  const cardCurrencies = new Set<string>();
  for (const [key, group] of cardGroups) {
    const [currency, period] = key.split(":");
    if (!currency || !period || !latestPeriods.includes(period)) continue;
    cardCurrencies.add(currency);
    const accountId = cardAccountId(currency);
    creditCardBills.push({
      accountId,
      sourceId: `${accountId}:bill:${period}`,
      billingPeriod: period,
      statementAmount: group.amount,
      minimumPayment: group.minimumKnown ? group.minimum : undefined,
      paidAmount: group.paidKnown ? group.paid : undefined,
      isPaid: group.paidKnown ? group.amount <= group.paid : undefined,
      paymentDueDate: group.due,
      currency,
    });
  }
  for (const row of overviewRows) {
    const currency = currencyAt(row.CURR_CODE);
    if (currency) cardCurrencies.add(currency);
  }
  const cardOccurrences = new Map<string, number>();
  for (const outer of arrayAt(
    dataAt(payloads.cardTransactions),
    "detailList",
  )) {
    if (!isRecord(outer)) throw new Error("兆豐信用卡交易格式無法辨識。");
    const rows = Array.isArray(outer.detailList) ? outer.detailList : [outer];
    for (const value of rows) {
      if (!isRecord(value)) throw new Error("兆豐信用卡交易格式無法辨識。");
      const currency = currencyAt(value.destinationCurr ?? value.sourceCurr);
      const amountValue = numberAt(value.destinationAmt ?? value.sourceAmt);
      const originalAmount = numberAt(value.sourceAmt) ?? amountValue;
      const originalCurrency = currencyAt(value.sourceCurr) ?? currency;
      const date = dateAt(value.purchaseDate);
      if (
        !currency ||
        amountValue === undefined ||
        originalAmount === undefined ||
        !date
      ) {
        throw new Error("兆豐信用卡交易日期或金額無法辨識。");
      }
      cardCurrencies.add(currency);
      const cardNo = stringAt(value, "cardNo") || stringAt(outer, "cardNo");
      const description =
        stringAt(value, "merchantChiName") || "兆豐信用卡交易";
      const key = [
        hash(cardNo),
        date,
        description,
        originalAmount,
        originalCurrency,
      ].join("|");
      const occurrence = cardOccurrences.get(key) ?? 0;
      cardOccurrences.set(key, occurrence + 1);
      const pending = stringAt(value, "acctMon") === "999912";
      bankTransactions.push({
        accountId: cardAccountId(currency),
        sourceId: `megabank:card:tx:${hash(key)}:${occurrence}`,
        authorizedAt: date,
        postedDate: pending
          ? undefined
          : dateAt(value.postDate ?? value.accountDate),
        amount: signedCardAmount(amountValue, description),
        currency,
        description,
        status: pending ? "pending" : "posted",
        raw: { cardLast4: last4(cardNo) },
      });
    }
  }
  if (
    arrayAt(dataAt(payloads.cardHome), "cardNumbers").length > 0 &&
    cardCurrencies.size === 0
  ) {
    cardCurrencies.add("TWD");
  }
  for (const currency of cardCurrencies) {
    const accountId = cardAccountId(currency);
    bankAccounts.push({
      sourceId: accountId,
      institutionName: "兆豐銀行",
      accountName: `兆豐信用卡（${currency}）`,
      accountType: "credit",
      currency,
    });
    const rows = overviewRows.filter(
      (row) => currencyAt(row.CURR_CODE) === currency,
    );
    if (rows.length === 0) continue;
    const accountTypes = new Map<
      string,
      { recorded?: JsonRecord; unrecorded?: JsonRecord }
    >();
    let complete = true;
    for (const row of rows) {
      const type = stringAt(row, "ACCT_TYPE");
      const period = stringAt(row, "ACCT_MON");
      if (!type) {
        complete = false;
        continue;
      }
      const group = accountTypes.get(type) ?? {};
      if (period === "999912") {
        group.unrecorded = row;
      } else if (
        periodAt(period) &&
        (!group.recorded || period > stringAt(group.recorded, "ACCT_MON"))
      ) {
        group.recorded = row;
      }
      accountTypes.set(type, group);
    }
    let billed = 0;
    let unbilled = 0;
    complete &&= accountTypes.size > 0;
    for (const group of accountTypes.values()) {
      if (!group.recorded && !group.unrecorded) complete = false;
      if (group.recorded) {
        const amount = numberAt(group.recorded.THIS_TTL_AMT);
        const paid = numberAt(group.recorded.PAYMENT_AMT);
        if (amount === undefined || paid === undefined) complete = false;
        else billed += Math.max(0, amount - paid);
      }
      if (group.unrecorded) {
        const amount = numberAt(group.unrecorded.THIS_TTL_AMT);
        if (amount === undefined) complete = false;
        else unbilled += amount;
      }
    }
    if (!complete) continue;
    bankBalanceSnapshots.push({
      accountId,
      sourceId: `${accountId}:${asOfAt}`,
      balance: -(billed + unbilled),
      statementBalance: billed,
      currency,
      asOfAt,
    });
  }
  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions: dedupe(bankTransactions),
    creditCardBills,
  };
}

/** 貸款解析結果；無法辨識時只略過貸款並回報原因，不影響存款與信用卡同步。 */
export type MegabankLoanData = {
  bankAccounts: Account[];
  bankBalanceSnapshots: Snapshot[];
  issue?:
    | "loan_list_missing"
    | "loan_number_missing"
    | "loan_balance_missing"
    | "loan_terms_missing";
};

const LOAN_NUMBER_KEYS = ["loanNo", "loanAccNo", "loanAcctNo", "acctNo"];
const LOAN_BALANCE_KEYS = ["loanBal", "loanBalance"];

/**
 * 兆豐貸款：貸款清單與條件取「我的貸款」`/fln/fln01001/home`，剩餘本金優先用同一筆的
 * `loanBal`，沒有時以貸款帳號對應存款總覽 `/fco/fco10001/home` 的 `loanInfoList`。
 * 貸款種類含住宅／購屋／房屋／房貸即視為自住房貸（loanCategory = "housing"），
 * 其他貸款為 "other"；sourceId 一律是 `loan:megabank:<hash>`。帳號只用於對應與雜湊，raw 只留末四碼。
 */
export function parseMegabankLoans(
  deposits: unknown,
  loanList: unknown,
  now = new Date(),
): MegabankLoanData {
  const empty = { bankAccounts: [], bankBalanceSnapshots: [] };
  const loanRows = findLoanRows(dataAt(loanList));
  if (!loanRows) return { ...empty, issue: "loan_list_missing" };
  const overviewBalances = new Map<string, number>();
  for (const row of arrayAt(dataAt(deposits), "loanInfoList")) {
    if (!isRecord(row)) continue;
    const loanNo = firstString(row, LOAN_NUMBER_KEYS);
    const balance = firstNumber(row, LOAN_BALANCE_KEYS);
    if (loanNo && balance !== undefined) overviewBalances.set(loanNo, balance);
  }
  const asOfAt = now.toISOString();
  const bankAccounts: Account[] = [];
  const bankBalanceSnapshots: Snapshot[] = [];
  for (const row of loanRows) {
    const loanNo = firstString(row, LOAN_NUMBER_KEYS);
    if (!loanNo) return { ...empty, issue: "loan_number_missing" };
    const balance =
      firstNumber(row, LOAN_BALANCE_KEYS) ?? overviewBalances.get(loanNo);
    if (balance === undefined) {
      return { ...empty, issue: "loan_balance_missing" };
    }
    const loanType =
      firstString(row, ["loanName", "loanTypeName", "loanType"]) || "兆豐貸款";
    const loanTypeText = ["loanName", "loanTypeName", "loanType"]
      .map((key) => stringAt(row, key))
      .join(" ");
    const initialAmount = numberAt(row.loanAmt);
    const annualRatePct = numberAt(stringAt(row, "intRate").replace(/%$/, ""));
    const drawdownDate = loanDateAt(row.loanStartDate);
    const endDate = loanDateAt(row.loanEndDate);
    if (initialAmount === undefined || !drawdownDate) {
      return { ...empty, issue: "loan_terms_missing" };
    }
    const totalPeriods = endDate ? monthsBetween(drawdownDate, endDate) : 0;
    const currentPeriod = digitsAt(row.payPeriod);
    const housing = /住宅|購屋|房屋|房貸/.test(loanTypeText);
    const sourceId = `loan:megabank:${hash(loanNo)}`;
    const currency = currencyAt(row.loanCurr) ?? "TWD";
    const remaining = -Math.abs(balance);
    const remainingPeriods =
      totalPeriods > 0 && currentPeriod !== undefined
        ? Math.max(0, totalPeriods - currentPeriod + 1)
        : undefined;
    const paymentAmount = numberAt(row.payAmt);
    bankAccounts.push({
      sourceId,
      institutionName: "兆豐銀行",
      accountName: `${loanType} 末四碼 ${last4(loanNo)}`,
      accountType: "loan",
      loanCategory: housing ? "housing" : "other",
      ...(annualRatePct !== undefined
        ? { loanInterestRate: annualRatePct }
        : {}),
      currency,
      raw: {
        last4: last4(loanNo),
        initialAmount,
        totalPeriods: totalPeriods > 0 ? totalPeriods : undefined,
        remainingPeriods,
        annualRatePct,
        paymentDay: digitsAt(row.deductionDate),
        nextPaymentDate: loanDateAt(row.payDate),
        nextPaymentAmount: numberAt(row.payAmt),
        drawdownDate,
      },
    });
    bankBalanceSnapshots.push({
      accountId: sourceId,
      sourceId: `snapshot:${sourceId}:${asOfAt.slice(0, 10)}`,
      balance: remaining,
      currency,
      asOfAt,
      ...(paymentAmount !== undefined
        ? { loanPaymentAmount: paymentAmount }
        : {}),
      ...(totalPeriods > 0 && remainingPeriods !== undefined
        ? {
            loanInstallmentsPaid: totalPeriods - remainingPeriods,
            loanInstallmentsTotal: totalPeriods,
          }
        : {}),
      raw: { balance: remaining },
    });
  }
  return { bankAccounts, bankBalanceSnapshots };
}

/** 回應內第一個元素帶有貸款帳號欄位的陣列（含一層巢狀）；找不到回傳 undefined。 */
function findLoanRows(data: JsonRecord): JsonRecord[] | undefined {
  const candidates = [
    ...Object.values(data),
    ...Object.values(data).flatMap((value) =>
      isRecord(value) ? Object.values(value) : [],
    ),
  ];
  for (const value of candidates) {
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(isRecord) &&
      value.every((row) => firstString(row, LOAN_NUMBER_KEYS))
    ) {
      return value;
    }
  }
  return undefined;
}
function firstString(row: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = stringAt(row, key);
    if (value) return value;
  }
  return "";
}
function firstNumber(row: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberAt(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}
function digitsAt(value: unknown): number | undefined {
  const match = /\d+/.exec(
    typeof value === "number" ? String(value) : String(value ?? ""),
  );
  return match ? Number(match[0]) : undefined;
}
/** 西元 yyyy/mm/dd、yyyymmdd 或民國 yyy/mm/dd。 */
function loanDateAt(value: unknown): string | undefined {
  const western = dateAt(value);
  if (western) return western;
  if (typeof value !== "string") return undefined;
  const roc = /^(\d{3})[-\/]?(\d{2})[-\/]?(\d{2})$/.exec(value.trim());
  return roc
    ? dateAt(`${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}`)
    : undefined;
}
function monthsBetween(start: string, end: string): number {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  return (endYear! - startYear!) * 12 + (endMonth! - startMonth!);
}

function dataAt(value: unknown): JsonRecord {
  return isRecord(value) && isRecord(value.rsData) ? value.rsData : {};
}
function arrayAt(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringAt(value: JsonRecord, key: string): string {
  return typeof value[key] === "string" ? value[key].trim() : "";
}
function numberAt(value: unknown): number | undefined {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim().replaceAll(",", "")
        : "";
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}
function currencyAt(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(text) ? text : undefined;
}
function dateAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isNaN(Date.parse(date)) ? undefined : date;
}
function periodAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})[-\/]?(\d{2})/.exec(value.trim());
  return match && Number(match[2]) >= 1 && Number(match[2]) <= 12
    ? `${match[1]}-${match[2]}`
    : undefined;
}
function last4(value: string): string {
  return value.match(/(\d{4})\D*$/)?.[1] ?? "";
}
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function cardAccountId(currency: string): string {
  return `megabank:credit:${currency}`;
}
function signedCardAmount(amount: number, description: string): number {
  return amount < 0 ||
    /退款|退貨|折讓|沖銷|回饋|繳款|還款|refund|credit|payment/i.test(
      description,
    )
    ? Math.abs(amount)
    : -Math.abs(amount);
}
function dedupe<T extends { sourceId: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [row.sourceId, row])).values()];
}
