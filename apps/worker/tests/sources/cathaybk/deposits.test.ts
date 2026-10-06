import { describe, expect, it } from "vitest";
import { appendCathayDepositTransactions } from "../../../src/sources/cathaybk/connector";
import {
  assertCathayDepositQuery,
  parseCathayDepositTransactions,
  parseCathayForeignDeposits,
} from "../../../src/sources/cathaybk/protocol";

const accountNumber = "123456789012";
const accountId = `bank:cathaybk:${accountNumber}`;

// 預期依據：官方 B0103 前端將 incomeAmt 作為收入、expendAmt 作為支出，
// queryStatus 的 NoData／Fail 分別顯示查無交易／查詢錯誤；查詢天數包含首尾。
// 帳號、日期與金額皆為合成資料，不代表已驗證真實帳務或瀏覽器查詢時序。
describe("國泰存款同步核心保障", () => {
  it("新回應解析保留收入與支出方向，接受銀行前置補零的帳號", () => {
    const details = parseCathayDepositTransactions(
      {
        returnCode: "0000",
        content: {
          datas: [
            {
              accountNumber: `0000${accountNumber}`,
              queryStatus: "Success",
              details: [
                {
                  accountDate: "2026-09-01",
                  incomeAmt: 1000,
                  expendAmt: 0,
                  description: "薪資",
                },
                {
                  accountDate: "2026-09-02",
                  incomeAmt: 0,
                  expendAmt: 250,
                  description: "轉帳",
                },
              ],
            },
          ],
        },
      },
      accountNumber,
    );
    const transactions: Parameters<typeof appendCathayDepositTransactions>[0] =
      [];
    appendCathayDepositTransactions(transactions, details, accountId, "TWD");
    expect(transactions).toMatchObject([
      {
        accountId,
        amount: 1000,
        currency: "TWD",
      },
      {
        accountId,
        amount: -250,
        currency: "TWD",
      },
    ]);
  });

  it("銀行明確回覆 NoData 時保留正常的空交易結果", () => {
    expect(
      parseCathayDepositTransactions(
        {
          returnCode: "0000",
          content: {
            datas: [{ accountNumber, queryStatus: "NoData", details: [] }],
          },
        },
        accountNumber,
      ),
    ).toEqual([]);
  });

  it("其他帳戶的空結果不能當成所查帳戶的結果", () => {
    expect(() =>
      parseCathayDepositTransactions(
        {
          returnCode: "0000",
          content: {
            datas: [
              {
                accountNumber: "0000987654321012",
                queryStatus: "NoData",
                details: [],
              },
            ],
          },
        },
        accountNumber,
      ),
    ).toThrow("回應帳號不符");
  });

  it("不能把查詢失敗當成零筆交易", () => {
    expect(() =>
      parseCathayDepositTransactions(
        {
          returnCode: "0000",
          content: {
            datas: [{ accountNumber, queryStatus: "Fail", details: [] }],
          },
        },
        accountNumber,
      ),
    ).toThrow("查詢失敗");
  });

  it("30 天請求不能用作 90 天同步，避免遺漏前 60 天交易", () => {
    const filter = {
      accountNumber: `0000${accountNumber}`,
      startDate: "2026-07-09",
      endDate: "2026-10-06",
    };
    const request = (changes = {}) => ({
      content: { queryFilters: [{ ...filter, ...changes }] },
    });
    expect(() =>
      assertCathayDepositQuery(request(), accountNumber, 90),
    ).not.toThrow();
    expect(() =>
      assertCathayDepositQuery(
        request({ startDate: "2026-09-07" }),
        accountNumber,
        90,
      ),
    ).toThrow("帳號或期間不符");
  });

  // 獨立預期來源：官方 R0101_FDepInq 使用 details[].balance 與
  // currencyCode 顯示原幣餘額，equalTwdBalance 僅顯示臺幣參考值；
  // isGetDemandAccountSuccess 為 false 時顯示錯誤，為 true 且清單空時才是無帳戶。
  // 以下回應皆為合成資料，尚未驗證有外幣帳戶的真實 API 回應。
  // raw 的預期依據：docs/004-connector-development.md 禁止保存完整帳號與
  // token／cookie，僅允許遮罩或白名單資料；額外敏感欄位亦為合成資料。
  it("同帳號依幣別保留原幣小數餘額，raw 僅保存末四碼與白名單", () => {
    const result = parseCathayForeignDeposits({
      returnCode: "0000",
      content: {
        isGetDemandAccountSuccess: true,
        demandAccounts: [
          {
            account: accountNumber,
            details: [
              {
                currencyCode: "USD",
                balance: "12.34",
                equalTwdBalance: 400,
                token: "synthetic-token",
              },
              {
                currencyCode: "EUR",
                balance: 56.78,
                equalTwdBalance: 2000,
                cookie: "synthetic-cookie",
              },
            ],
          },
        ],
      },
    });
    expect(result.bankAccounts).toMatchObject([
      { sourceId: `${accountId}:USD`, currency: "USD" },
      { sourceId: `${accountId}:EUR`, currency: "EUR" },
    ]);
    expect(result.bankBalanceSnapshots).toMatchObject([
      { accountId: `${accountId}:USD`, balance: 12.34, currency: "USD" },
      { accountId: `${accountId}:EUR`, balance: 56.78, currency: "EUR" },
    ]);
    const expectedRaw = [
      { accountSuffix: "9012", currencyCode: "USD", balance: 12.34 },
      { accountSuffix: "9012", currencyCode: "EUR", balance: 56.78 },
    ];
    expect(result.bankAccounts.map(({ raw }) => raw)).toEqual(expectedRaw);
    expect(result.bankBalanceSnapshots.map(({ raw }) => raw)).toEqual(
      expectedRaw,
    );
  });

  it("外幣查詢成功且沒有帳戶時回傳空資料，不建立假的零餘額", () => {
    expect(
      parseCathayForeignDeposits({
        returnCode: "0000",
        content: { isGetDemandAccountSuccess: true, demandAccounts: [] },
      }),
    ).toEqual({ bankAccounts: [], bankBalanceSnapshots: [] });
  });

  it("外幣查詢失敗不能當成沒有外幣帳戶", () => {
    expect(() =>
      parseCathayForeignDeposits({
        returnCode: "0000",
        content: { isGetDemandAccountSuccess: false, demandAccounts: [] },
      }),
    ).toThrow("國泰世華外幣活存查詢失敗，未更新資料。");
  });
});
