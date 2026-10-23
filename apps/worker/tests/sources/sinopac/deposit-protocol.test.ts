import { describe, expect, it, vi } from "vitest";
import {
  fetchSinopacDeposits,
  parseSinopacDepositAccounts,
  parseSinopacDepositTransactions,
} from "../../../src/sources/sinopac/deposit-protocol";
import {
  sinopacDepositAccounts,
  sinopacDepositTransactions,
  sinopacDepositNoTransactions,
} from "./fixtures/deposits";

describe("永豐活存查詢", () => {
  it("解析臺外幣活存餘額，保留零餘額且不加上綜存定存", () => {
    const result = parseSinopacDepositAccounts(
      sinopacDepositAccounts,
      new Date("2026-10-02T16:30:00Z"),
    );
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankAccounts.map((a) => a.currency)).toEqual(["TWD", "USD"]);
    // 帳戶名稱以銀行提供的帳戶種類加末四碼。
    expect(result.bankAccounts.map((a) => a.accountName)).toEqual([
      "活期儲蓄存款 末四碼 2345",
      "外幣組合存款 末四碼 2345",
    ]);
    expect(result.bankBalanceSnapshots.map((s) => s.balance)).toEqual([
      12000, 0,
    ]);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      availableBalance: 11900,
      sourceId: expect.stringContaining("2026-10-03"),
    });
    expect(new Set(result.bankAccounts.map((a) => a.sourceId)).size).toBe(2);
    expect(JSON.stringify(result)).not.toContain("0000000012345");
  });

  it("保留正負號與來源時間，計息日不作為入帳日，備註帳號只保留末四碼", () => {
    const transactions = parseSinopacDepositTransactions(
      sinopacDepositTransactions,
      "0000000012345",
      "TWD",
    );
    expect(transactions[0]).toMatchObject({
      amount: -1000,
      authorizedAt: "2026-10-02T19:06:00+08:00",
      postedDate: "2026-10-02",
      status: "posted",
      raw: { valueDate: "2026-10-05" },
    });
    expect(transactions[1]).toMatchObject({
      amount: 600,
      authorizedAt: "2026-10-01",
      currency: "TWD",
    });
    expect(JSON.stringify(transactions)).not.toMatch(/00000000/);
    expect(transactions[0].description).toContain("****8765");
  });

  it("重新排序、修改備註或補上時間時交易 ID 穩定，同筆金額的不同交易仍保留", () => {
    const original = parseSinopacDepositTransactions(
      sinopacDepositTransactions,
      "0000000012345",
      "TWD",
    );
    const changed = [
      {
        ...sinopacDepositTransactions[0],
        SubInfo: [...sinopacDepositTransactions[0].SubInfo]
          .reverse()
          .map((r) => ({
            ...r,
            DataText1:
              r.DataText1 === "2026/10/01"
                ? "2026/10/01<br>10:30"
                : r.DataText1,
            DataText8: "補充備註",
          })),
      },
    ];
    expect(
      parseSinopacDepositTransactions(changed, "0000000012345", "TWD")
        .map((t) => t.sourceId)
        .sort(),
    ).toEqual(original.map((t) => t.sourceId).sort());
    const repeated = [
      {
        ...sinopacDepositTransactions[0],
        SubInfo: [
          sinopacDepositTransactions[0].SubInfo[0],
          sinopacDepositTransactions[0].SubInfo[0],
        ],
      },
    ];
    expect(
      new Set(
        parseSinopacDepositTransactions(repeated, "0000000012345", "TWD").map(
          (t) => t.sourceId,
        ),
      ).size,
    ).toBe(2);
  });

  it("只接受銀行明確回覆的無交易清單，未知錯誤與缺少欄位仍失敗", () => {
    expect(
      parseSinopacDepositTransactions(
        sinopacDepositNoTransactions,
        "0000000012345",
        "USD",
      ),
    ).toEqual([]);
    expect(() =>
      parseSinopacDepositTransactions(
        [{ Header: "FAIL", Message: "系統忙碌", SubInfo: [] }],
        "0000000012345",
        "USD",
      ),
    ).toThrow();
    expect(() =>
      parseSinopacDepositAccounts([{ Header: "SUCCESS" }]),
    ).toThrow();
    expect(() =>
      parseSinopacDepositTransactions(
        [{ ...sinopacDepositTransactions[0], RecordCount: "2" }],
        "0000000012345",
        "TWD",
      ),
    ).toThrow("不完整");
  });

  it("逐帳戶使用三個月回溯與 YYYYMMDD 查詢，月底日期不溢位", async () => {
    const request = vi.fn(
      async (path: string, _label: string, _body: URLSearchParams) =>
        path.includes("ws_bankbal")
          ? sinopacDepositAccounts
          : sinopacDepositNoTransactions,
    );
    const result = await fetchSinopacDeposits(
      request,
      new Date("2026-05-31T04:00:00Z"),
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][2].get("StartDate")).toBe("20260228");
    expect(request.mock.calls[1][2].get("EndDate")).toBe("20260531");
    expect(request.mock.calls.slice(1).map((c) => c[2].get("Curr"))).toEqual([
      "TWD",
      "USD",
    ]);
    expect(request.mock.calls[1][2].get("QueryType")).toBe("3");
    expect(result.bankAccounts).toHaveLength(2);
  });
});
