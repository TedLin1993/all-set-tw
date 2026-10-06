import { describe, expect, it } from "vitest";
import { scrapeCreditCards } from "../../../src/sources/cathaybk/connector";

// 獨立預期來源：官方 C0101 前端將 CardStatus.Invalid 顯示為無卡；
// 專案無卡契約要求空金融資料，不建立零餘額，HTTP 失敗不能當成無卡。
// Stub 只提供信用卡狀態 API 的結果，不模擬銀行 DOM 或請求時序。
function cardStatusPage(httpStatus = 200) {
  return {
    on: () => undefined,
    off: () => undefined,
    goto: async () => null,
    url: () =>
      "https://www.cathaybk.com.tw/OnlineBanking/CQuery/C0101_BillOverview",
    waitForResponse: async () => ({
      status: () => httpStatus,
      json: async () => ({
        returnCode: "0000",
        content: { cardStatus: "Invalid" },
      }),
    }),
  } as unknown as Parameters<typeof scrapeCreditCards>[0];
}

describe("國泰無信用卡的金融資料保障", () => {
  it("銀行確認無卡時回傳空信用卡資料，不建立假的零餘額", async () => {
    await expect(scrapeCreditCards(cardStatusPage())).resolves.toEqual({
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
      creditCardBills: [],
    });
  });

  it("HTTP 失敗不能因為回應帶有 Invalid 就當成無卡成功", async () => {
    await expect(scrapeCreditCards(cardStatusPage(503))).rejects.toThrow(
      "國泰世華信用卡狀態查詢失敗，未更新資料。",
    );
  });
});
