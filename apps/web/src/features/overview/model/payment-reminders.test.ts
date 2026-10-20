import { describe, expect, it } from "vitest";
import type { BankAccountRow, CreditCardBillRow } from "@/data/bank/types";
import { collectPaymentReminders } from "./payment-reminders";

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
