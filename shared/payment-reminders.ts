import { normalizeFinancialDate } from "./activity/items";
import type {
  BankAccountResponse as BankAccountRow,
  CreditCardBillResponse as CreditCardBillRow,
} from "./api/bank";

/** 從今天起算，幾天內到期的應繳款會列入提醒（含今天）。 */
export const PAYMENT_REMINDER_DAYS = 5;
/** 明確待繳但已過期限時，最多再提醒幾天，避免停用來源的舊帳單一直留著。 */
const OVERDUE_REMINDER_DAYS = 7;
/** 帳戶快照超過此時間未更新時，不直接判定為待繳，改提示請確認。 */
const STALE_SNAPSHOT_MS = 48 * 60 * 60 * 1000;

/**
 * - `due`：來源明確標示待繳，期限內。
 * - `confirm`：繳款狀態未知或資料過舊，只提示請確認。
 * - `overdue`：來源明確標示待繳，但已過期限（同步可能尚未反映當日繳款）。
 * - `collection_failed`：貸款來源明確標示扣款未完成。
 */
export type PaymentReminderState =
  "due" | "confirm" | "overdue" | "collection_failed";

export interface PaymentReminder {
  accountId: string;
  connectorId: string;
  kind: "card" | "loan";
  name: string;
  /** 剩餘應繳金額；來源未提供時為 undefined。 */
  amount?: number;
  currency: string;
  dueDate?: string;
  /** 0 為今天到期，負數為已過期限。 */
  daysUntilDue?: number;
  state: PaymentReminderState;
  asOfAt?: string;
}

export function taipeiDateKey(now: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dateKey(value?: string | null) {
  const normalized = normalizeFinancialDate(value ?? undefined).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function daysBetween(from: string, to: string) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty!, tm! - 1, td!) - Date.UTC(fy!, fm! - 1, fd!)) / 86_400_000,
  );
}

function isStale(asOfAt: string | null | undefined, now: Date) {
  if (!asOfAt) return true;
  const time = new Date(asOfAt).getTime();
  return !Number.isFinite(time) || now.getTime() - time > STALE_SNAPSHOT_MS;
}

function loanLabel(account: BankAccountRow) {
  if (account.loanCategory === "housing") return "房貸";
  if (account.loanCategory === "personal") return "信貸";
  return "貸款";
}

function cardReminder(
  account: BankAccountRow,
  bills: CreditCardBillRow[],
  today: string,
  now: Date,
): PaymentReminder | null {
  // 正餘額是溢繳、0 是沒有欠款；兩者都無需繳款。
  if (account.balance != null && account.balance >= 0) return null;
  const accountBills = bills
    .filter((bill) => bill.accountId === account.id)
    .sort((a, b) => b.billingPeriod.localeCompare(a.billingPeriod));
  const dueDate =
    dateKey(account.paymentDueDate) ?? dateKey(accountBills[0]?.paymentDueDate);
  if (!dueDate) return null;
  // 只採用同一個繳款期限的帳單狀態，避免拿上一期「已繳」蓋掉本期。
  const bill = accountBills.find(
    (item) => dateKey(item.paymentDueDate) === dueDate,
  );
  if (bill?.isPaid === 1) return null;
  if (bill?.statementAmount != null && bill.statementAmount <= 0) return null;

  const amount =
    bill?.statementAmount != null
      ? Math.max(bill.statementAmount - (bill.paidAmount ?? 0), 0)
      : undefined;
  if (amount === 0) return null;

  const daysUntilDue = daysBetween(today, dueDate);
  const explicitlyUnpaid = bill?.isPaid === 0;
  if (daysUntilDue > PAYMENT_REMINDER_DAYS) return null;
  if (daysUntilDue < 0 && !explicitlyUnpaid) return null;
  if (daysUntilDue < -OVERDUE_REMINDER_DAYS) return null;

  const stale = isStale(account.asOfAt, now);
  return {
    accountId: account.id,
    connectorId: account.connectorId,
    kind: "card",
    name: `${account.institutionName ?? ""}信用卡`,
    amount,
    currency: bill?.currency ?? account.currency,
    dueDate,
    daysUntilDue,
    state:
      !explicitlyUnpaid || stale
        ? "confirm"
        : daysUntilDue < 0
          ? "overdue"
          : "due",
    asOfAt: account.asOfAt ?? undefined,
  };
}

function loanReminder(
  account: BankAccountRow,
  today: string,
): PaymentReminder | null {
  const dueDate = dateKey(account.paymentDueDate);
  const daysUntilDue = dueDate ? daysBetween(today, dueDate) : undefined;
  const base = {
    accountId: account.id,
    connectorId: account.connectorId,
    kind: "loan" as const,
    name: `${account.institutionName ?? ""}${loanLabel(account)}`,
    amount: account.loanPaymentAmount ?? undefined,
    currency: account.currency,
    dueDate,
    daysUntilDue,
    asOfAt: account.asOfAt ?? undefined,
  };
  if (account.loanPaymentStatus === "collection_incomplete")
    return { ...base, state: "collection_failed" };
  // 貸款來源沒有已繳狀態，期限過後通常會換成下一期，只提醒即將扣款的期別。
  if (daysUntilDue === undefined) return null;
  if (daysUntilDue < 0 || daysUntilDue > PAYMENT_REMINDER_DAYS) return null;
  if (account.loanPaymentAmount != null && account.loanPaymentAmount <= 0)
    return null;
  return { ...base, state: "confirm" };
}

const STATE_PRIORITY: Record<PaymentReminderState, number> = {
  collection_failed: 0,
  overdue: 1,
  due: 2,
  confirm: 3,
};

/**
 * 依帳戶快照與帳單整理近期應繳款。缺少繳款狀態時不視為已繳，
 * 也不直接判定為待繳或逾期。
 */
export function collectPaymentReminders(
  accounts: BankAccountRow[],
  bills: CreditCardBillRow[],
  now = new Date(),
): PaymentReminder[] {
  const today = taipeiDateKey(now);
  const reminders: PaymentReminder[] = [];
  for (const account of accounts) {
    const reminder =
      account.accountType === "credit"
        ? cardReminder(account, bills, today, now)
        : account.accountType === "loan"
          ? loanReminder(account, today)
          : null;
    if (reminder) reminders.push(reminder);
  }
  return reminders.sort(
    (a, b) =>
      STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state] ||
      (a.daysUntilDue ?? -Infinity) - (b.daysUntilDue ?? -Infinity),
  );
}

export function describeDueDay(reminder: PaymentReminder) {
  const days = reminder.daysUntilDue;
  const verb = reminder.kind === "loan" ? "扣款" : "到期";
  if (days === undefined) return "";
  if (days < 0) return "已過繳款期限";
  if (days === 0) return `今天${verb}`;
  if (days === 1) return `明天${verb}`;
  return `${days} 天後${verb}`;
}
