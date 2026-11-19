import { describe, expect, it } from "vitest";
import {
  activityFlowTotalTwd,
  buildActivityItems,
  type ActivityInvoice,
  type ActivityTrade,
  type ActivityTransaction,
} from "@taiwan-fin-hub/shared";
import {
  invoiceTransactionCandidates,
  matchInvoicesToTransactions,
  missingLinkedTransactionIds,
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
  it("同日支出不限金額；發票日前 14 天到後 45 天的跨日支出須同額且未配對，依日期差排序", () => {
    const candidates = invoiceTransactionCandidates(
      [
        expense("after-window", "2026-11-02"),
        expense("last-day", "2026-11-01"),
        expense("before-window", "2026-09-02"),
        expense("earliest-day", "2026-09-03"),
        expense("day-before", "2026-09-16"),
        expense("earlier-different-amount", "2026-09-15", -480),
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
      "day-before",
      "earliest-day",
      "next-month",
      "last-day",
    ]);
  });

  it("跨日配對的活動沿用扣款日期，同日配對使用發票時間", () => {
    const delayed = expense("delayed", "2026-10-03");
    const early = expense("early", "2026-09-14");
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
    expect(itemDate(early)).toBe("2026-09-14");
    expect(itemDate(sameDay)).toBe(invoice.invoiceDate);
  });

  it("只補讀本批發票連結、但不在本批交易中的交易", () => {
    const link = (invoiceId: string, transactionId: string | null) => ({
      invoiceId,
      transactionId,
      decision: transactionId ? ("linked" as const) : ("separate" as const),
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(
      missingLinkedTransactionIds(
        [expense("loaded", "2026-09-17")],
        [invoice, { ...invoice, id: "invoice-2" }],
        [
          link(invoice.id, "before-range"),
          link("invoice-2", "loaded"),
          link("outside-batch", "unrelated"),
          link("invoice-3", null),
        ],
      ),
    ).toEqual(["before-range"]);
  });
});

describe("證券成交與交割款合併", () => {
  const trade = (
    id: string,
    tradeDate: string,
    amount: number | null,
    extra: Partial<ActivityTrade> = {},
  ): ActivityTrade => ({
    id,
    name: "元大台灣50",
    symbol: "0050",
    tradeDate,
    transactionName: "買進",
    quantity: 96,
    price: 103.64,
    amount,
    currency: "TWD",
    ...extra,
  });
  const build = (
    transactions: ActivityTransaction[],
    trades: ActivityTrade[],
  ) =>
    buildActivityItems(transactions, [], trades, new Map(), {
      invoiceToTransactionId: new Map(),
      transactionToInvoice: new Map(),
    });

  it("同額交割款在成交日後 7 天內時合併成一筆銀行活動，金額只算一次且可排除", () => {
    const items = build(
      [
        expense("same-day", "2026-11-13", -9950),
        expense("t-plus-2", "2026-11-06", -19587),
        expense("unrelated", "2026-11-13", -120),
      ],
      [
        trade("regular", "2026-11-13", -9950),
        trade("spot", "2026-11-04", -19587, { quantity: 200, price: 97.8 }),
      ],
    );

    expect(items.map(({ id, source }) => `${source}:${id}`).sort()).toEqual([
      "bank:same-day",
      "bank:t-plus-2",
      "bank:unrelated",
    ]);
    const settled = items.find(({ id }) => id === "t-plus-2")!;
    // 合併後是銀行交易：沿用入帳日，有 transactionId 才能排除統計與調整分類。
    expect(settled).toMatchObject({
      date: "2026-11-06",
      amount: -19587,
      transactionId: "t-plus-2",
      trade: {
        id: "spot",
        date: "2026-11-04",
        side: "買進",
        quantity: 200,
        price: 97.8,
      },
    });
    expect(settled.subtitle).toContain("元大台灣50 買進 200 股");

    // 配對看入帳日：授權時間早於成交日（預先圈存）仍是這筆成交的交割款。
    const held = build(
      [
        {
          ...expense("held", "2026-11-16", -9950),
          authorizedAt: "2026-11-12T12:00:00+08:00",
        },
      ],
      [trade("regular", "2026-11-13", -9950)],
    );
    expect(held.map(({ id, trade: t }) => [id, t?.id])).toEqual([
      ["held", "regular"],
    ]);
    expect(activityFlowTotalTwd(items, "expense", {})).toBe(9950 + 19587 + 120);
  });

  it("金額、幣別、方向或日期對不上，以及信用卡與沒有金額的集保成交，都各自顯示", () => {
    const card = {
      ...expense("card", "2026-11-13", -9950),
      accountType: "credit",
    };
    const cases: Array<[ActivityTransaction, ActivityTrade]> = [
      [expense("amount", "2026-11-13", -9951), trade("t", "2026-11-13", -9950)],
      [expense("sign", "2026-11-13", 9950), trade("t", "2026-11-13", -9950)],
      [
        { ...expense("currency", "2026-11-13", -9950), currency: "USD" },
        trade("t", "2026-11-13", -9950),
      ],
      [expense("before", "2026-11-12", -9950), trade("t", "2026-11-13", -9950)],
      [expense("late", "2026-11-21", -9950), trade("t", "2026-11-13", -9950)],
      [card, trade("t", "2026-11-13", -9950)],
      // 集保以 1 占位的價格不是成交價，股數 × 1 不是金額。
      [
        expense("tdcc", "2026-11-13", -96),
        trade("t", "2026-11-13", 96, { price: 1 }),
      ],
      [
        expense("no-amount", "2026-11-13", -9950),
        trade("t", "2026-11-13", null),
      ],
    ];
    for (const [transaction, candidate] of cases) {
      const items = build([transaction], [candidate]);
      expect(items.map(({ source }) => source).sort(), transaction.id).toEqual(
        [
          transaction.accountType === "credit" ? "card" : "bank",
          "investment",
        ].sort(),
      );
      expect(items.some(({ trade: merged }) => merged)).toBe(false);
    }
  });

  it("一筆交割款只配一筆成交，同額多筆時各配最接近成交日的扣款", () => {
    const items = build(
      [
        expense("first", "2026-11-03", -9950),
        expense("second", "2026-11-13", -9950),
      ],
      [
        trade("november-13", "2026-11-13", -9950),
        trade("november-03", "2026-11-03", -9950),
        trade("extra", "2026-11-13", -9950),
      ],
    );
    const merged = Object.fromEntries(
      items.filter(({ trade: t }) => t).map(({ id, trade: t }) => [id, t!.id]),
    );
    expect(merged).toEqual({ first: "november-03", second: "extra" });
    expect(
      items.filter(({ source }) => source === "investment").map(({ id }) => id),
    ).toEqual(["november-13"]);
  });
});
