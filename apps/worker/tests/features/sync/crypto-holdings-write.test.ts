import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { persistCryptoHoldings } from "../../../src/features/sync/crypto-holdings-write";
import { NeedsUserActionError } from "../../../src/features/sync/errors";
import {
  sensitiveConnectorConfig,
  serializePublicConnectorConfig,
} from "../../../src/features/sync/connector-state";
import { listLatestInvestmentPositions } from "../../../src/features/investments/repository";
import { listNetWorthChartHistory } from "../../../src/features/net-worth/repository";
import { calculateCurrentFinancialSnapshot } from "../../../src/features/sync/reports/repository";
import {
  buildCryptoHoldings,
  type CryptoWalletBalance,
} from "../../../src/sources/crypto-holdings";

const YESTERDAY = "2026-10-22";
const TODAY = "2026-10-23";
const PRICES: Record<string, number> = { BTC: 2_000_000, ETH: 80_000 };

function holdings(date: string, balances: CryptoWalletBalance[]) {
  return buildCryptoHoldings({
    exchangeName: "Binance",
    asOfDate: date,
    balances,
    priceTwd: (asset) => PRICES[asset],
  });
}

describe("加密貨幣持倉同日快照（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM investment_positions"),
      db.prepare("DELETE FROM net_worth_history"),
      db.prepare("DELETE FROM sync_write_staging"),
      db.prepare("DELETE FROM connector_settings"),
      db.prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, created_at, updated_at) VALUES ('binance', 'binance', 'config', 't', 't')",
      ),
    ]);
  });

  function write(date: string, balances: CryptoWalletBalance[]) {
    return persistCryptoHoldings(db, {
      connectorId: "binance",
      title: "Binance",
      encryptedConfig: "config",
      settingsUpdatedAt: "t",
      holdings: holdings(date, balances),
      now: `${date}T02:00:00.000Z`,
    });
  }

  async function latest() {
    return (await listLatestInvestmentPositions(db, 50)).map(
      ({ symbol, name, quantity, marketValue, asOfDate }) => ({
        symbol,
        name,
        quantity,
        marketValue,
        asOfDate,
      }),
    );
  }

  it("同一天再次同步時移除已賣出的幣，前一天的快照保留", async () => {
    await write(YESTERDAY, [{ asset: "ETH", wallet: "spot", quantity: 1 }]);
    await write(TODAY, [
      { asset: "BTC", wallet: "spot", quantity: 0.1 },
      { asset: "ETH", wallet: "spot", quantity: 0.5 },
    ]);
    await write(TODAY, [{ asset: "BTC", wallet: "spot", quantity: 0.15 }]);

    // 0.15 × 2,000,000 = 300,000；早上的 ETH 不得殘留
    expect(await latest()).toEqual([
      {
        symbol: "BTC",
        name: "Binance",
        quantity: 0.15,
        marketValue: 300_000,
        asOfDate: TODAY,
      },
    ]);
    const counts = await db
      .prepare(
        "SELECT as_of_date AS date, COUNT(*) AS count FROM investment_positions GROUP BY as_of_date ORDER BY as_of_date",
      )
      .all<{ date: string; count: number }>();
    expect(counts.results).toEqual([
      { date: YESTERDAY, count: 1 },
      { date: TODAY, count: 1 },
    ]);
    expect(await calculateCurrentFinancialSnapshot(db)).toMatchObject({
      assetsTwd: 300_000,
      missingCurrencies: [],
    });
    expect(
      (await listNetWorthChartHistory(db)).map(
        ({ date, netWorth, assetType, source }) => ({
          date,
          netWorth,
          assetType,
          source,
        }),
      ),
    ).toEqual([
      {
        date: YESTERDAY,
        netWorth: 80_000,
        assetType: "crypto",
        source: "binance",
      },
      {
        date: TODAY,
        netWorth: 300_000,
        assetType: "crypto",
        source: "binance",
      },
    ]);
  });

  it("全部提領時最新持倉只剩零值列，不退回前一天", async () => {
    await write(YESTERDAY, [{ asset: "BTC", wallet: "spot", quantity: 0.1 }]);
    await write(TODAY, []);

    expect(await latest()).toEqual([
      {
        symbol: null,
        name: "Binance（無持倉）",
        quantity: 0,
        marketValue: 0,
        asOfDate: TODAY,
      },
    ]);
    expect((await calculateCurrentFinancialSnapshot(db)).assetsTwd).toBe(0);
  });

  it("同步期間設定變更時整批回滾，不刪除當天既有持倉", async () => {
    await write(TODAY, [{ asset: "BTC", wallet: "spot", quantity: 0.1 }]);
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'new-config', updated_at = 't2' WHERE connector_id = 'binance'",
      )
      .run();

    await expect(write(TODAY, [])).rejects.toBeInstanceOf(NeedsUserActionError);
    expect(await latest()).toMatchObject([{ symbol: "BTC", quantity: 0.1 }]);
    const staging = await db
      .prepare("SELECT COUNT(*) AS count FROM sync_write_staging")
      .first<{ count: number }>();
    expect(staging?.count).toBe(0);
  });

  it("investment_positions 接受 crypto，仍拒絕未知類型", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO investment_positions (id, connector_id, source_id, asset_type, name, as_of_date, created_at, updated_at) VALUES ('x', 'binance', 'X', 'bogus', 'X', ?, 't', 't')",
        )
        .bind(TODAY)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("API Key 與 Secret 只進加密設定，不進 public_config", () => {
    for (const [connectorId, config] of [
      ["binance", { apiKey: "key-value", apiSecret: "secret-value" }],
      ["max", { accessKey: "key-value", secretKey: "secret-value" }],
    ] as const) {
      expect(
        serializePublicConnectorConfig(connectorId, config) ?? "",
      ).not.toMatch(/key-value|secret-value/);
      expect(sensitiveConnectorConfig(connectorId, config)).toEqual(config);
    }
  });
});
