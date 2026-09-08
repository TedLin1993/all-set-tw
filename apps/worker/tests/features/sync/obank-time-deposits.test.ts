import { describe, expect, it } from "vitest";
import { matchObankDepositEvents } from "../../../src/features/sync/obank-time-deposits";
import { findAutomaticTransferPairs } from "../../../src/features/bank/transfer-matching";

const savings = {
  sourceId: "savings",
  accountType: "savings" as const,
  currency: "TWD",
};
const now = "2026-09-07T13:31:07Z";
const transaction = {
  accountId: "savings",
  sourceId: "debit",
  postedDate: "2026-09-07",
  amount: -52736,
  currency: "TWD",
  status: "posted" as const,
  description: "Account",
};
const deposit = {
  sourceId: "deposit",
  currency: "TWD",
  balance: 52736,
  openedDate: "2026-09-07",
};

describe("O-Bank time deposit principal events", () => {
  it("creates a stable opening event linked to the unique demand leg", () => {
    const events = matchObankDepositEvents(
      [savings],
      [deposit],
      [],
      [transaction],
      now,
    );
    expect(events).toMatchObject([
      {
        amount: 52736,
        description: "定存成立（本金轉入）",
        transferPeer: { accountId: "savings", sourceId: "debit" },
      },
    ]);
    expect(
      matchObankDepositEvents([savings], [deposit], [], [transaction], now),
    ).toEqual(events);
  });
  it("leaves missing dates, duplicate amounts and multiple demand accounts unpaired", () => {
    expect(
      matchObankDepositEvents(
        [savings],
        [{ ...deposit, openedDate: undefined }],
        [],
        [transaction],
        now,
      ),
    ).toEqual([]);
    expect(
      matchObankDepositEvents(
        [savings],
        [deposit, { ...deposit, sourceId: "other" }],
        [],
        [transaction],
        now,
      ),
    ).toEqual([]);
    expect(
      matchObankDepositEvents(
        [savings],
        [deposit],
        [],
        [transaction, { ...transaction, sourceId: "other" }],
        now,
      ),
    ).toEqual([]);
    expect(
      matchObankDepositEvents(
        [savings, { ...savings, sourceId: "other" }],
        [deposit],
        [],
        [transaction],
        now,
      ),
    ).toEqual([]);
  });
  it("matches a missing deposit principal after its last sighting, retaining separate interest", () => {
    const missing = [
      {
        sourceId: "old",
        currency: "TWD",
        balance: 30550,
        asOfAt: "2026-09-01T02:06:05Z",
      },
    ];
    const credit = {
      ...transaction,
      sourceId: "credit",
      postedDate: "2026-09-05",
      amount: 30550,
    };
    const interest = { ...credit, sourceId: "interest", amount: 485 };
    expect(
      matchObankDepositEvents([savings], [], missing, [credit, interest], now),
    ).toMatchObject([
      {
        amount: -30550,
        postedDate: "2026-09-05",
        transferPeer: { sourceId: "credit" },
      },
    ]);
    expect(
      matchObankDepositEvents(
        [savings],
        [],
        [{ ...missing[0], asOfAt: "2026-09-05T01:00:00Z" }],
        [credit],
        now,
      ),
    ).toEqual([]);
    expect(
      matchObankDepositEvents(
        [savings],
        [],
        missing,
        [{ ...credit, amount: 31035 }],
        now,
      ),
    ).toEqual([]);
  });
  it("reserves the linked peer and never matches an unlinked time deposit by amount alone", () => {
    const debit = { ...transaction, id: "debit", accountType: "savings" };
    const event = {
      ...debit,
      id: "event",
      accountId: "td",
      accountType: "time_deposit",
      amount: 52736,
      transferPeerId: "debit",
    };
    const unrelated = {
      ...event,
      id: "unrelated",
      accountType: "savings",
      transferPeerId: undefined,
    };
    expect(findAutomaticTransferPairs([debit, event, unrelated])).toEqual([
      ["event", "debit"],
    ]);
    expect(
      findAutomaticTransferPairs([
        debit,
        { ...event, transferPeerId: undefined },
      ]),
    ).toEqual([]);
  });
});
