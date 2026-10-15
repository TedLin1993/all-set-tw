import { describe, expect, it, vi } from "vitest";
import {
  fetchCtbcCardStatements,
  fetchCtbcPagedCardItems,
} from "../../../src/sources/ctbc/card-data";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";
const summary = { billAmt: "19.25", billDt: "093026", pmtExpDt: "101526" };
const bill = {
  cardNoSuffixFour: "1234",
  purchaseDt: "092626",
  postingDt: "092726",
  ntAmt: "19.25",
  description: "合成店家",
};
const overview = {
  code: "0000",
  rsData: {
    billCycle: "30",
    cardDataList: [],
    billData: {
      TWD: {
        "2026/09": { summary, bills: [] },
        "2026/08": { summary, bills: [] },
      },
    },
  },
};
describe("中信完整信用卡唯讀取數（合成資料）", () => {
  it("補查最新一期明細並讀完分頁，保留原摘要；正規化可產生消費明細", async () => {
    const request = vi.fn(async (..._args: unknown[]) => ({
      code: "0000",
      rsData: {
        summary,
        bills: [bill],
        totalRow: 2,
        pageCount: 1,
        displayPaging: true,
      },
    }));
    const result = await fetchCtbcCardStatements(request, overview, {
      months: 1,
      currency: "TWD",
    });
    expect(request.mock.calls).toEqual([
      [
        "/twrbm-card/qu002/011",
        { curCode: "TWD", month: "2026/09", billCycle: "30" },
      ],
      [
        "/twrbm-card/qu002/016",
        { curCode: "TWD", month: "2026/09", pageNum: 2 },
      ],
    ]);
    const parsed = parseCtbcData({
      depositOverview: {},
      depositTransactions: {},
      creditCards: result,
    });
    expect(parsed.bankTransactions.map((row) => row.amount)).toEqual([
      -19.25, -19.25,
    ]);
    expect(
      new Set(parsed.bankTransactions.map((row) => row.sourceId)).size,
    ).toBe(2);
    expect(overview.rsData.billData.TWD["2026/09"].bills).toEqual([]);
  });
  it("即時交易使用 noMore 判斷，即使沒有 displayPaging 仍抓下一頁", async () => {
    const request = vi.fn(async (..._args: unknown[]) => ({
      code: "0000",
      rsData: {
        allItems: [{ txnDate: "20261015", txnAmt: "7", merchName: "合成交易" }],
        totalRow: 2,
        pageCount: 1,
        noMore: false,
      },
    }));
    const result = await fetchCtbcPagedCardItems(
      request,
      "/twrbm-card/qu041/010",
      "/twrbm-card/qu041/015",
      {},
      "realtime",
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.rsData.allItems).toHaveLength(2);
  });
  it("未出帳明細與即時授權分別保留已入帳與 pending 狀態", () => {
    const result = parseCtbcData({
      depositOverview: {},
      depositTransactions: {},
      creditCards: {},
      unbilled: {
        rsData: {
          allItems: [{ ...bill, sourceCurrency: "TWD", purchaseAmt: "19.25" }],
        },
      },
      realtime: {
        rsData: {
          allItems: [
            {
              txnDate: "20261015",
              txnAmt: "7",
              merchName: "合成授權",
              cardNoSuffixFour: "1234",
            },
          ],
        },
      },
    });
    expect(result.bankTransactions.map((row) => row.status).sort()).toEqual([
      "pending",
      "posted",
    ]);
  });
  it.each([
    { code: "9999", rsData: { allItems: [] } },
    { code: "0000", rsData: {} },
    { code: "0000", rsData: { allItems: [null] } },
    { code: "0000", rsData: { allItems: [], noMore: "false" } },
    {
      code: "0000",
      rsData: { allItems: [], totalRow: 1, pageCount: 0, noMore: false },
    },
    {
      code: "0000",
      rsData: { allItems: [], totalRow: 2100, pageCount: 100, noMore: false },
    },
  ])("失敗、缺清單或不完整分頁不能偽裝成空交易", async (payload) => {
    await expect(
      fetchCtbcPagedCardItems(
        async () => payload,
        "/twrbm-card/qu041/010",
        "/twrbm-card/qu041/015",
        {},
        "realtime",
      ),
    ).rejects.toThrow();
  });
  it("未出帳官方 8888 只在清單無資料時當空；其他錯誤不吞掉", async () => {
    const result = await fetchCtbcPagedCardItems(
      async () => ({ code: "8888" }),
      "/twrbm-card/qu006/011",
      "/twrbm-card/qu006/015",
      { curCode: "TWD" },
      "unbilled",
    );
    expect(result.rsData.allItems).toEqual([]);
    await expect(
      fetchCtbcPagedCardItems(
        async () => ({ code: "8888", rsData: { allItems: [bill] } }),
        "/twrbm-card/qu006/011",
        "/twrbm-card/qu006/015",
        {},
        "unbilled",
      ),
    ).rejects.toThrow();
  });
});
