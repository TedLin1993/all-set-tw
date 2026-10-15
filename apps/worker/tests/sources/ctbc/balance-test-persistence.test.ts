import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import { syncCtbc } from "../../../src/sources/ctbc/sync";
import type { Env } from "../../../src/platform/env";
import { bankRoutes } from "../../../src/features/bank/route";

let harness: Awaited<ReturnType<typeof createTestD1>>;
beforeAll(async () => {
  harness = await createTestD1();
}, 60_000);
afterAll(async () => {
  await harness?.mf.dispose();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("測試站餘額同步至隔離合成 D1", () => {
  it("全幣別含零餘額可寫入及重抓，無交易查詢或寫入；部分失敗不提交金融資料", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = "synthetic-test-key";
    const env = {
      DB: harness.binding,
      CONFIG_ENCRYPTION_KEY: key,
      CTBC_FOREIGN_BALANCE_TEST: "1",
    } as Env;
    await env.DB.prepare(
      "INSERT INTO connector_settings (id, connector_id, encrypted_config, public_config, created_at, updated_at) VALUES ('settings:ctbc', 'ctbc', ?, '{}', ?, ?)",
    )
      .bind(
        await encryptJson(
          {
            userId: "synthetic-id",
            account: "synthetic-user",
            password: "synthetic-password",
          },
          key,
        ),
        "2026-10-15T00:00:00Z",
        "2026-10-15T00:00:00Z",
      )
      .run();
    const rows = [
      {
        accountId: "000000001234",
        curCode: "USD",
        currentBal: "45.6789",
        avialBal: "45.6789",
      },
      {
        accountId: "000000001234",
        curCode: "JPY",
        currentBal: "0",
        avialBal: "0",
      },
    ];
    let fail = false;
    const resources: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(String(init?.body));
        } catch {
          /* OAuth uses form encoding. */
        }
        if (body.resource) {
          resources.push(body.resource);
          if (body.resource === "/twrbm-general/ot001/010")
            return Response.json({ code: "0000", rsData: {} });
          if (body.resource === "/twrbm-general/ot002/010")
            return Response.json({ code: "0000" });
          if (body.resource === "/twrbm-deposit/qu001/010")
            return Response.json({
              code: "0000",
              rsData: {
                fxAcctSummaryResponse: {
                  demDepBalSummaryResponse: { rspCode: "0000", infoList: rows },
                },
              },
            });
          if (body.resource === "/twrbm-fx/qu002/010")
            return Response.json(
              fail && body.rqData.curCode === "JPY"
                ? { code: "9999" }
                : { code: "0000", rsData: { infoList: rows } },
            );
          if (body.resource === "/twrbm-card/qu002/010")
            return Response.json({
              code: "0000",
              rsData: {
                billCycle: "30",
                cardDataList: [
                  { cardNoSuffixFour: "1234", cardName: "合成卡" },
                ],
                billData: {
                  TWD: {
                    "2026/09": {
                      summary: {
                        billDt: "093026",
                        billAmt: "19.25",
                        pmtAmt: "0",
                      },
                      bills: [],
                    },
                  },
                },
              },
            });
          if (body.resource === "/twrbm-card/qu002/011")
            return Response.json({
              code: "0000",
              rsData: {
                bills: [
                  {
                    purchaseDt: "092626",
                    postingDt: "092726",
                    ntAmt: "19.25",
                    description: "合成帳單消費",
                    cardNoSuffixFour: "1234",
                  },
                ],
              },
            });
          if (body.resource === "/twrbm-card/qu006/010")
            return Response.json({
              code: "0000",
              rsData: { curOptions: [{ curCode: "TWD" }] },
            });
          if (body.resource === "/twrbm-card/qu006/011")
            return Response.json({
              code: "0000",
              rsData: {
                allItems: [
                  {
                    purchaseDt: "100126",
                    postingDt: "100226",
                    purchaseAmt: "2",
                    description: "合成未出帳",
                    cardNoSuffixFour: "1234",
                  },
                ],
              },
            });
          if (body.resource === "/twrbm-card/qu041/010")
            return Response.json({
              code: "0000",
              rsData: {
                allItems: [
                  {
                    txnDate: "20261015",
                    txnAmt: "3",
                    merchName: "合成授權",
                    cardNoSuffixFour: "1234",
                  },
                ],
                noMore: true,
              },
            });
          throw new Error("Unexpected synthetic bank resource");
        }
        return Response.json({
          access_token: "synthetic-oauth",
          statusCode: "0000",
          success: true,
          token: "synthetic-handshake",
          rsData: { seed: "synthetic-seed" },
        });
      }),
    );
    await syncCtbc(env, "manual");
    await syncCtbc(env, "manual");
    const accounts = await env.DB.prepare(
      "SELECT currency FROM bank_accounts WHERE connector_id = 'ctbc' ORDER BY currency",
    ).all();
    expect(accounts.results).toEqual([
      { currency: "JPY" },
      { currency: "USD" },
    ]);
    const balances = await env.DB.prepare(
      "SELECT currency, balance FROM bank_balance_snapshots ORDER BY currency",
    ).all<{ currency: string; balance: number }>();
    expect(balances.results.length).toBeGreaterThanOrEqual(2);
    expect(
      balances.results.every(
        (row) => row.balance === (row.currency === "USD" ? 45.6789 : 0),
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_transactions").first(
        "n",
      ),
    ).toBe(0);
    const beforeCursor = await env.DB.prepare(
      "SELECT sync_cursor FROM connector_settings WHERE connector_id='ctbc'",
    ).first("sync_cursor");
    fail = true;
    await expect(syncCtbc(env, "manual")).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM bank_balance_snapshots",
      ).first("n"),
    ).toBe(balances.results.length);
    expect(
      await env.DB.prepare(
        "SELECT sync_cursor FROM connector_settings WHERE connector_id='ctbc'",
      ).first("sync_cursor"),
    ).toBe(beforeCursor);
    expect(
      resources
        .filter((resource) => resource.startsWith("/twrbm-fx/"))
        .every((resource) => resource === "/twrbm-fx/qu002/010"),
    ).toBe(true);
    expect(
      resources
        .filter((resource) => resource.startsWith("/twrbm-deposit/"))
        .every((resource) => resource === "/twrbm-deposit/qu001/010"),
    ).toBe(true);
    expect(resources.some((resource) => resource.includes("creditcard"))).toBe(
      false,
    );
    fail = false;
    env.CTBC_CREDIT_CARD_TEST = "1";
    await syncCtbc(env, "manual");
    await syncCtbc(env, "manual");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_transactions").first(
        "n",
      ),
    ).toBe(3);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM credit_card_bills").first(
        "n",
      ),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_accounts").first(
        "n",
      ),
    ).toBe(3);
    expect(
      (
        await env.DB.prepare(
          "SELECT status, amount FROM bank_transactions ORDER BY amount",
        ).all()
      ).results,
    ).toEqual([
      { status: "posted", amount: -19.25 },
      { status: "pending", amount: -3 },
      { status: "posted", amount: -2 },
    ]);
    expect(
      resources
        .filter((resource) => resource.startsWith("/twrbm-fx/"))
        .every((resource) => resource === "/twrbm-fx/qu002/010"),
    ).toBe(true);
    expect(
      resources
        .filter((resource) => resource.startsWith("/twrbm-deposit/"))
        .every((resource) => resource === "/twrbm-deposit/qu001/010"),
    ).toBe(true);
    const response = await bankRoutes.request(
      "/bank?from=2026-09&to=2026-10",
      {},
      env,
    );
    expect(response.status).toBe(200);
    const presented = (await response.json()) as {
      transactions: Array<{
        status: string;
        amount: number;
        accountType: string;
      }>;
    };
    expect(presented.transactions).toHaveLength(3);
    expect(
      presented.transactions.every((row) => row.accountType === "credit"),
    ).toBe(true);
    expect(
      presented.transactions.map((row) => row.amount).sort((a, b) => a - b),
    ).toEqual([-19.25, -3, -2]);
  });
});
