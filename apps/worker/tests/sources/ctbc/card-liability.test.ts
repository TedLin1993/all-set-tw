import { describe, expect, it } from "vitest";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";

describe("中信信用卡負債", () => {
  it("帳單剩餘應繳加已入帳未結帳消費，不重扣已入帳的繳款", () => {
    const unbilledItem = (purchaseAmt: number, description: string) => ({
      purchaseDt: "2026-10-01",
      postingDt: "2026-10-02",
      purchaseAmt,
      description,
      cardNoSuffixFour: "1234",
    });
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
                  billAmt: 3963,
                  pmtAmt: 3000,
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
  });
});
