import { describe, expect, it } from "vitest";
import {
  esunCreditBalanceAccountId,
  normalizeEsunTimelineTransactions,
  type EsunTimelinePage,
  type EsunTimelineTransaction,
} from "../../src/connectors/esun";

function page(transactions: EsunTimelineTransaction[]): EsunTimelinePage {
  return {
    timelineList: [
      {
        year: "2026",
        month: "07",
        txnList: transactions,
      },
    ],
  };
}

function transaction(
  acfg: string,
  overrides: Partial<EsunTimelineTransaction> = {},
): EsunTimelineTransaction {
  return {
    payCur: "TWD",
    payAmt: "252",
    storeName: "全支付﹘全聯",
    consumerDt: "07/05",
    cardNo: "****1204",
    acfg,
    ...overrides,
  };
}

describe("E.SUN credit card timeline normalization", () => {
  it("uses the physical card for a single card and keeps an aggregate for multiple cards", () => {
    expect(esunCreditBalanceAccountId(["credit:esun:1204"])).toBe(
      "credit:esun:1204",
    );
    expect(
      esunCreditBalanceAccountId(["credit:esun:1204", "credit:esun:9876"]),
    ).toBe("credit:esun:main");
    expect(esunCreditBalanceAccountId([])).toBe("credit:esun:main");
  });

  it("collapses pending and posted lifecycle copies into one stable transaction", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([transaction("未入帳"), transaction("已入帳")]),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe(
      "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:1",
    );
    expect(rows[0]).toMatchObject({
      amount: -252,
      status: "posted",
      authorizedAt: "2026-07-05T00:00:00.000Z",
      postedDate: "2026-07-05T00:00:00.000Z",
    });
    expect((rows[0].raw as EsunTimelineTransaction).acfg).toBe("已入帳");
  });

  it("preserves repeated real purchases using occurrence numbers", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([
        transaction("未入帳"),
        transaction("未入帳"),
        transaction("已入帳"),
        transaction("已入帳"),
      ]),
    ]);

    expect(rows.map(({ sourceId }) => sourceId)).toEqual([
      "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:1",
      "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:2",
    ]);
    expect(
      rows.map(({ raw }) => (raw as EsunTimelineTransaction).acfg),
    ).toEqual(["已入帳", "已入帳"]);
    expect(rows.map(({ status }) => status)).toEqual(["posted", "posted"]);
  });

  it("keeps all pending purchases while no posted copy exists", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([transaction("未入帳"), transaction("未入帳")]),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({ status: "pending", postedDate: undefined }),
      expect.objectContaining({ status: "pending", postedDate: undefined }),
    ]);
  });

  it("records purchases as expenses and discounts as positive credits", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([
        transaction("已入帳", {
          payAmt: "350",
          storeName: "樂購蝦皮－daniel0329TAIPEI",
        }),
        transaction("已入帳", {
          payAmt: "-63",
          storeName: "信用卡消費折抵_樂購蝦皮－daniel0329",
        }),
      ]),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        description: "樂購蝦皮－daniel0329TAIPEI",
        amount: -350,
      }),
      expect.objectContaining({
        description: "信用卡消費折抵_樂購蝦皮－daniel0329",
        amount: 63,
      }),
    ]);
  });

  it("upgrades a cross-day pending purchase to posted without changing its source id", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([
        transaction("未入帳", { consumerDt: "07/05" }),
        transaction("已入帳", { consumerDt: "07/05", postingDt: "07/07" }),
      ]),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        sourceId:
          "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:1",
        status: "posted",
        authorizedAt: "2026-07-05T00:00:00.000Z",
        postedDate: "2026-07-07T00:00:00.000Z",
      }),
    ]);
  });

  it("keeps equal purchases on different cards separate", () => {
    const rows = normalizeEsunTimelineTransactions([
      page([
        transaction("未入帳", { cardNo: "****1204" }),
        transaction("未入帳", { cardNo: "****9876" }),
        transaction("已入帳", { cardNo: "****1204" }),
        transaction("已入帳", { cardNo: "****9876" }),
      ]),
    ]);

    expect(rows).toHaveLength(2);
    expect(
      rows.map(({ accountId, status }) => ({ accountId, status })),
    ).toEqual([
      { accountId: "credit:esun:1204", status: "posted" },
      { accountId: "credit:esun:9876", status: "posted" },
    ]);
  });
});
