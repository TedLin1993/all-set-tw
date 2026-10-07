import { describe, expect, it, vi } from "vitest";
import {
  fetchTaishinDeposits,
  parseTaishinTwdDepositTransactions,
  parseTaishinFxDepositTransactions,
} from "../../../src/sources/taishin/deposit-protocol";
import {
  bankNow,
  depositRequest,
  TWD_ACCOUNT,
  FX_ACCOUNT,
  twdTransactions,
  fxTransactions,
} from "./fixtures/bank-data";

describe("台新臺外幣活存", () => {
  it("採帳戶餘額與原幣精度，保留零餘額且不加上綜存定存，輸出不含完整帳號", async () => {
    const data = await fetchTaishinDeposits(depositRequest, bankNow);
    expect(data.bankAccounts.map((row) => row.currency)).toEqual([
      "TWD",
      "USD",
      "JPY",
    ]);
    expect(data.bankBalanceSnapshots.map((row) => row.balance)).toEqual([
      2000, 125.25, 0,
    ]);
    expect(
      data.bankBalanceSnapshots.map((row) => row.availableBalance),
    ).toEqual([1800, undefined, undefined]);
    expect(data.bankBalanceSnapshots[0].sourceId).toContain("2026-10-07");
    expect(data.bankTransactions.map((row) => row.amount)).toEqual([
      -200, -200, 1000, -12.5, 20.25,
    ]);
    expect(data.bankTransactions[0]).toMatchObject({
      authorizedAt: "2026-10-05T09:15:00+08:00",
      postedDate: "2026-10-06",
    });
    expect(data.bankTransactions[2].authorizedAt).toBe("2026-10-04");
    expect(JSON.stringify(data)).not.toContain(TWD_ACCOUNT);
    expect(JSON.stringify(data)).not.toContain(FX_ACCOUNT);
    expect(data.bankTransactions[0].description).toContain("****1234");
  });

  it("排序、備註及時間精度改變不換 ID，同日同額多筆保持獨立", () => {
    const original = parseTaishinTwdDepositTransactions(
      twdTransactions,
      TWD_ACCOUNT,
    );
    const changed = structuredClone(twdTransactions);
    changed.OUTPUTDATA.userList.reverse().forEach((row) => {
      row.sysdate = row.sysdate.slice(0, 8);
      row.message = "變更備註";
    });
    expect(
      parseTaishinTwdDepositTransactions(changed, TWD_ACCOUNT)
        .map((row) => row.sourceId)
        .sort(),
    ).toEqual(original.map((row) => row.sourceId).sort());
    const duplicate = {
      RESULT: "NORMAL",
      OUTPUTDATA: {
        inNo: 0,
        outNo: 2,
        userList: [
          twdTransactions.OUTPUTDATA.userList[0],
          twdTransactions.OUTPUTDATA.userList[0],
        ],
      },
    };
    expect(
      new Set(
        parseTaishinTwdDepositTransactions(duplicate, TWD_ACCOUNT).map(
          (row) => row.sourceId,
        ),
      ).size,
    ).toBe(2);
    const otherAccount = "1" + TWD_ACCOUNT.slice(1);
    expect(
      parseTaishinTwdDepositTransactions(twdTransactions, otherAccount)[0]
        .accountId,
    ).not.toBe(original[0].accountId);
    expect(
      parseTaishinFxDepositTransactions(fxTransactions, FX_ACCOUNT, "USD")[0],
    ).toMatchObject({
      amount: -12.5,
      currency: "USD",
      authorizedAt: "2026-10-05T09:30:00+08:00",
      postedDate: "2026-10-06",
    });
  });

  it("月底仍查完整三個月，外幣沿用官方初始化與各幣別查詢", async () => {
    const request = vi.fn(
      async (path: string, body: Record<string, unknown> | string) => {
        if (path.endsWith("/rb0102/query"))
          return {
            RESULT: "NORMAL",
            OUTPUTDATA: { userList: [], inNo: 0, outNo: 0 },
          };
        if (path.endsWith("/getRB08020100ForeignTranDetail"))
          return { error: null, data: { TRANS_DETAILS: {} } };
        return depositRequest(path, body);
      },
    );
    await fetchTaishinDeposits(request, new Date("2026-05-31T04:00:00Z"));
    expect(
      request.mock.calls.find(([path]) => path.endsWith("/rb0102/query"))?.[1],
    ).toEqual({ account: TWD_ACCOUNT, start: "20260228", end: "20260531" });
    expect(
      request.mock.calls
        .filter(([path]) => path.endsWith("/getRB08020100ForeignTranDetail"))
        .map(([, body]) => body),
    ).toEqual(
      ["USD", "JPY"].map((currency) => ({
        requestAcctNo: FX_ACCOUNT,
        requestCurrency: currency,
        requestStartDate: "20260228",
        requestEndDate: "20260531",
        requestDateType: "I",
        requestEmail: "",
        nextNextWorkDay: "",
        rb0802OrderType: "0",
      })),
    );
  });

  it("完整空產品／空交易可以成功，未知錯誤、缺清單、幣別或金融欄位異常須失敗", async () => {
    expect(
      await fetchTaishinDeposits(
        async (path) =>
          path.includes("/web1/")
            ? { RESULT: "NORMAL", OUTPUTDATA: { SavingAccount: [] } }
            : { error: null, data: { FCS_ACCOUNT: [] } },
        bankNow,
      ),
    ).toEqual({
      bankAccounts: [],
      bankBalanceSnapshots: [],
      bankTransactions: [],
    });
    expect(() =>
      parseTaishinTwdDepositTransactions(
        { RESULT: "NORMAL", OUTPUTDATA: { userList: [], inNo: 0, outNo: 0 } },
        TWD_ACCOUNT,
      ),
    ).not.toThrow();
    for (const payload of [
      { RESULT: "NORMAL", OUTPUTDATA: {} },
      { RESULT: "ERROR", ERRORMSG: "系統忙碌" },
      {
        ...twdTransactions,
        OUTPUTDATA: { ...twdTransactions.OUTPUTDATA, outNo: 3 },
      },
    ])
      expect(() =>
        parseTaishinTwdDepositTransactions(payload, TWD_ACCOUNT),
      ).toThrow();
    expect(() =>
      parseTaishinFxDepositTransactions(fxTransactions, FX_ACCOUNT, "JPY"),
    ).toThrow("幣別");
    const invalid = structuredClone(twdTransactions);
    invalid.OUTPUTDATA.userList[0].txnamt = "未知金額";
    expect(() =>
      parseTaishinTwdDepositTransactions(invalid, TWD_ACCOUNT),
    ).toThrow("金額");
  });

  it("筆數截斷時拆分不重疊期間，單日仍不完整則失敗", async () => {
    const request = vi.fn(
      async (path: string, body: Record<string, unknown> | string) => {
        if (path.endsWith("/rb0102/query") && typeof body !== "string") {
          const rows = twdTransactions.OUTPUTDATA.userList.filter(
            (row) =>
              row.sysdate.slice(0, 8) >= String(body.start) &&
              row.sysdate.slice(0, 8) <= String(body.end),
          );
          const payload = {
            RESULT: "NORMAL",
            OUTPUTDATA: {
              userList: rows,
              inNo: rows.filter((row) => row.txnamtOut === "-").length,
              outNo: rows.filter((row) => row.txnamtIn === "-").length,
            },
          };
          return body.start === "20260707" && body.end === "20261007"
            ? {
                ...payload,
                OUTPUTDATA: {
                  ...payload.OUTPUTDATA,
                  userList: rows.slice(0, 1),
                },
              }
            : payload;
        }
        return depositRequest(path, body);
      },
    );
    const complete = await fetchTaishinDeposits(request, bankNow);
    expect(complete.bankTransactions.map((row) => row.sourceId).sort()).toEqual(
      (await fetchTaishinDeposits(depositRequest, bankNow)).bankTransactions
        .map((row) => row.sourceId)
        .sort(),
    );
    await expect(
      fetchTaishinDeposits(
        async (path, body) =>
          path.endsWith("/rb0102/query")
            ? {
                RESULT: "NORMAL",
                OUTPUTDATA: { userList: [], inNo: 1, outNo: 0 },
              }
            : depositRequest(path, body),
        bankNow,
      ),
    ).rejects.toThrow("不完整");
  });
});
