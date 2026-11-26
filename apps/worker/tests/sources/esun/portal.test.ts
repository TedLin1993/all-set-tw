import { describe, expect, it } from "vitest";
import {
  buildEsunCreditTimelinePages,
  collectEsunSnapshot,
  readEsunCardBalances,
  type EsunPortalApi,
  type EsunSnapshot,
} from "../../../src/sources/esun/portal";
import {
  normalizeEsunTimelineTransactions,
  type EsunTimelinePage,
  type EsunTimelineTransaction,
} from "../../../src/sources/esun/connector";

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

describe("E.SUN bill payment status", () => {
  it.each([
    [true, true, 12040],
    [false, undefined, 27248],
    [undefined, undefined, 27248],
  ])(
    "maps creditCardFeePaid %s to %s and excludes paid debt",
    (overviewPaid, isPaid, outstanding) => {
      const snapshot: EsunSnapshot = {
        hasCreditCard: true,
        cardOverview: {
          resultCode: "0000",
          resultBody: {
            creditCardFeePaid: overviewPaid,
            currentStatement: [{ currency: "TWD", totalAmountDue: "15,208" }],
            nextStatement: [{ currency: "TWD", unpostedAmount: "12,040" }],
          },
        },
        billSummary: { body: { billInfo: {} } },
        billPeriod: "202608",
        realtime: {},
        creditHistory: [],
        twDeposits: [],
        frDeposits: [],
      };

      expect(readEsunCardBalances(snapshot)).toMatchObject({
        statementBalance: 15208,
        outstanding,
        isPaid,
      });
    },
  );

  it.each([
    [15208, 0],
    [0, 0],
    [-137, -137],
  ])(
    "preserves credits when a paid statement of %s has no new purchases",
    (statementBalance, outstanding) => {
      const snapshot: EsunSnapshot = {
        hasCreditCard: true,
        cardOverview: {
          resultCode: "0000",
          resultBody: {
            creditCardFeePaid: true,
            currentStatement: [
              { currency: "TWD", totalAmountDue: statementBalance },
            ],
          },
        },
        billSummary: { body: { billInfo: {} } },
        billPeriod: "202608",
        realtime: {},
        creditHistory: [],
        twDeposits: [],
        frDeposits: [],
      };

      expect(readEsunCardBalances(snapshot)).toMatchObject({
        statementBalance,
        outstanding,
        isPaid: true,
      });
    },
  );
});

describe("E.SUN credit card timeline normalization", () => {
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
      authorizedAt: "2026-07-05",
      postedDate: "2026-07-05T00:00:00.000Z",
    });
    expect((rows[0].raw as EsunTimelineTransaction).acfg).toBe("已入帳");
  });

  it("keeps negative history amounts as refunds instead of purchases", () => {
    const rows = normalizeEsunTimelineTransactions(
      buildEsunCreditTimelinePages({
        realtime: { body: { transList: [] } },
        creditHistory: [
          {
            body: {
              transList: [
                {
                  year: "2026",
                  month: "09",
                  transDetailList: [
                    {
                      merchantName: "優食台灣股份有限公司",
                      cardNo: "4751-XXXX-XXXX-0412",
                      transMonthDay: "0906",
                      paymentAmount: 199,
                      paymentCurrency: "TWD",
                      statusName: "已入帳",
                    },
                    {
                      merchantName: "優食台灣股份有限公司",
                      cardNo: "4751-XXXX-XXXX-0412",
                      transMonthDay: "0906",
                      paymentAmount: -199,
                      paymentCurrency: "TWD",
                      statusName: "已入帳",
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );

    expect(rows.map((row) => row.amount).sort((a, b) => a - b)).toEqual([
      -199, 199,
    ]);
  });
});

// Deposit prequery answers seen on a real card-only account (fields unrelated
// to the decision omitted).
const noTwdAccount = {
  resultCode: "S001",
  resultDescription: "親愛的顧客您好，查無臺幣帳號，或您尚未開立臺幣帳戶。",
  resultBody: null,
  errorMessages: null,
};
const noForeignAccount = {
  resultCode: "S001",
  resultDescription: "親愛的顧客您好，查無外幣帳號，或您尚未開立外幣帳戶。",
  resultBody: null,
  errorMessages: null,
};

function depositApi(twPrequery: unknown, frPrequery: unknown): EsunPortalApi {
  return {
    postIesc: async (path) => {
      if (path === "common/isCardholder")
        return { body: { rtnCode: "S", credit: false } };
      throw new Error(`unexpected IESC request: ${path}`);
    },
    postPortal: async (path) =>
      path.endsWith("/preQueryTWTransactionDetail")
        ? twPrequery
        : path.endsWith("/preQueryFRTransactionDetail")
          ? frPrequery
          : { resultCode: "0000" },
    readRealtime: async () => {
      throw new Error("unexpected realtime request");
    },
  };
}

describe("E.SUN deposit accounts", () => {
  it("skips TWD and foreign deposits the customer does not hold, but fails on the other currency's notice", async () => {
    const snapshot = await collectEsunSnapshot(
      depositApi(noTwdAccount, noForeignAccount),
    );
    expect(snapshot.twDeposits).toEqual([]);
    expect(snapshot.frDeposits).toEqual([]);
    for (const [tw, fr] of [
      [noForeignAccount, noForeignAccount],
      [noTwdAccount, noTwdAccount],
    ])
      await expect(collectEsunSnapshot(depositApi(tw, fr))).rejects.toThrow(
        "E.SUN portal deposit-prequery failed (S001).",
      );
  });
});

function unclosedBillApi(lastBillYearMonth: string): EsunPortalApi {
  return {
    ...depositApi(noTwdAccount, noForeignAccount),
    postIesc: async (path, body) => {
      if (path === "common/isCardholder")
        return { body: { rtnCode: "S", credit: true } };
      if (path === "cardBill/getLastBillYearMonth")
        return { body: { rtnCode: "S", lastBillYearMonth } };
      if (path === "creditBill/getSummaryResult")
        return body.billPeriod === lastBillYearMonth
          ? { status: "CARD-2026", msg: ["本月尚未結帳"] }
          : {
              status: "200",
              body: { rtnCode: "S", requestedPeriod: body.billPeriod },
            };
      return { body: { rtnCode: "S" } };
    },
    readRealtime: async () => ({
      body: "{}",
      payload: { body: { rtnCode: "S" } },
    }),
  };
}

describe("E.SUN latest bill", () => {
  it.each([
    ["202611", "202610", "2026-10"],
    ["202601", "202512", "2025-12"],
  ])(
    "uses the previous statement when %s has not closed yet",
    async (latest, previous, billingPeriod) => {
      const snapshot = await collectEsunSnapshot(unclosedBillApi(latest));

      expect(snapshot.billPeriod).toBe(previous);
      expect(snapshot.billSummary).toMatchObject({
        body: { requestedPeriod: previous },
      });
      expect(readEsunCardBalances(snapshot).billingPeriod).toBe(billingPeriod);
    },
  );
});
