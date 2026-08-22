import { describe, expect, it } from "vitest";
import {
  findAutomaticCreditOffsetPairs,
  findAutomaticCreditOffsetTransactionIds,
  findAutomaticTransferPairs,
  findAutomaticTransferTransactionIds,
  getAutomaticTransferDay,
  type TransferMatchTransaction,
} from "../../../src/features/bank/transfer-matching";

function transaction(
  input: Partial<TransferMatchTransaction> &
    Pick<TransferMatchTransaction, "id" | "accountId" | "amount">,
): TransferMatchTransaction {
  return {
    currency: "TWD",
    postedDate: "2026-08-22",
    status: "posted",
    ...input,
  };
}

describe("automatic bank transfer matching", () => {
  it("pairs opposite posted amounts on the same stored financial day", () => {
    const transactions = [
      transaction({ id: "out", accountId: "account-a", amount: -10_000 }),
      transaction({ id: "in", accountId: "account-b", amount: 10_000 }),
    ];

    expect(findAutomaticTransferPairs(transactions)).toEqual([["in", "out"]]);
    expect(findAutomaticTransferTransactionIds(transactions)).toEqual(
      new Set(["in", "out"]),
    );
  });

  it("pairs different accounts at the same bank", () => {
    const transactions = [
      transaction({
        id: "same-bank-out",
        accountId: "tdcc:050:checking-01271",
        amount: -20_000,
      }),
      transaction({
        id: "same-bank-in",
        accountId: "tdcc:050:savings-8888",
        amount: 20_000,
      }),
    ];

    expect(findAutomaticTransferPairs(transactions)).toEqual([
      ["same-bank-in", "same-bank-out"],
    ]);
  });

  it("pairs an annual fee with its same-card reduction", () => {
    const transactions = [
      transaction({
        id: "fee",
        accountId: "taishin:credit:main",
        accountType: "credit",
        amount: -4_500,
        description: "鈦金商務卡年費",
      }),
      transaction({
        id: "reduction",
        accountId: "taishin:credit:main",
        accountType: "credit",
        amount: 4_500,
        description: "鈦金商務卡年費減免",
      }),
    ];

    expect(findAutomaticCreditOffsetPairs(transactions)).toEqual([
      ["reduction", "fee"],
    ]);
    expect(findAutomaticCreditOffsetTransactionIds(transactions)).toEqual(
      new Set(["reduction", "fee"]),
    );
  });

  it("does not treat an ordinary credit refund as an annual-fee offset", () => {
    const transactions = [
      transaction({
        id: "charge",
        accountId: "card",
        accountType: "credit",
        amount: -4_500,
        description: "一般消費",
      }),
      transaction({
        id: "refund",
        accountId: "card",
        accountType: "credit",
        amount: 4_500,
        description: "消費退款",
      }),
    ];

    expect(findAutomaticCreditOffsetTransactionIds(transactions)).toEqual(
      new Set(),
    );
  });

  it("uses the stored date prefix for connector timestamps", () => {
    const transactions = [
      transaction({
        id: "out",
        accountId: "account-a",
        amount: -500,
        postedDate: "2026-06-23T21:20:18.000Z",
      }),
      transaction({
        id: "in",
        accountId: "account-b",
        amount: 500,
        postedDate: "2026-06-23",
      }),
    ];

    expect(findAutomaticTransferTransactionIds(transactions)).toEqual(
      new Set(["in", "out"]),
    );
  });

  it("uses authorizedAt before postedDate for the stored financial day", () => {
    const transactions = [
      transaction({
        id: "out",
        accountId: "account-a",
        amount: -500,
        authorizedAt: "2026-08-22T16:30:00.000Z",
        postedDate: "2026-08-21",
      }),
      transaction({
        id: "in",
        accountId: "account-b",
        amount: 500,
        authorizedAt: "2026-08-22T07:00:00.000+08:00",
        postedDate: "2026-08-22",
      }),
    ];

    expect(getAutomaticTransferDay(transactions[0])).toBe("2026-08-22");
    expect(findAutomaticTransferTransactionIds(transactions)).toEqual(
      new Set(["in", "out"]),
    );
  });

  it("pairs as many cross-account candidates as possible in stable order", () => {
    const transactions = [
      transaction({ id: "out-a", accountId: "account-a", amount: -100 }),
      transaction({ id: "out-b", accountId: "account-b", amount: -100 }),
      transaction({ id: "in-a", accountId: "account-c", amount: 100 }),
      transaction({ id: "in-b", accountId: "account-c", amount: 100 }),
    ];

    expect(findAutomaticTransferPairs(transactions)).toEqual([
      ["in-a", "out-b"],
      ["in-b", "out-a"],
    ]);
  });

  it("ignores same-account entries when one cross-account pair is unique", () => {
    const transactions = [
      transaction({ id: "out", accountId: "account-b", amount: -102 }),
      transaction({ id: "in", accountId: "account-a", amount: 102 }),
      transaction({ id: "interest-a", accountId: "account-b", amount: 102 }),
      transaction({ id: "interest-b", accountId: "account-b", amount: 102 }),
    ];

    expect(findAutomaticTransferPairs(transactions)).toEqual([["in", "out"]]);
  });

  it.each([
    {
      name: "same account",
      changes: {
        positive: { accountId: "account-a" },
        negative: { accountId: "account-a" },
      },
    },
    {
      name: "different currencies",
      changes: {
        positive: { currency: "USD" },
        negative: { currency: "TWD" },
      },
    },
    {
      name: "pending transaction",
      changes: {
        positive: { status: "pending" },
        negative: {},
      },
    },
    {
      name: "credit-account transaction",
      changes: {
        positive: { accountType: "credit" },
        negative: {},
      },
    },
    {
      name: "zero amount",
      changes: {
        positive: { amount: 0 },
        negative: { amount: 0 },
      },
    },
    {
      name: "different days",
      changes: {
        positive: { postedDate: "2026-08-23" },
        negative: {},
      },
    },
  ])("does not pair when the $name condition fails", ({ changes }) => {
    const transactions = [
      transaction({
        id: "out",
        accountId: "account-a",
        amount: -100,
        ...changes.negative,
      }),
      transaction({
        id: "in",
        accountId: "account-b",
        amount: 100,
        ...changes.positive,
      }),
    ];

    expect(findAutomaticTransferTransactionIds(transactions)).toEqual(
      new Set(),
    );
  });
});
