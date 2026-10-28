import { describe, expect, it } from "vitest";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";

describe("中信信用卡負債", () => {
  const unbilledItem = (purchaseAmt: number, description: string) => ({
    purchaseDt: "2026-10-01",
    postingDt: "2026-10-02",
    purchaseAmt,
    description,
    cardNoSuffixFour: "1234",
  });

  it("帳單應繳扣除結帳後已入帳的繳款，再加已入帳未結帳消費", () => {
    const result = parseCtbcData({
      depositOverview: {},
      depositTransactions: {},
      creditCards: {
        rsData: {
          billData: {
            TWD: {
              "2026/09": {
                summary: {
                  billDt: "092326",
                  pmtExpDt: "100826",
                  prevBal: 1518,
                  billAmt: 3963,
                  pmtAmt: 1518,
                },
              },
            },
          },
        },
      },
      unbilled: {
        rsData: {
          allItems: [
            unbilledItem(1200, "測試商店"),
            unbilledItem(-200, "測試退款"),
            unbilledItem(-3000, "本行扣繳"),
          ],
        },
      },
    });

    expect(
      result.bankBalanceSnapshots.find((row) => row.currency === "TWD"),
    ).toMatchObject({ balance: -(963 + 1000), noPaymentNeeded: false });
    expect(result.creditCardBills[0]).toMatchObject({
      paidAmount: 3000,
      isPaid: false,
    });
  });

  it("帳單的 pmtAmt 是繳前一期，各期已繳依下一期 pmtAmt 或未出帳繳款判斷", () => {
    const summary = (
      billDt: string,
      prevBal: number,
      billAmt: number,
      pmtAmt: number,
    ) => ({
      summary: { billDt, currPmtAmt: billAmt, prevBal, billAmt, pmtAmt },
    });
    const result = parseCtbcData({
      depositOverview: {},
      depositTransactions: {},
      creditCards: {
        rsData: {
          billData: {
            TWD: {
              "2026/10": summary("100526", 3963, 7285, 3963),
              // 前期應繳與 8 月應繳對不上時，8 月不推算已繳。
              "2026/09": summary("090626", 16000, 3963, 16000),
              "2026/08": summary("080526", 1518, 16750, 1518),
            },
          },
        },
      },
      unbilled: {
        rsData: {
          allItems: [
            unbilledItem(800, "測試商店"),
            unbilledItem(-7285, "本行扣繳"),
          ],
        },
      },
    });

    expect(
      Object.fromEntries(
        result.creditCardBills.map((bill) => [
          bill.billingPeriod,
          [bill.paidAmount, bill.isPaid],
        ]),
      ),
    ).toEqual({
      "2026-10": [7285, true],
      "2026-09": [3963, true],
      "2026-08": [undefined, undefined],
    });
    expect(
      result.bankBalanceSnapshots.find((row) => row.currency === "TWD"),
    ).toMatchObject({ balance: -800, noPaymentNeeded: true });
  });
});
