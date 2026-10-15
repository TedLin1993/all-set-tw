import { describe, expect, it, vi } from "vitest";
import { fetchCtbcForeignDeposits } from "../../../src/sources/ctbc/foreign-deposits";
import { createCtbcConnector } from "../../../src/sources/ctbc/mobile-api";
import { parseCtbcData } from "../../../src/sources/ctbc/protocol";

const now = new Date("2026-10-15T01:00:00Z");
const accountId = "000000001234";
const rows = [
  {
    accountId,
    curCode: "usd",
    currentBal: "123.4567",
    accountNickName: "合成帳戶",
  },
  { accountId, curCode: "JPY", currentBal: "0" },
];
const overview = (infoList: unknown = rows, rspCode = "0000") => ({
  rsData: {
    fxAcctSummaryResponse: { demDepBalSummaryResponse: { rspCode, infoList } },
  },
});
function requestFixture() {
  return vi.fn(
    async (
      resource: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      if (resource === "/twrbm-fx/qu001/010") return overview();
      if (resource === "/twrbm-fx/qu002/010")
        return {
          rsData: {
            infoList: rows.map((row) => ({ ...row, avialBal: row.currentBal })),
          },
        };
      if (resource === "/twrbm-fx/qu002/011")
        return {
          rsData: {
            detailList: [
              {
                trnDtRaw: "20261002",
                actDtFull: "2026/10/03",
                debitAmt: data.curCode === "USD" ? "0.0123" : "1",
                creditAmt: "0",
                balAmt: "123.4444",
                userMemo: "合成支出",
                acctId: "synthetic-counterparty",
              },
              {
                trnDtRaw: "20261004",
                actDtFull: "2026/10/04",
                debitAmt: "0",
                creditAmt: "0.25",
                balAmt: "123.6944",
                userMemo: "合成收入",
              },
            ],
          },
        };
      throw new Error("Unexpected synthetic request");
    },
  );
}

