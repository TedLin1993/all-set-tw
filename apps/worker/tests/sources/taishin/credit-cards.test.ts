import { describe, expect, it } from "vitest";
import { parseTaishinCreditCardData } from "../../../src/sources/taishin/protocol";
import {
  bankNow,
  bill,
  emptyRealtime,
  emptyUnbilled,
  realtime,
  unbilled,
} from "./fixtures/bank-data";

const base = {
  summary: { error: null, value: {} },
  bills: [],
  realtime: emptyRealtime,
  unbilled: emptyUnbilled,
};
describe("台新信用卡金融數字與資料完整性", () => {
  it("依官方欄位顯示店名及新臺幣授權，僅計入成功，保留 v2 ID 與真實時刻", () => {
    const result = parseTaishinCreditCardData({ ...base, realtime }, bankNow);
    expect(result.bankAccounts[0].sourceId).toBe("credit:taishin:main");
    expect(result.bankTransactions).toHaveLength(1);
    expect(result.bankTransactions[0]).toMatchObject({
      sourceId: "taishin:card:tx:v2:TWD:2026-10-05:-252:1234:demoshop:1",
      authorizedAt: "2026-10-05T09:15:30+08:00",
      description: "DEMO SHOP TAIPEI",
      amount: -252,
      currency: "TWD",
      status: "pending",
    });
    const dateOnly = structuredClone(realtime);
    dateOnly.value.fmtRealTxListMap[0].txlist[0][1] = "";
    const transaction = parseTaishinCreditCardData({
      ...base,
      realtime: dateOnly,
    }).bankTransactions[0];
    expect(transaction.sourceId).toBe(result.bankTransactions[0].sourceId);
    expect(transaction.authorizedAt).toBe("2026-10-05");
  });

  it("未出帳保存正式入帳日與原幣退款，與帳單重疊不重複", () => {
    const foreign = structuredClone(unbilled) as {
      error: null;
      value: { unpostedTx: Record<string, unknown> };
    };
    foreign.value.unpostedTx.USD = {
      data: [
        {
          cardname: "測試卡 ****5678",
          txlist: [
            ["2026/10/04", "2026/10/06", "退款", "-12.50", "", "US", "", "USD"],
          ],
        },
      ],
    };
    const result = parseTaishinCreditCardData(
      {
        ...base,
        unbilled: foreign,
        bills: [bill],
        realtime,
      },
      bankNow,
    );
    expect(
      result.bankTransactions
        .filter((row) => row.status === "posted")
        .map((row) => [row.amount, row.currency, row.postedDate]),
    ).toEqual([
      [-252, "TWD", "2026-10-06"],
      [12.5, "USD", "2026-10-06"],
    ]);
    const duplicates = structuredClone(unbilled);
    duplicates.value.unpostedTx["001TWD"].data[0].txlist.push([
      ...duplicates.value.unpostedTx["001TWD"].data[0].txlist[0],
    ]);
    expect(
      parseTaishinCreditCardData({
        ...base,
        unbilled: duplicates,
        bills: [bill],
      }).bankTransactions,
    ).toHaveLength(2);
  });

  it.each([
    { paidAmount: 400, unbilledTotal: "1,430", balance: -2030 },
    { paidAmount: 1000, unbilledTotal: "1,430", balance: -1430 },
    { paidAmount: 1000, unbilledTotal: "-70", balance: 70 },
  ])(
    "負債合計帳單剩餘與官方未出帳（已繳 $paidAmount、未出帳 $unbilledTotal），不重扣繳款或加入授權／外幣",
    ({ paidAmount, unbilledTotal, balance }) => {
      const result = parseTaishinCreditCardData(
        {
          ...base,
          bills: [
            {
              ...bill,
              value: {
                ...bill.value,
                showAccoutnYM: "2026/09",
                showStmtDate: "2026/09/10",
                showDueDate: "2026/09/25",
                newAcctDetailList: [],
              },
            },
          ],
          overview: {
            error: null,
            value: {
              carInfoList: {
                "001": {
                  BillYear: "2026",
                  BillMon: "09",
                  StmtBalance: "1000",
                  LstPymtAmt: String(paidAmount),
                },
              },
            },
          },
          realtime,
          unbilled: {
            error: null,
            value: {
              showRB0712_SUBTOTAL: unbilledTotal,
              unpostedTx: {
                "001TWD": {
                  data: [
                    {
                      cardname: "繳款",
                      totalAmt: "0",
                      txlist: [
                        [
                          "2026/10/03",
                          "2026/10/04",
                          "繳款",
                          `-${paidAmount}`,
                          "",
                          "TW",
                          "",
                          "TWD",
                        ],
                      ],
                    },
                    {
                      cardname: "測試信用卡 ****1234",
                      totalAmt: unbilledTotal,
                      txlist: [
                        ...(unbilledTotal === "1,430"
                          ? [
                              [
                                "2026/10/05",
                                "2026/10/06",
                                "DEMO SHOP",
                                "1,500",
                                "",
                                "TW",
                                "",
                                "TWD",
                              ],
                            ]
                          : []),
                        [
                          "2026/10/04",
                          "2026/10/06",
                          "退款",
                          "-70",
                          "",
                          "TW",
                          "",
                          "TWD",
                        ],
                      ],
                    },
                  ],
                },
                USD: {
                  data: [
                    {
                      cardname: "測試信用卡 ****5678",
                      totalAmt: "-12.50",
                      txlist: [
                        [
                          "2026/10/04",
                          "2026/10/06",
                          "退款",
                          "-12.50",
                          "",
                          "US",
                          "",
                          "USD",
                        ],
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        bankNow,
      );
      expect(result.bankBalanceSnapshots[0]).toMatchObject({
        balance,
        statementBalance: 1000,
        noPaymentNeeded: paidAmount === 1000,
      });
      expect(result.creditCardBills[0]).toMatchObject({
        paidAmount,
        isPaid: paidAmount === 1000,
      });
      expect(result.bankTransactions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ amount: paidAmount, status: "posted" }),
          expect.objectContaining({ amount: -252, status: "pending" }),
        ]),
      );
    },
  );

  it("必要清單缺失或未知錯誤不能當成無消費，明確無消費與無卡可以成功", () => {
    for (const changed of [
      { realtime: { error: null, value: {} } },
      { realtime: { error: "系統忙碌" } },
      { unbilled: { error: null, value: {} } },
      {
        unbilled: {
          error: null,
          value: { unpostedTx: unbilled.value.unpostedTx },
        },
      },
      {
        unbilled: {
          ...unbilled,
          value: { ...unbilled.value, showRB0712_SUBTOTAL: "尚未取得" },
        },
      },
      {
        unbilled: {
          error: null,
          value: { unpostedTx: { "001TWD": { ErrMsg: "無法取得資料" } } },
        },
      },
    ])
      expect(() =>
        parseTaishinCreditCardData({ ...base, ...changed }),
      ).toThrow();
    expect(
      parseTaishinCreditCardData({
        ...base,
        realtime: { error: "(CRXTIKE004)無消費資料" },
        unbilled: {
          error: null,
          value: {
            unpostedTx: { "001TWD": { ErrMsg: "(CRXTIKE004)無消費資料" } },
          },
        },
      }).bankTransactions,
    ).toEqual([]);
    expect(
      parseTaishinCreditCardData({ ...base, hasCreditCard: false })
        .bankAccounts,
    ).toEqual([]);
    const invalid = structuredClone(realtime);
    invalid.value.fmtRealTxListMap[0].txlist[0][1] = "24:15:00";
    expect(() =>
      parseTaishinCreditCardData({ ...base, realtime: invalid }),
    ).toThrow("時間");
  });
});
