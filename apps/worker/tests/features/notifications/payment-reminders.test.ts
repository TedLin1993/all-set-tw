import { describe, expect, it } from "vitest";
import {
  collectPaymentReminders,
  type BankAccountResponse as BankAccountRow,
  type CreditCardBillResponse as CreditCardBillRow,
  type PaymentReminder,
} from "@taiwan-fin-hub/shared";
import {
  scheduledSummaryNotification,
  type SyncNotificationEvent,
} from "../../../src/features/notifications/payload";

// 台北時間 2026-10-21 01:00；UTC 仍是 10-20。
const now = new Date("2026-10-20T17:00:00Z");
const freshAsOf = "2026-10-20T15:00:00Z";

function card(
  input: Partial<BankAccountRow> & Pick<BankAccountRow, "id">,
): BankAccountRow {
  return {
    connectorId: "cathaybk",
    sourceId: input.id,
    institutionName: "國泰世華",
    accountType: "credit",
    currency: "TWD",
    balance: -12_800,
    asOfAt: freshAsOf,
    ...input,
  };
}

function bill(
  input: Partial<CreditCardBillRow> & Pick<CreditCardBillRow, "accountId">,
): CreditCardBillRow {
  return {
    id: `${input.accountId}-${input.billingPeriod ?? "2026-09"}`,
    connectorId: "cathaybk",
    sourceId: "bill",
    billingPeriod: "2026-09",
    statementAmount: 12_800,
    paidAmount: 0,
    isPaid: 0,
    paymentDueDate: "2026-10-23",
    currency: "TWD",
    ...input,
  };
}

describe("collectPaymentReminders", () => {
  it("已繳、溢繳與已繳足的帳單不提醒，待繳金額扣除已繳部分", () => {
    const reminders = collectPaymentReminders(
      [
        card({ id: "paid" }),
        card({ id: "overpaid", balance: 300 }),
        card({ id: "paid-amount" }),
        card({ id: "partial" }),
      ],
      [
        bill({ accountId: "paid", isPaid: 1 }),
        bill({ accountId: "overpaid" }),
        bill({ accountId: "paid-amount", paidAmount: 12_800 }),
        bill({ accountId: "partial", paidAmount: 2_800 }),
      ],
      now,
    );

    expect(reminders).toEqual([
      expect.objectContaining({
        accountId: "partial",
        amount: 10_000,
        daysUntilDue: 2,
        state: "due",
      }),
    ]);
  });

  it("繳款狀態未知或資料過舊時只提示請確認，不當成已繳", () => {
    const reminders = collectPaymentReminders(
      [
        card({ id: "unknown" }),
        card({ id: "stale", asOfAt: "2026-10-17T00:00:00Z" }),
      ],
      [
        bill({ accountId: "unknown", isPaid: null }),
        bill({ accountId: "stale" }),
      ],
      now,
    );

    expect(reminders.map((item) => [item.accountId, item.state])).toEqual([
      ["unknown", "confirm"],
      ["stale", "confirm"],
    ]);
  });

  it("以台北日期計算 5 天內到期，並只採用同一期限的帳單狀態", () => {
    const reminders = collectPaymentReminders(
      [
        card({ id: "day-5", paymentDueDate: "2026-10-26" }),
        card({ id: "day-6", paymentDueDate: "2026-10-27" }),
        card({ id: "new-cycle", paymentDueDate: "2026-10-24" }),
      ],
      [
        bill({ accountId: "day-5", paymentDueDate: "2026-10-26" }),
        bill({ accountId: "day-6", paymentDueDate: "2026-10-27" }),
        // 上一期已繳，本期帳單尚未同步：不能沿用上一期的已繳狀態。
        bill({
          accountId: "new-cycle",
          billingPeriod: "2026-08",
          isPaid: 1,
          paymentDueDate: "2026-09-24",
        }),
      ],
      now,
    );

    expect(
      reminders.map((item) => [item.accountId, item.daysUntilDue, item.state]),
    ).toEqual([
      ["day-5", 5, "due"],
      ["new-cycle", 3, "confirm"],
    ]);
  });

  it("貸款扣款未完成時即使沒有期限也優先提醒", () => {
    const reminders = collectPaymentReminders(
      [
        card({ id: "card" }),
        {
          id: "loan",
          connectorId: "cathaybk",
          sourceId: "loan",
          institutionName: "國泰世華",
          accountType: "loan",
          loanCategory: "housing",
          currency: "TWD",
          balance: -3_000_000,
          loanPaymentAmount: 25_000,
          loanPaymentStatus: "collection_incomplete",
          asOfAt: freshAsOf,
        },
      ],
      [bill({ accountId: "card" })],
      now,
    );

    expect(reminders[0]).toEqual(
      expect.objectContaining({
        accountId: "loan",
        name: "國泰世華房貸",
        amount: 25_000,
        state: "collection_failed",
      }),
    );
  });
});