describe("中信行銀外幣存款（僅合成銀行回應）", () => {
  it.each([
    [overview(rows, "9999"), "overview_status_unconfirmed"],
    [overview(null), "overview_list_invalid"],
    [
      overview([{ ...rows[0], accountId: "masked****" }]),
      "account_identifier_invalid",
    ],
    [
      overview([{ ...rows[0], curCode: "private-invalid-currency" }]),
      "currency_invalid",
    ],
    [
      overview([{ ...rows[0], currentBal: "private-invalid-amount" }]),
      "overview_balance_invalid",
    ],
    [overview([{ ...rows[0], currentBal: "" }]), "overview_balance_missing"],
    [
      overview([rows[0], { ...rows[0], currentBal: "9" }]),
      "duplicate_account_balance_conflict",
    ],
  ])("總覽失敗只使用固定原因，不帶銀行原值", async (payload, reason) => {
    const request = requestFixture();
    const error = await fetchCtbcForeignDeposits(request, payload, now, {
      balancesOnly: true,
    }).catch((error) => error);
    expect(error).toMatchObject({ reason });
    expect(String(error)).not.toContain("private-");
    expect(request).not.toHaveBeenCalled();
  });

  it("所有外幣餘額檢查逐一初始化帳戶幣別，完全不查交易", async () => {
    const base = requestFixture();
    const request = vi.fn(
      async (resource: string, data: Record<string, unknown>) => {
        if (resource.endsWith("/011"))
          throw new Error("Transactions must never be queried");
        return base(resource, data);
      },
    );
    const result = await fetchCtbcForeignDeposits(request, overview(), now, {
      balancesOnly: true,
    });
    expect(
      request.mock.calls.map(([resource, data]) => [resource, data.curCode]),
    ).toEqual([
      ["/twrbm-fx/qu002/010", "USD"],
      ["/twrbm-fx/qu002/010", "JPY"],
    ]);
    expect(result.bankBalanceSnapshots.map((row) => row.balance)).toEqual([
      123.4567, 0,
    ]);
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankTransactions).toEqual([]);
  });

  it.each([
    { code: "0000", rsData: { detailList: [] } },
    { sys: "ESB", code: "9201" },
  ])("沒有交易仍保留各幣別帳戶及目前餘額，包括零餘額", async (empty) => {
    const base = requestFixture();
    const request = async (resource: string, data: Record<string, unknown>) =>
      resource.endsWith("/011") ? empty : base(resource, data);
    const result = await fetchCtbcForeignDeposits(request, overview(), now);
    expect(result.bankTransactions).toEqual([]);
    expect(result.bankAccounts.map((row) => row.currency)).toEqual([
      "USD",
      "JPY",
    ]);
    expect(
      result.bankBalanceSnapshots.map((row) => ({
        currency: row.currency,
        balance: row.balance,
        availableBalance: row.availableBalance,
        asOfAt: row.asOfAt,
      })),
    ).toEqual([
      {
        currency: "USD",
        balance: 123.4567,
        availableBalance: 123.4567,
        asOfAt: now.toISOString(),
      },
      {
        currency: "JPY",
        balance: 0,
        availableBalance: 0,
        asOfAt: now.toISOString(),
      },
    ]);
    expect(new Set(result.bankAccounts.map((row) => row.sourceId)).size).toBe(
      2,
    );
  });

  it("歷史研究只查指定單一月份，餘額時間仍是本次查詢時間", async () => {
    const request = requestFixture();
    const result = await fetchCtbcForeignDeposits(request, overview(), now, {
      months: 1,
      firstAccountOnly: true,
      currency: "USD",
      month: "2026-08",
    });
    const queries = request.mock.calls.filter(([resource]) =>
      resource.endsWith("/011"),
    );
    expect(queries).toHaveLength(1);
    expect(queries[0][1]).toMatchObject({
      curCode: "USD",
      startDate: "20260801",
      endDate: "20260831",
    });
    expect(result.bankBalanceSnapshots[0].asOfAt).toBe(now.toISOString());
  });

  it.each(["2026-13", "2026-8", "2026-11", "invalid"])(
    "拒絕無效或未來研究月份 %s，不送查詢",
    async (month) => {
      const request = requestFixture();
      await expect(
        fetchCtbcForeignDeposits(request, {}, now, {
          months: 1,
          firstAccountOnly: true,
          currency: "USD",
          month,
        }),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("只查本機指定的單一幣別；不存在的幣別不退回第一筆", async () => {
    const request = requestFixture();
    const result = await fetchCtbcForeignDeposits(request, overview(), now, {
      months: 1,
      firstAccountOnly: true,
      currency: "jpy",
    });
    expect(result.bankAccounts.map((row) => row.currency)).toEqual(["JPY"]);
    expect(request.mock.calls.every(([, data]) => data.curCode === "JPY")).toBe(
      true,
    );
    request.mockClear();
    await expect(
      fetchCtbcForeignDeposits(request, overview(), now, {
        months: 1,
        firstAccountOnly: true,
        currency: "ZZZ",
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("研究回呼只回傳去識別結構，範圍限制為第一幣別的一個月份", async () => {
    const request = requestFixture();
    const events: Array<{ stage: string; structure: unknown }> = [];
    await fetchCtbcForeignDeposits(request, overview(), now, {
      months: 1,
      firstAccountOnly: true,
      onStructure: (stage, structure) => events.push({ stage, structure }),
    });
    expect(events.map((event) => event.stage)).toEqual([
      "overview",
      "initialization",
      "transactions",
    ]);
    expect(request.mock.calls.every(([, data]) => data.curCode === "USD")).toBe(
      true,
    );
    const serialized = JSON.stringify(events);
    for (const secret of [
      accountId,
      "123.4567",
      "0.0123",
      "synthetic-counterparty",
      "合成支出",
      "合成收入",
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain("debitAmt");
    expect(serialized).toContain("creditAmt");
  });

  it.each([false, true])(
    "正常同步包含外幣；部分失敗=%s 時不回傳成功或部分資料",
    async (fail) => {
      const twdOverview = {
        rsData: {
          twdAcctSummaryResponse: {
            demDepBalSummaryResponse: {
              infoList: [{ accountId: "000000005678", balance: "100.25" }],
            },
          },
          ...overview().rsData,
        },
      };
      const base = requestFixture();
      let bootstrap = 0;
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          const bootstrapResponses = [
            { access_token: "synthetic-token" },
            { statusCode: "0000" },
            {
              success: true,
              token: "synthetic-handshake",
              rsData: { seed: "synthetic-seed" },
            },
          ];
          if (bootstrap < 3)
            return Response.json(bootstrapResponses[bootstrap++]);
          const { resource, rqData } = JSON.parse(String(init?.body));
          if (
            resource === "/twrbm-general/ot001/010" ||
            resource === "/twrbm-general/ot002/010"
          )
            return Response.json({ code: "0000", rsData: {} });
          if (resource === "/twrbm-deposit/qu001/010")
            return Response.json({ code: "0000", ...twdOverview });
          if (resource === "/twrbm-deposit/qu002/010")
            return Response.json({ code: "0000", rsData: {} });
          if (resource === "/twrbm-deposit/qu002/011")
            return Response.json({ code: "0000", rsData: { detailList: [] } });
          if (resource === "/twrbm-card/qu002/010")
            return Response.json({
              code: "0000",
              rsData: { cardDataList: [], billData: {} },
            });
          if (
            fail &&
            resource === "/twrbm-fx/qu002/011" &&
            rqData.curCode === "JPY"
          )
            throw new Error("synthetic failure");
          return Response.json({
            code: "0000",
            ...(await base(resource, rqData)),
          });
        },
      );
      const task = createCtbcConnector(fetcher).sync({
        userId: "synthetic-id",
        account: "synthetic-user",
        password: "synthetic-password",
      });
      if (fail) {
        await expect(task).rejects.toThrow();
        return;
      }
      const result = await task;
      expect(result.bankAccounts?.map((row) => row.currency)).toEqual([
        "TWD",
        "USD",
        "JPY",
      ]);
      const legacy = parseCtbcData(
        {
          depositOverview: twdOverview,
          depositTransactions: {},
          creditCards: {},
        },
        now,
      );
      expect(
        result.bankAccounts?.find((row) => row.currency === "TWD")?.sourceId,
      ).toBe(legacy.bankAccounts[0].sourceId);
      expect(result.bankTransactions).toHaveLength(4);
    },
  );

  it("優先使用現有總覽的外幣分支，同帳號多幣別分開且不截斷小數／零餘額", async () => {
    const request = requestFixture();
    const result = await fetchCtbcForeignDeposits(request, overview(), now, {
      months: 1,
    });
    expect(
      request.mock.calls.some(
        ([resource]) => resource === "/twrbm-fx/qu001/010",
      ),
    ).toBe(false);
    expect(result.bankAccounts.map((row) => row.currency)).toEqual([
      "USD",
      "JPY",
    ]);
    expect(new Set(result.bankAccounts.map((row) => row.sourceId)).size).toBe(
      2,
    );
    expect(result.bankBalanceSnapshots.map((row) => row.balance)).toEqual([
      123.4567, 0,
    ]);
    expect(result.bankBalanceSnapshots[0].availableBalance).toBe(123.4567);
    expect(result.bankTransactions.map((row) => row.amount)).toEqual([
      -0.0123, 0.25, -1, 0.25,
    ]);
    expect(result.bankTransactions[0]).toMatchObject({
      currency: "USD",
      postedDate: "2026-10-03",
      authorizedAt: "2026-10-02",
    });
    const raw = JSON.stringify(
      result.bankAccounts
        .map((row) => row.raw)
        .concat(result.bankTransactions.map((row) => row.raw)),
    );
    expect(raw).not.toContain(accountId);
    expect(raw).not.toContain("synthetic-counterparty");
    expect(JSON.stringify(result)).not.toContain("synthetic-counterparty");
    expect(
      request.mock.calls
        .filter(([resource]) => resource === "/twrbm-fx/qu002/011")
        .map(([, data]) => data),
    ).toEqual([
      {
        accountId,
        curCode: "USD",
        startDate: "20261001",
        endDate: "20261015",
        keyWord: "",
        type: "custom",
        isFromEnterPrise: false,
      },
      {
        accountId,
        curCode: "JPY",
        startDate: "20261001",
        endDate: "20261015",
        keyWord: "",
        type: "custom",
        isFromEnterPrise: false,
      },
    ]);
  });

  it("現有總覽缺少外幣才查官方外幣總覽，重抓及月份重疊的相同交易不增加副本", async () => {
    const request = requestFixture();
    const first = await fetchCtbcForeignDeposits(request, { rsData: {} }, now);
    const second = await fetchCtbcForeignDeposits(request, { rsData: {} }, now);
    expect(request.mock.calls[0]).toEqual(["/twrbm-fx/qu001/010", {}]);
    expect(first).toEqual(second);
    expect(first.bankTransactions).toHaveLength(4);
    expect(
      new Set(first.bankTransactions.map((row) => row.sourceId)).size,
    ).toBe(4);
    expect(
      request.mock.calls
        .filter(([resource]) => resource === "/twrbm-fx/qu002/011")
        .slice(0, 3)
        .map(([, data]) => [data.startDate, data.endDate]),
    ).toEqual([
      ["20261001", "20261015"],
      ["20260901", "20260930"],
      ["20260801", "20260831"],
    ]);
  });

  it.each(["0000", "9002", "9004"])(
    "明確無外幣分支 %s 才可回傳空資料",
    async (rspCode) => {
      const request = requestFixture();
      const result = await fetchCtbcForeignDeposits(
        request,
        overview([], rspCode),
        now,
      );
      expect(result.bankAccounts).toEqual([]);
      expect(result.bankTransactions).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: "8888", rsData: { detailList: [] } },
    { code: "9201", sys: "OTHER", rsData: { detailList: [] } },
    { rsData: {} },
    overview(null),
    overview(rows, "9999"),
    overview(rows, "9002"),
    overview([{ accountId, curCode: "TWD", currentBal: "1" }]),
    overview([{ accountId, currentBal: "1" }]),
    overview([{ accountId, curCode: "USD", currentBal: "bad" }]),
    overview([rows[0], { ...rows[0], currentBal: "999" }]),
  ])("結構缺失、未知失敗或不一致不偽裝空帳戶／台幣", async (payload) => {
    await expect(
      fetchCtbcForeignDeposits(async () => payload, payload, now),
    ).rejects.toThrow("中國信託外幣存款資料格式或完整性無法確認。");
  });

  it("初始化必須精確對應帳號及幣別，不能挑第一筆或借用其他幣別餘額", async () => {
    const request = requestFixture().mockImplementation(async () => ({
      rsData: { infoList: [{ ...rows[0], curCode: "EUR" }] },
    }));
    await expect(
      fetchCtbcForeignDeposits(request, overview(), now),
    ).rejects.toThrow();
  });

  it("第二個幣別查詢失敗時整次失敗，不回傳前面已完成的部分資料", async () => {
    const base = requestFixture();
    const request = async (resource: string, data: Record<string, unknown>) => {
      if (resource === "/twrbm-fx/qu002/011" && data.curCode === "JPY")
        throw new Error("synthetic-private-bank-failure");
      return base(resource, data);
    };
    await expect(
      fetchCtbcForeignDeposits(request, overview(), now, { months: 1 }),
    ).rejects.toThrow("中國信託外幣存款查詢未完成。");
  });

  it("完整保留單次回傳所有列；不套信用卡頁數上限，也不遺失同日同額多筆", async () => {
    const base = requestFixture();
    const request = async (resource: string, data: Record<string, unknown>) =>
      resource === "/twrbm-fx/qu002/011"
        ? {
            rsData: {
              detailList: Array.from({ length: 105 }, () => ({
                trnDtRaw: "20261001",
                debitAmt: "0",
                creditAmt: "0.01",
                balAmt: "2.01",
                userMemo: "合成交易",
              })),
            },
          }
        : base(resource, data);
    const result = await fetchCtbcForeignDeposits(
      request,
      overview([rows[0]]),
      now,
      { months: 1 },
    );
    expect(result.bankTransactions).toHaveLength(105);
  });

  it.each([
    { rsData: {} },
    { code: "8888", rsData: { detailList: [] } },
    { code: "9201", sys: "OTHER", rsData: { detailList: [] } },
    {
      code: "9201",
      sys: "ESB",
      rsData: {
        detailList: [{ trnDtRaw: "20261001", debitAmt: "0", creditAmt: "1" }],
      },
    },
    {
      rsData: {
        detailList: [{ trnDtRaw: "invalid", debitAmt: "0", creditAmt: "1" }],
      },
    },
    {
      rsData: {
        detailList: [{ trnDtRaw: "20261001", debitAmt: "bad", creditAmt: "1" }],
      },
    },
    {
      rsData: {
        detailList: [{ trnDtRaw: "20261001", debitAmt: "1", creditAmt: "1" }],
      },
    },
  ])("未知／不完整交易不靜默略過", async (response) => {
    const base = requestFixture();
    const request = async (resource: string, data: Record<string, unknown>) =>
      resource === "/twrbm-fx/qu002/011" ? response : base(resource, data);
    await expect(
      fetchCtbcForeignDeposits(request, overview([rows[0]]), now, {
        months: 1,
      }),
    ).rejects.toThrow();
  });

  it("只有官方明定的明細 ESB9201 視為無交易，保留帳戶與零餘額", async () => {
    const base = requestFixture();
    const result = await fetchCtbcForeignDeposits(
      async (resource, data) =>
        resource === "/twrbm-fx/qu002/011"
          ? { sys: "ESB", code: "9201" }
          : base(resource, data),
      overview(),
      now,
      { months: 1 },
    );
    expect(result.bankAccounts).toHaveLength(2);
    expect(result.bankTransactions).toEqual([]);
  });

  it("備註異動不改交易識別，銀行借方負號也不變成收入", async () => {
    const base = requestFixture();
    let memo = "原始合成備註";
    const request = async (resource: string, data: Record<string, unknown>) =>
      resource === "/twrbm-fx/qu002/011"
        ? {
            rsData: {
              detailList: [
                {
                  trnDtRaw: "20261001",
                  debitAmt: "-0.01",
                  creditAmt: "0",
                  balAmt: "10",
                  userMemo: memo,
                },
              ],
            },
          }
        : base(resource, data);
    const first = await fetchCtbcForeignDeposits(
      request,
      overview([rows[0]]),
      now,
      { months: 1 },
    );
    memo = "修改合成備註";
    const second = await fetchCtbcForeignDeposits(
      request,
      overview([rows[0]]),
      now,
      { months: 1 },
    );
    expect(first.bankTransactions[0].sourceId).toBe(
      second.bankTransactions[0].sourceId,
    );
    expect(second.bankTransactions[0]).toMatchObject({
      amount: -0.01,
      description: memo,
    });
  });
});
