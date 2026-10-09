import { describe, expect, it, vi } from "vitest";
import {
  fetchTaishinDeposits,
  parseTaishinTwdDepositTransactions,
  parseTaishinFxDepositTransactions,
  TaishinDepositProtocolError,
} from "../../../src/sources/taishin/deposit-protocol";
import {
  bankNow,
  depositRequest,
  TWD_ACCOUNT,
  FX_ACCOUNT,
  twdTransactions,
  fxTransactions,
  fxOverview,
} from "./fixtures/bank-data";

async function fxAccountError(accounts: unknown) {
  const result = await fetchTaishinDeposits(
    (path, body) =>
      path.endsWith("/getRB08000100Data")
        ? Promise.resolve({ error: null, data: { FCS_ACCOUNT: accounts } })
        : depositRequest(path, body),
    bankNow,
  ).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(TaishinDepositProtocolError);
  if (!(result instanceof TaishinDepositProtocolError))
    throw new Error("預期外幣清單驗證失敗");
  return result;
}

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

  it("外幣驗證定位巢狀欄位，陣列與物件映射都遮罩帳戶鍵、索引與欄位值", async () => {
    const group = fxOverview.data.FCS_ACCOUNT[0]!;
    const sensitiveName = "合成帳戶別名";
    const sensitiveAmount = "87654.32";
    const invalid = {
      ...group,
      ACCOUNT_NAME: sensitiveName,
      FCS_ACCOUNT_DETAIL: [
        {
          ...group.FCS_ACCOUNT_DETAIL[0],
          BALANCE: sensitiveAmount,
          CURRENCY_CODE: null,
          token: "synthetic-secret-token",
        },
      ],
    };
    for (const accounts of [
      [invalid],
      { [FX_ACCOUNT]: invalid },
      { ACCOUNT_NO: invalid },
      { FCS_ACCOUNT_DETAIL: invalid },
    ]) {
      const error = await fxAccountError(accounts);
      expect(error.diagnostics).toEqual({
        issues: [
          {
            path: "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
            code: "invalid_type",
            expected: "string",
            received: "null",
          },
        ],
        truncated: false,
      });
      expect(error.message).toContain("格式驗證失敗");
      expect(error.message).toContain("CURRENCY_CODE");
      expect(error.cause).toBeUndefined();
      const output = error.message + JSON.stringify(error);
      for (const secret of [
        FX_ACCOUNT,
        sensitiveName,
        sensitiveAmount,
        "synthetic-secret-token",
      ])
        expect(output).not.toContain(secret);
    }
  });

  it("外幣清單缺省、null、巢狀形狀與金融欄位不符仍失敗，診斷僅包含型別", async () => {
    const group = fxOverview.data.FCS_ACCOUNT[0]!;
    const detail = group.FCS_ACCOUNT_DETAIL[0]!;
    const detailAccounts = (fields: Record<string, unknown>) => [
      { ...group, FCS_ACCOUNT_DETAIL: [{ ...detail, ...fields }] },
    ];
    for (const [accounts, path, code, expected, received] of [
      [undefined, "FCS_ACCOUNT", "invalid_union", "array|object", "missing"],
      [null, "FCS_ACCOUNT", "invalid_union", "array|object", "null"],
      [
        [{ ...group, FCS_ACCOUNT_DETAIL: {} }],
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL",
        "invalid_type",
        "array",
        "object",
      ],
      [
        [{ ...group, ACCOUNT_NAME: null }],
        "FCS_ACCOUNT[*].ACCOUNT_NAME",
        "invalid_type",
        "string",
        "null",
      ],
      [
        detailAccounts({ ACCOUNT_NO: null }),
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].ACCOUNT_NO",
        "invalid_type",
        "string",
        "null",
      ],
      [
        detailAccounts({ BALANCE: undefined }),
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].BALANCE",
        "invalid_union",
        "string|number",
        "missing",
      ],
      [
        detailAccounts({ BALANCE: null }),
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].BALANCE",
        "invalid_union",
        "string|number",
        "null",
      ],
      [
        detailAccounts({ CURRENCY_CODE: "" }),
        "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
        "invalid_format",
        "string",
        "string",
      ],
      [
        [{ ...group, ACCOUNT_NO: "" }],
        "FCS_ACCOUNT[*].ACCOUNT_NO",
        "too_small",
        "string",
        "string",
      ],
    ]) {
      const error = await fxAccountError(accounts);
      expect(error.diagnostics).toEqual({
        issues: [{ path, code, expected, received }],
        truncated: false,
      });
      expect(error.incomplete).toBe(false);
    }
  });

  it("去識別後合併相同診斷，最多保留五項並標示截斷", async () => {
    const group = fxOverview.data.FCS_ACCOUNT[0]!;
    const repeated = await fxAccountError(
      Array.from({ length: 10 }, () => ({
        ...group,
        FCS_ACCOUNT_DETAIL: [
          { ...group.FCS_ACCOUNT_DETAIL[0], CURRENCY_CODE: null },
        ],
      })),
    );
    expect(repeated.diagnostics?.issues).toHaveLength(1);
    expect(repeated.diagnostics?.truncated).toBe(false);
    const multiple = await fxAccountError([
      {
        ACCOUNT_NO: null,
        ACCOUNT_NAME: null,
        FCS_ACCOUNT_DETAIL: [
          {
            ACCOUNT_NO: null,
            ACCOUNT_ALIAS: 123,
            CURRENCY_CODE: null,
            BALANCE: null,
          },
        ],
      },
    ]);
    expect(multiple.diagnostics?.issues).toHaveLength(5);
    expect(multiple.diagnostics?.truncated).toBe(true);
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
