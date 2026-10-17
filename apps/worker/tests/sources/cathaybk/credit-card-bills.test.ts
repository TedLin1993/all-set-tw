import { describe, expect, it } from "vitest";
import {
  mergeCathayCurrentBills,
  parseCathayCurrentBills,
  parseCathayHistoryBills,
} from "../../../src/sources/cathaybk/connector";

const sourceId = "credit:cathaybk:main";
const api = (content: unknown) => ({
  success: true,
  returnCode: "0000",
  content,
});

describe("國泰世華信用卡帳單解析", () => {
  it("RecentBillInfo 決定當期金額與週期，BillInfo 只補最低額", () => {
    const parsed = parseCathayCurrentBills(
      api({
        recentBillDate: "2026-09-20T11:00:00",
        twBillInfo: { unPaidAmount: 400, paidAmount: 600 },
      }),
      api({
        currencyBillInfoList: [
          {
            currency: "TWD",
            currencyDataType: "TWD",
            billDate: "2026-08-20",
            currentMinPaymentAmount: 75,
          },
        ],
      }),
      api({
        dueDate: "2026-10-05T00:00:00",
        twdBillDetail: { payBillStatus: "Unmapped" },
      }),
      sourceId,
    );

    expect(parsed.bankAccounts).toEqual([]);
    expect(parsed.creditCardBills).toHaveLength(1);
    expect(parsed.creditCardBills[0]).toMatchObject({
      accountId: sourceId,
      billingPeriod: "2026-09",
      statementAmount: 1000,
      paidAmount: 600,
      minimumPayment: 75,
      isPaid: false,
      paymentDueDate: "2026-10-05",
      statementClosingDate: "2026-09-20",
      currency: "TWD",
    });
  });

  it("只在 RecentBill 明示外幣且 BillInfo 幣別欄位相符時建立外幣帳單", () => {
    const parsed = parseCathayCurrentBills(
      api({
        recentBillDate: "2026/9/20",
        twBillInfo: { unPaidAmount: 0, paidAmount: 900 },
        foreignBillInfo: {
          currency: "USD",
          unPaidAmount: 30,
          paidAmount: 20,
        },
      }),
      api({
        currencyBillInfoList: [
          {
            currency: "TWD",
            currencyDataType: "TWD",
            currentMinPaymentAmount: 0,
          },
          {
            currency: "USD",
            currencyDataType: "USD",
            currentMinPaymentAmount: 5,
          },
          {
            currency: "EUR",
            currencyDataType: "USD",
            currentMinPaymentAmount: 7,
          },
        ],
      }),
      api({ dueDate: "2026-10-05", twdBillDetail: { payBillStatus: "Payed" } }),
      sourceId,
    );

    expect(parsed.bankAccounts).toEqual([
      expect.objectContaining({
        sourceId: `${sourceId}:USD`,
        accountType: "credit",
        currency: "USD",
      }),
    ]);
    expect(parsed.creditCardBills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: sourceId,
          currency: "TWD",
          minimumPayment: 0,
          isPaid: true,
        }),
        expect.objectContaining({
          accountId: `${sourceId}:USD`,
          sourceId: `${sourceId}:USD:bill:2026-09`,
          billingPeriod: "2026-09",
          statementAmount: 50,
          paidAmount: 20,
          minimumPayment: 5,
          isPaid: false,
          currency: "USD",
        }),
      ]),
    );
  });

  it("BillInfo 缺漏時仍保留 RecentBill 金額，但不猜最低額或外幣", () => {
    const parsed = parseCathayCurrentBills(
      api({
        recentBillDate: "2026-09-20",
        twBillInfo: { unPaidAmount: 0, paidAmount: 900 },
        foreignBillInfo: {
          currency: "USD",
          unPaidAmount: 20,
          paidAmount: 0,
        },
      }),
      null,
      null,
      sourceId,
    );

    expect(parsed.creditCardBills).toHaveLength(1);
    expect(parsed.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-09",
      statementAmount: 900,
      currency: "TWD",
    });
    expect(parsed.creditCardBills[0].minimumPayment).toBeUndefined();
    expect(parsed.creditCardBills[0].paymentDueDate).toBeUndefined();
    expect(parsed.bankAccounts).toEqual([]);
  });

  it("RecentBill 日期無效時不以 BillInfo 日期建立當期帳單", () => {
    const parsed = parseCathayCurrentBills(
      api({
        recentBillDate: "2026-02-30",
        twBillInfo: { unPaidAmount: 10, paidAmount: 0 },
        foreignBillInfo: {
          currency: "USD",
          unPaidAmount: 20,
          paidAmount: 0,
        },
      }),
      api({
        currencyBillInfoList: [
          { currency: "TWD", currencyDataType: "TWD", billDate: "2026-09-20" },
          { currency: "USD", currencyDataType: "USD", billDate: "2026-08-20" },
        ],
      }),
      api({ dueDate: "2026-10-05" }),
      sourceId,
    );

    expect(parsed.creditCardBills).toEqual([]);
    expect(parsed.bankAccounts).toEqual([]);
  });

  it("用 RecentBill 日期作歷史錨點，濾除未解析占位金額並保留 0", () => {
    const parsed = parseCathayHistoryBills(
      [
        {
          billDate: "2026-10-16",
          twdAmount: null,
          usdAmount: null,
          billStatus: "placeholder",
        },
        {
          billDate: "2026-10-14",
          twdAmount: "321" as unknown as number,
          usdAmount: null,
          billStatus: "unparseable-amount",
        },
        {
          billDate: "2026-10-15",
          twdAmount: 0,
          usdAmount: null,
          billStatus: "valid-zero",
        },
        {
          billDate: "2026/10/10",
          twdAmount: 321,
          usdAmount: null,
          billStatus: "valid-history",
        },
        {
          billDate: "2026-09-20T08:30:00+08:00",
          twdAmount: 900,
          usdAmount: null,
          billStatus: "current-history-copy",
        },
        {
          billDate: "2026-02-30",
          twdAmount: 100,
          usdAmount: null,
          billStatus: "invalid-date",
        },
      ],
      sourceId,
      "2026-09-20",
    );

    expect(
      parsed.map(({ statementClosingDate, statementAmount }) => [
        statementClosingDate,
        statementAmount,
      ]),
    ).toEqual([
      ["2026-10-15", 0],
      ["2026-10-10", 321],
      ["2026-09-20", 900],
    ]);
    expect(
      parsed.every(
        (bill) =>
          bill.paymentDueDate === undefined && bill.isPaid === undefined,
      ),
    ).toBe(true);
  });

  it("沒有有效 RecentBill 錨點時保留歷史列，但不替它猜金額或狀態", () => {
    const parsed = parseCathayHistoryBills(
      [
        {
          billDate: "2026-10-16",
          twdAmount: null,
          usdAmount: null,
          billStatus: "no-anchor",
        },
      ],
      sourceId,
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0].statementAmount).toBeUndefined();
    expect(parsed[0].isPaid).toBeUndefined();
    expect(parsed[0].paymentDueDate).toBeUndefined();
  });

  it.each([
    { historyAmount: 0, summary: { unPaidAmount: 0 }, expectedAmount: 0 },
    { historyAmount: -200, summary: { unPaidAmount: 0 }, expectedAmount: -200 },
    {
      historyAmount: -200,
      summary: { unPaidAmount: -200, paidAmount: 0 },
      expectedAmount: -200,
    },
    { historyAmount: 900, summary: { unPaidAmount: 400 }, expectedAmount: 900 },
    {
      historyAmount: 900,
      summary: { unPaidAmount: 0, paidAmount: 0 },
      expectedAmount: 0,
    },
    {
      historyAmount: -200,
      summary: { unPaidAmount: 400, paidAmount: 600 },
      expectedAmount: 1000,
    },
  ])(
    "當期摘要 $summary 與歷史 $historyAmount 合併後保留有效總額 $expectedAmount",
    ({ historyAmount, summary, expectedAmount }) => {
      const history = parseCathayHistoryBills(
        [
          {
            billDate: "2026-09-20",
            twdAmount: historyAmount,
            usdAmount: null,
            billStatus: "ignored-history-status",
          },
        ],
        sourceId,
        "2026-09-20",
      );
      const current = parseCathayCurrentBills(
        api({ recentBillDate: "2026-09-20", twBillInfo: summary }),
        null,
        api({ dueDate: "2026-10-05" }),
        sourceId,
      );
      const merged = mergeCathayCurrentBills(history, current.creditCardBills);

      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        accountId: sourceId,
        billingPeriod: "2026-09",
        statementAmount: expectedAmount,
        paymentDueDate: "2026-10-05",
        currency: "TWD",
        raw: { source: "C_BILL_Q_RecentBillInfo" },
      });
      expect(history[0].statementAmount).toBe(historyAmount);
    },
  );

  it("當期狀態與期限只套用在 RecentBill 同期，舊歷史列不回填", () => {
    const history = parseCathayHistoryBills(
      [
        {
          billDate: "2026-09-20",
          twdAmount: 900,
          usdAmount: null,
          billStatus: "ignored-history-status",
        },
        {
          billDate: "2026-08-20",
          twdAmount: 700,
          usdAmount: null,
          billStatus: "ignored-history-status",
        },
      ],
      sourceId,
      "2026-09-20",
    );
    const current = parseCathayCurrentBills(
      api({
        recentBillDate: "2026-09-20",
        twBillInfo: { unPaidAmount: 0, paidAmount: 900 },
      }),
      api({
        currencyBillInfoList: [
          {
            currency: "TWD",
            currencyDataType: "TWD",
            currentMinPaymentAmount: 75,
          },
        ],
      }),
      api({ dueDate: "2026-10-05", twdBillDetail: { payBillStatus: "Payed" } }),
      sourceId,
    );
    const merged = mergeCathayCurrentBills(history, current.creditCardBills);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      statementAmount: 900,
      minimumPayment: 75,
      isPaid: true,
      paymentDueDate: "2026-10-05",
    });
    expect(merged[1]).toMatchObject({
      billingPeriod: "2026-08",
      statementAmount: 700,
    });
    expect(merged[1].isPaid).toBeUndefined();
    expect(merged[1].paymentDueDate).toBeUndefined();
  });
});
