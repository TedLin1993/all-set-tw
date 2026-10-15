import { describe, expect, it } from "vitest";
import { inspectCtbcDepositStructure } from "../../../src/sources/ctbc/deposit-structure";

describe("中信總覽結構的本機去識別", () => {
  it("僅保留已核對的固定欄位與型別，未知動態鍵不因同名白名單而外洩", () => {
    const result = inspectCtbcDepositStructure({
      token: "synthetic-secret-token",
      rsData: {
        twdAcctSummaryResponse: {
          demDepBalSummaryResponse: {
            infoList: [
              {
                accountId: "synthetic-account",
                balance: "123.4567",
                accountNickName: "synthetic-name",
              },
              { accountId: "another-account", balance: 0 },
            ],
          },
        },
        "synthetic-dynamic-account": {
          balance: { "synthetic-private-key": "synthetic-private-value" },
        },
      },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      "synthetic-secret-token",
      "synthetic-account",
      "123.4567",
      "synthetic-name",
      "another-account",
      "synthetic-dynamic-account",
      "synthetic-private-key",
      "synthetic-private-value",
    ])
      expect(serialized).not.toContain(secret);
    expect(result.fields).toContainEqual({
      path: "$.rsData.twdAcctSummaryResponse.demDepBalSummaryResponse.infoList[*].balance",
      type: "number",
    });
    expect(result.fields).toContainEqual({
      path: "$.rsData.twdAcctSummaryResponse.demDepBalSummaryResponse.infoList[*].balance",
      type: "string",
    });
    expect(result.fields).toContainEqual({
      path: "$.rsData[*][*][*]",
      type: "string",
    });
    expect(serialized).not.toContain("$.rsData[*].balance");
  });

  it("重複帳戶不洩漏筆數，空清單和未知結構不假裝成已識別的外幣", () => {
    const row = { accountId: "synthetic", balance: 0 };
    const overview = (infoList: unknown[]) => ({
      rsData: {
        twdAcctSummaryResponse: { demDepBalSummaryResponse: { infoList } },
      },
    });
    expect(inspectCtbcDepositStructure(overview([row, row]))).toEqual(
      inspectCtbcDepositStructure(overview([row])),
    );
    expect(inspectCtbcDepositStructure(overview([])).fields).toContainEqual({
      path: "$.rsData.twdAcctSummaryResponse.demDepBalSummaryResponse.infoList",
      type: "array",
    });
    expect(inspectCtbcDepositStructure(null).fields).toEqual([
      { path: "$", type: "null" },
    ]);
  });
});
