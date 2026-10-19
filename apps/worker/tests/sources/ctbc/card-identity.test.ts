import { expect, it } from "vitest";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";

it("交易只在末四碼唯一對應具名卡片時標示卡名；重複、矛盾不猜測", () => {
  const item = (description: string, card: Record<string, string>) => ({
    purchaseDt: "2026-10-01",
    postingDt: "2026-10-02",
    purchaseAmt: 100,
    description,
    ...card,
  });
  const result = parseCtbcData({
    depositOverview: {},
    depositTransactions: {},
    creditCards: {
      rsData: {
        billData: {},
        cardDataList: [
          // An unparseable suffix field falls back to the masked card number.
          {
            cardNoSuffixFour: "unavailable",
            cardNo: "****1111",
            cardName: "合成甲卡",
          },
          { cardNoSuffixFour: "2222_1", cardName: "合成乙卡" },
          { cardNoSuffixFour: "3333", cardName: "合成丙卡" },
          { cardNoSuffixFour: "3333", cardName: "合成丁卡" },
        ],
      },
    },
    unbilled: {
      rsData: {
        allItems: [
          item("甲卡消費", { cardNoSuffixFour: "1111" }),
          item("乙卡消費", { cardNoSuffixFour: "2222_1" }),
          item("重複末碼消費", { cardNoSuffixFour: "3333" }),
          item("卡號矛盾消費", {
            cardNoSuffixFour: "1111",
            cardNo: "****9999",
          }),
        ],
      },
    },
  });

  expect(
    result.bankTransactions.map(({ description, cardLast4, cardName }) => ({
      description,
      cardLast4,
      cardName,
    })),
  ).toEqual([
    { description: "甲卡消費", cardLast4: "1111", cardName: "合成甲卡" },
    { description: "乙卡消費", cardLast4: "2222", cardName: "合成乙卡" },
    { description: "重複末碼消費", cardLast4: "3333", cardName: undefined },
    { description: "卡號矛盾消費", cardLast4: undefined, cardName: undefined },
  ]);
  // The shared per-currency account is no longer named after the first card.
  expect(result.bankAccounts.map((account) => account.accountName)).toEqual([
    "中國信託信用卡",
  ]);
});
