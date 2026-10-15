import { expect, it } from "vitest";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";

it("非空但無法辨識的末碼欄位，仍使用既有 masked cardNo 的末碼；衝突不推定", () => {
  const data = parseCtbcData({
    depositOverview: {},
    depositTransactions: {},
    creditCards: {
      rsData: {
        cardDataList: [
          {
            cardNoSuffixFour: "unavailable",
            cardNo: "****1111",
            cardName: "合成甲卡",
          },
          { cardNoSuffixFour: "2222", cardNo: "****3333", cardName: "衝突卡" },
          {
            cardNoSuffixFour: "4444",
            cardNo: "****4444",
            cardName: "合成乙卡",
          },
          { cardNoSuffixFour: "unknown", cardNo: "masked", cardName: "未知卡" },
        ],
        billData: {
          TWD: {
            "2026/10": {
              summary: { billAmt: "25", billDt: "101526" },
              bills: [],
            },
          },
        },
      },
    },
  });
  expect(data.bankAccounts).toHaveLength(1);
  expect(data.bankAccounts[0].raw).toEqual({
    cards: [
      {
        cardLast4: "1111",
        cardName: "合成甲卡",
        positiveOrAttached: undefined,
      },
      {
        cardLast4: undefined,
        cardName: "衝突卡",
        positiveOrAttached: undefined,
      },
      {
        cardLast4: "4444",
        cardName: "合成乙卡",
        positiveOrAttached: undefined,
      },
      {
        cardLast4: undefined,
        cardName: "未知卡",
        positiveOrAttached: undefined,
      },
    ],
  });
  expect(data.bankBalanceSnapshots).toHaveLength(1);
  expect(data.creditCardBills).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain("****1111");
});

it("官方尾端底線識別標記只正規化顯示末碼，既有交易 sourceId 不變", () => {
  const parse = (cardNo: string) =>
    parseCtbcData({
      depositOverview: {},
      depositTransactions: {},
      creditCards: {
        rsData: {
          cardDataList: [
            {
              cardNoSuffixFour: "5555_1",
              cardNo: "****5555",
              cardName: "合成後綴卡",
            },
          ],
          billData: {
            TWD: {
              "2026/10": {
                summary: { billAmt: "25", billDt: "101526" },
                bills: [
                  {
                    purchaseDt: "101026",
                    postingDt: "101126",
                    ntAmt: "1",
                    cardNo,
                    merchantChiName: "合成店家",
                  },
                ],
              },
            },
          },
        },
      },
    });
  const parsed = parse("5555_1");
  expect((parsed.bankAccounts[0].raw as any).cards[0].cardLast4).toBe("5555");
  expect(parsed.bankTransactions[0].raw).toMatchObject({
    displayCardLast4: "5555",
  });
  // Both values were unparseable by the established identity algorithm.
  expect(parsed.bankTransactions[0].sourceId).toBe(
    parse("unavailable").bankTransactions[0].sourceId,
  );
});
