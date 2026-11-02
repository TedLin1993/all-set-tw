import { describe, expect, it } from "vitest";
import {
  buildActivityItems,
  type ActivityInvoice,
  type ActivityTransaction,
} from "@taiwan-fin-hub/shared";
import {
  invoiceTransactionCandidates,
  matchInvoicesToTransactions,
} from "./matching";

function expense(
  id: string,
  postedDate: string,
  amount = -500,
): ActivityTransaction {
  return {
    id,
    connectorId: "bank",
    sourceId: id,
    accountId: "account-1",
    accountType: "deposit",
    postedDate,
    amount,
    currency: "TWD",
    status: "posted",
  };
}

const invoice: ActivityInvoice = {
  id: "invoice-1",
  invoiceDate: "2026-09-17T10:30:00+08:00",
  amount: 500,
  sellerName: "測試商店",
};

describe("發票手動配對", () => {
  it("同日支出不限金額；45 天內的跨日支出須同額且未配對，依日期差排序", () => {
    const candidates = invoiceTransactionCandidates(
      [
        expense("after-window", "2026-11-02"),
        expense("last-day", "2026-11-01"),
        expense("before-invoice", "2026-09-16"),
        expense("later-different-amount", "2026-09-20", -480),
        expense("already-linked", "2026-09-25"),
        expense("next-month", "2026-10-03"),
        expense("same-day-discounted", "2026-09-17", -480),
      ],
      invoice,
      new Set(["already-linked"]),
    );

    expect(candidates.map(({ id }) => id)).toEqual([
      "same-day-discounted",
      "next-month",
      "last-day",
    ]);
  });

  it("跨日配對的活動沿用扣款日期，同日配對使用發票時間", () => {
    const delayed = expense("delayed", "2026-10-03");
    const sameDay = expense("same-day", "2026-09-17");
    const itemDate = (transaction: ActivityTransaction) => {
      const matches = matchInvoicesToTransactions(
        [transaction],
        [invoice],
        [
          {
            invoiceId: invoice.id,
            transactionId: transaction.id,
            decision: "linked",
            updatedAt: "2026-10-04T00:00:00.000Z",
          },
        ],
      );
      const items = buildActivityItems(
        [transaction],
        [invoice],
        [],
        new Map(),
        matches,
      );
      expect(items).toHaveLength(1);
      expect(items[0]?.invoiceId).toBe(invoice.id);
      return items[0]?.date;
    };

    expect(itemDate(delayed)).toBe("2026-10-03");
    expect(itemDate(sameDay)).toBe(invoice.invoiceDate);
  });
});