describe("scheduledSummaryNotification", () => {
  const preferences = {
    success: false,
    failed: true,
    needsUserAction: true,
    paymentDue: true,
  };
  const succeeded: SyncNotificationEvent[] = [
    { connectorId: "cathaybk", status: "success" },
  ];
  const reminder = (
    input: Partial<PaymentReminder> & Pick<PaymentReminder, "accountId">,
  ): PaymentReminder => ({
    connectorId: "cathaybk",
    kind: "card",
    name: "國泰世華信用卡",
    amount: 12_800,
    currency: "TWD",
    daysUntilDue: 3,
    state: "due",
    ...input,
  });

  it("繳款提醒附在同一則同步摘要，只寫機構與天數、不含金額", () => {
    const payload = scheduledSummaryNotification(
      { ...preferences, success: true },
      succeeded,
      [
        reminder({ accountId: "a", daysUntilDue: 1 }),
        reminder({ accountId: "b", name: "台北富邦信用卡", amount: 5_300 }),
      ],
    );

    expect(payload).toEqual({
      title: "同步完成，2 筆繳款即將到期",
      body: "國泰世華信用卡明天到期、台北富邦信用卡 3 天後到期。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    });

    const failed = scheduledSummaryNotification(
      preferences,
      [...succeeded, { connectorId: "fubon", status: "failed" }],
      [reminder({ accountId: "a", state: "collection_failed" })],
    );
    expect(failed?.body).toBe(
      "預設排程同步完成：成功 1、失敗 1。另有 1 筆繳款需要留意：國泰世華信用卡扣款未完成。",
    );
    for (const text of [payload!.body, failed!.body])
      expect(text).not.toMatch(/NT\$|12,800|5,300|12800|5300/);
  });

  it("成功通知關閉時，只有緊急的繳款才讓同步摘要照常送出", () => {
    expect(
      scheduledSummaryNotification(preferences, succeeded, [
        reminder({ accountId: "a", daysUntilDue: 2 }),
      ]),
    ).toBeNull();

    for (const urgent of [
      reminder({ accountId: "a", daysUntilDue: 1 }),
      reminder({ accountId: "a", daysUntilDue: 0, state: "confirm" }),
      reminder({ accountId: "a", daysUntilDue: -1, state: "overdue" }),
      reminder({
        accountId: "a",
        kind: "loan",
        daysUntilDue: undefined,
        state: "collection_failed",
      }),
    ])
      expect(
        scheduledSummaryNotification(preferences, succeeded, [urgent]),
      ).not.toBeNull();
  });

  it("關閉繳款提醒時維持原本的同步推播", () => {
    const off = { ...preferences, paymentDue: false };
    const urgent = [reminder({ accountId: "a", daysUntilDue: 0 })];

    expect(scheduledSummaryNotification(off, succeeded, urgent)).toBeNull();
    expect(
      scheduledSummaryNotification(
        off,
        [{ connectorId: "fubon", status: "failed" }],
        urgent,
      )?.body,
    ).toBe("預設排程同步完成：失敗 1。");
  });

  it("同步狀態通知關閉時，緊急繳款只送繳款內容，不帶出該同步狀態", () => {
    const urgent = [reminder({ accountId: "a", daysUntilDue: 1 })];
    for (const [status, key] of [
      ["failed", "failed"],
      ["needs_user_action", "needsUserAction"],
    ] as const) {
      const payload = scheduledSummaryNotification(
        { ...preferences, [key]: false },
        [{ connectorId: "fubon", status }],
        urgent,
      );
      expect(payload).toEqual({
        title: "1 筆繳款即將到期",
        body: "國泰世華信用卡明天到期。",
        url: "/#/overview",
        tag: "sync-default-schedule-payment-due",
      });
    }
  });

  it("狀態未確定時，推播提示請確認，不寫成確定未繳", () => {
    const payload = scheduledSummaryNotification(preferences, succeeded, [
      reminder({
        accountId: "a",
        name: "台北富邦信用卡",
        daysUntilDue: 1,
        state: "confirm",
      }),
      reminder({
        accountId: "b",
        kind: "loan",
        name: "國泰世華房貸",
        daysUntilDue: 0,
        state: "confirm",
      }),
    ]);
    expect(payload?.body).toBe(
      "台北富邦信用卡明天到期（請確認是否已繳）、國泰世華房貸今天扣款（請確認餘額）。",
    );
  });
});
