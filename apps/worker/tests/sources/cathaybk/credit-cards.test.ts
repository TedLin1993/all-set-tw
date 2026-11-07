import { describe, expect, it } from "vitest";
import { scrapeCreditCards } from "../../../src/sources/cathaybk/connector";

// 獨立預期來源：官方 C0101 前端將 CardStatus.Invalid，以及 returnCode 結尾為 702 的
// 狀態查詢錯誤，都顯示為無卡；專案無卡契約要求空金融資料，不建立零餘額，HTTP 失敗
// 與其他錯誤碼不能當成無卡。Stub 只提供信用卡狀態 API 的結果，不模擬銀行 DOM 或請求時序。
const INVALID_CARD_STATUS = {
  returnCode: "0000",
  content: { cardStatus: "Invalid" },
};

function cardStatusPage(httpStatus = 200, body: unknown = INVALID_CARD_STATUS) {
  return {
    on: () => undefined,
    off: () => undefined,
    goto: async () => null,
    url: () =>
      "https://www.cathaybk.com.tw/OnlineBanking/CQuery/C0101_BillOverview",
    waitForResponse: async () => ({
      status: () => httpStatus,
      json: async () => body,
    }),
  } as unknown as Parameters<typeof scrapeCreditCards>[0];
}

describe("國泰無信用卡的金融資料保障", () => {
  it.each([
    ["CardStatus.Invalid", INVALID_CARD_STATUS],
    ["狀態查詢錯誤碼結尾為 702", { returnCode: "E0702", content: null }],
  ])(
    "銀行確認無卡時回傳空信用卡資料，不建立假的零餘額：%s",
    async (_label, body) => {
      await expect(
        scrapeCreditCards(cardStatusPage(200, body)),
      ).resolves.toEqual({
        bankAccounts: [],
        bankBalanceSnapshots: [],
        bankTransactions: [],
        creditCardBills: [],
      });
    },
  );

  it("其他錯誤碼不能當成無卡", async () => {
    await expect(
      scrapeCreditCards(cardStatusPage(200, { returnCode: "9999" })),
    ).rejects.toThrow("國泰世華信用卡狀態回應無法辨識，未更新資料。");
  });

  it("HTTP 失敗不能因為回應帶有 Invalid 就當成無卡成功", async () => {
    await expect(scrapeCreditCards(cardStatusPage(503))).rejects.toThrow(
      "國泰世華信用卡狀態查詢失敗，未更新資料。",
    );
  });
});
