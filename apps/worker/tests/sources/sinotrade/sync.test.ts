import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import { getConnectorSettings } from "../../../src/db";
import type { Env } from "../../../src/platform/env";
import { syncSinotrade } from "../../../src/sources/sinotrade/sync";

const mocked = vi.hoisted(() => ({ fetchSnapshot: vi.fn() }));
vi.mock("../../../src/sources/sinotrade/connector", () => ({
  fetchSinotradeSnapshot: mocked.fetchSnapshot,
}));
const key = "synthetic-securities-test-key";
const credentials = { userId: "A000000000", password: "fixture-password" };
const account = {
  brokerNo: "9999",
  brokerAccount: "0000001",
  market: "US" as const,
};
const holding = {
  symbol: "TEST",
  name: "虛構公司",
  quantity: 1.234567,
  marketValue: 11.111103,
  costBasis: 12.499990875,
  unrealizedPnl: -1.388887875,
  currency: "USD",
  market: "US" as const,
};

describe("證券完整持倉同步（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let env: Env;
  beforeAll(async () => {
    harness = await createTestD1();
    env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO connector_settings (id,connector_id,encrypted_config,created_at,updated_at) VALUES ('fixture','sinotrade',?,?,?)",
    )
      .bind(await encryptJson(credentials, key), now, now)
      .run();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("保留碎股與原幣損益；查詢失敗不清空，成功空快照才移除當日已賣出庫存", async () => {
    mocked.fetchSnapshot.mockResolvedValue({
      accountHoldings: [{ account, holdings: [holding], trades: [] }],
      webState: {},
    });
    await syncSinotrade(env, "manual");
    expect(
      await decryptJson(
        (await getConnectorSettings(env.DB, "sinotrade"))!.encrypted_config,
        key,
      ),
    ).toMatchObject(credentials);
    const row = await env.DB.prepare(
      "SELECT quantity,market_value,cost_basis,unrealized_pnl,raw_payload FROM investment_positions WHERE connector_id='sinotrade' AND symbol='TEST'",
    ).first();
    expect(row).toMatchObject({
      quantity: holding.quantity,
      market_value: holding.marketValue,
      cost_basis: holding.costBasis,
      unrealized_pnl: holding.unrealizedPnl,
    });
    expect(row!.raw_payload).not.toContain(account.brokerAccount);
    mocked.fetchSnapshot.mockRejectedValueOnce(new Error("來源查詢失敗"));
    await expect(syncSinotrade(env, "manual")).rejects.toThrow("來源查詢失敗");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_positions WHERE connector_id='sinotrade' AND symbol='TEST'",
      ).first("count"),
    ).toBe(1);
    mocked.fetchSnapshot.mockResolvedValue({
      accountHoldings: [{ account, holdings: [], trades: [] }],
      webState: {},
    });
    await syncSinotrade(env, "manual");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_positions WHERE connector_id='sinotrade' AND symbol='TEST'",
      ).first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_positions WHERE connector_id='sinotrade' AND source_id LIKE 'empty:%'",
      ).first("count"),
    ).toBe(2);
  });

  it("查詢期間設定改變時拒絕 promotion，保留上次成功資料", async () => {
    mocked.fetchSnapshot.mockImplementationOnce(async () => {
      await env.DB.prepare(
        "UPDATE connector_settings SET encrypted_config = ?, updated_at = ? WHERE connector_id='sinotrade'",
      )
        .bind(await encryptJson({}, key), "2027-01-01T00:00:00.000Z")
        .run();
      return {
        accountHoldings: [{ account, holdings: [holding], trades: [] }],
        webState: {},
      };
    });
    await expect(syncSinotrade(env, "manual")).rejects.toThrow("設定已變更");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_positions WHERE connector_id='sinotrade' AND symbol='TEST'",
      ).first("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_positions WHERE connector_id='sinotrade' AND source_id LIKE 'empty:%'",
      ).first("count"),
    ).toBe(2);
  });

  it("保存買賣交易紀錄：金額帶正負號、重複同步不重複寫入，費稅放在明細而不洩漏帳號", async () => {
    const usBuy = {
      key: "2026-01-02:B:TEST:1.2346:10",
      symbol: "TEST",
      name: "虛構公司",
      tradeDate: "2026-01-02",
      side: "B" as const,
      quantity: 1.2346,
      price: 10,
      amount: -13.35,
      currency: "USD" as const,
      market: "US" as const,
      fee: 1,
      inventoryType: "定額外幣",
    };
    const twAccount = {
      brokerNo: "9999",
      brokerAccount: "0000002",
      market: "TW" as const,
    };
    const twSell = {
      key: "2026-01-10:A0002:S:0050:5:120",
      symbol: "0050",
      name: "虛構 ETF",
      tradeDate: "2026-01-10",
      side: "S" as const,
      quantity: 5,
      price: 120,
      amount: 597,
      currency: "TWD" as const,
      market: "TW" as const,
      fee: 1,
      tax: 2,
      orderNo: "A0002",
      realizedPnl: 97,
      realizedCost: 500,
    };
    mocked.fetchSnapshot.mockResolvedValue({
      accountHoldings: [
        { account, holdings: [], trades: [usBuy] },
        { account: twAccount, holdings: [], trades: [twSell] },
      ],
      webState: {},
    });
    const first = await syncSinotrade(env, "manual");
    expect(first).toMatchObject({
      records: 2,
      newRecords: { investmentTransactions: 2 },
    });
    const rows = (
      await env.DB.prepare(
        "SELECT account_id,broker_account,broker_name,symbol,asset_type,trade_date,transaction_code,transaction_name,quantity,price,amount,realized_pnl,currency,raw_payload FROM investment_transactions WHERE connector_id='sinotrade' ORDER BY trade_date",
      ).all<Record<string, unknown>>()
    ).results;
    expect(rows).toMatchObject([
      {
        account_id: "sinotrade:US:9999:0000001",
        broker_name: "永豐金證券",
        symbol: "TEST",
        asset_type: "stock",
        trade_date: "2026-01-02",
        transaction_code: "B",
        transaction_name: "買進",
        quantity: 1.2346,
        price: 10,
        amount: -13.35,
        realized_pnl: null,
        currency: "USD",
      },
      {
        account_id: "sinotrade:TW:9999:0000002",
        symbol: "0050",
        asset_type: "etf",
        transaction_code: "S",
        transaction_name: "賣出",
        amount: 597,
        realized_pnl: 97,
        currency: "TWD",
      },
    ]);
    expect(JSON.parse(String(rows[1]!.raw_payload))).toEqual({
      market: "TW",
      fee: 1,
      tax: 2,
      orderNo: "A0002",
      realizedCost: 500,
    });
    expect(rows.map((row) => row.raw_payload).join()).not.toContain(
      twAccount.brokerAccount,
    );
    // 同一份紀錄再同步一次：不新增、不重複。
    const second = await syncSinotrade(env, "manual");
    expect(second).toMatchObject({ newRecords: { investmentTransactions: 0 } });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM investment_transactions WHERE connector_id='sinotrade'",
      ).first("count"),
    ).toBe(2);
    // 官方之後不再提供損益時，舊值不保留。
    mocked.fetchSnapshot.mockResolvedValue({
      accountHoldings: [
        { account, holdings: [], trades: [usBuy] },
        {
          account: twAccount,
          holdings: [],
          trades: [{ ...twSell, realizedPnl: undefined, realizedCost: 0 }],
        },
      ],
      webState: {},
    });
    await syncSinotrade(env, "manual");
    expect(
      await env.DB.prepare(
        "SELECT realized_pnl FROM investment_transactions WHERE connector_id='sinotrade' AND transaction_code='S'",
      ).first("realized_pnl"),
    ).toBeNull();
  });
});
