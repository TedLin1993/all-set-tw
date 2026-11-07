import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../../helpers/d1";
import { listLatestInvestmentPositions } from "../../../src/features/investments/repository";
import { calculateCurrentFinancialSnapshot } from "../../../src/features/sync/reports/repository";
import { loadDashboardSummary } from "../../../src/features/dashboard/repository";
import { investmentPositionRecord } from "../../../src/features/sync/record-mapper";
import {
  createTdccConnector,
  type TdccConfig,
} from "../../../src/sources/tdcc/protocol";
import {
  persistStagedSyncWrite,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";

const NOW = "2026-10-23T02:00:00.000Z";

type PositionInput = {
  connectorId: "sinotrade" | "tdcc";
  sourceId: string;
  date: string;
  symbol?: string;
  name?: string;
  assetType?: "stock" | "etf" | "fund" | "crypto";
  brokerNo?: string;
  brokerAccount?: string;
  market?: string;
  quantity?: number;
  marketValue?: number;
  cashBalance?: number;
  costBasis?: number;
  unrealizedPnl?: number;
  raw?: unknown;
};

function positionRecord(input: PositionInput): SyncWriteRecord {
  return investmentPositionRecord(
    input.connectorId,
    {
      sourceId: input.sourceId,
      assetType: input.assetType ?? "stock",
      symbol: input.symbol,
      name: input.name ?? input.symbol ?? "空快照",
      brokerNo: input.brokerNo,
      brokerAccount: input.brokerAccount,
      market: input.market,
      quantity: input.quantity,
      marketValue: input.marketValue,
      cashBalance: input.cashBalance,
      costBasis: input.costBasis,
      unrealizedPnl: input.unrealizedPnl,
      currency: input.market === "US" ? "USD" : "TWD",
      asOfDate: input.date,
      raw: input.raw ?? { fixture: true },
    },
    NOW,
  );
}

async function write(db: D1Database, ...inputs: PositionInput[]) {
  await persistStagedSyncWrite(db, {
    records: inputs.map(positionRecord),
  });
}

describe("投資持倉欄位與跨來源 scope 去重（隔離 D1）", () => {
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
      db.prepare("DELETE FROM sync_write_staging"),
    ]);
  });

  it("保留小數股數、原幣市值、成本與來源損益，缺欄位查詢為 null", async () => {
    await write(db, {
      connectorId: "sinotrade",
      sourceId: "fixture:fractional",
      date: "2026-10-23",
      symbol: "FICT",
      brokerNo: "807",
      brokerAccount: "A001",
      market: "US",
      quantity: 0.375,
      marketValue: 123.45,
      cashBalance: 0.125,
      costBasis: 100.125,
      unrealizedPnl: -2.5,
    });
    await write(db, {
      connectorId: "tdcc",
      sourceId: "fixture:legacy",
      date: "2026-10-23",
      symbol: "TW01",
      marketValue: 10,
    });

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows).toEqual([
      expect.objectContaining({
        sourceId: "fixture:fractional",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "US",
        quantity: 0.375,
        marketValue: 123.45,
        cashBalance: 0.125,
        costBasis: 100.125,
        unrealizedPnl: -2.5,
      }),
      expect.objectContaining({
        sourceId: "fixture:legacy",
        brokerNo: null,
        brokerAccount: null,
        market: null,
        costBasis: null,
        unrealizedPnl: null,
      }),
    ]);
    expect(
      await db
        .prepare(
          "SELECT typeof(market_value) AS market_value_type, typeof(cash_balance) AS cash_balance_type FROM investment_positions WHERE source_id = ?",
        )
        .bind("fixture:fractional")
        .first(),
    ).toEqual({ market_value_type: "real", cash_balance_type: "real" });
    await db
      .prepare(
        "INSERT INTO exchange_rates (currency,rate_to_twd,updated_at) VALUES ('USD',32,'t') ON CONFLICT(currency) DO UPDATE SET rate_to_twd=32",
      )
      .run();
    const dashboard = await loadDashboardSummary(db);
    expect(dashboard.investmentRow?.count).toBe(2);
    expect(dashboard.investmentRow?.total).toBeCloseTo(
      (123.45 + 0.125) * 32 + 10,
    );
  });

  it("TDCC 台幣股票帶出帳戶與 TW，小數市值保留且不猜外幣基金市場", async () => {
    const config = {
      holdings: [
        {
          accountId: "807:1234567",
          brokerNo: "807",
          brokerAccount: "1234567",
          securityName: "合成台股",
          symbol: "TW01",
          securityType: "stock",
          quantity: "0.5",
          marketValue: "12.34",
          currency: "TWD",
          asOfDate: "2026-10-21",
        },
        {
          accountId: "807:1234567",
          brokerNo: "807",
          brokerAccount: "1234567",
          securityName: "合成基金",
          symbol: "FUND01",
          securityType: "fund",
          quantity: "1.25",
          marketValue: "8.75",
          currency: "USD",
          asOfDate: "2026-10-21",
        },
      ],
      cashBalances: [],
      cashMovements: [],
      requestOtp: true,
      tradeHistoryMaxPages: 20,
    } satisfies TdccConfig;
    const result = await createTdccConnector().sync(config);

    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "TW01",
          brokerNo: "807",
          brokerAccount: "1234567",
          market: "TW",
          marketValue: 12.34,
        }),
        expect.objectContaining({
          symbol: "FUND01",
          brokerNo: "807",
          brokerAccount: "1234567",
          market: undefined,
          marketValue: 8.75,
        }),
      ]),
    );
  });

  it("同一帳戶市場同日由 sinotrade 優先，且空 marker 不回退 TDCC 舊持倉", async () => {
    await write(
      db,
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-old",
        date: "2026-10-20T00:00:00.000Z",
        symbol: "OLD",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 100,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:sinotrade-direct",
        date: "2026-10-20",
        symbol: "DIRECT",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 200,
      },
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-sold",
        date: "2026-10-21T00:00:00.000Z",
        symbol: "SOLD",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 300,
      },
      {
        connectorId: "sinotrade",
        sourceId: "empty:TW:807:A001",
        date: "2026-10-21",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        quantity: 0,
        marketValue: 0,
        raw: { snapshotMarker: true },
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      connectorId: "sinotrade",
      sourceId: "empty:TW:807:A001",
      symbol: null,
      quantity: 0,
      marketValue: 0,
      brokerNo: "807",
      brokerAccount: "A001",
      market: "TW",
    });
    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toMatchObject({
      assetsTwd: 0,
      missingCurrencies: [],
    });
    expect((await loadDashboardSummary(db)).investmentRow?.count).toBe(0);
  });

  it("以台灣曆日比較跨來源時間，且同來源只保留精確最新 timestamp", async () => {
    await write(
      db,
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-taiwan-midnight",
        date: "2026-10-20T16:00:00.000Z",
        symbol: "TDCC_OLD",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 100,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:sinotrade-earlier",
        date: "2026-10-21T00:00:00.000Z",
        symbol: "DIRECT_EARLIER",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 200,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:sinotrade-latest",
        date: "2026-10-21T01:00:00.000Z",
        symbol: "DIRECT_LATEST",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 300,
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows.map(({ symbol }) => symbol)).toEqual(["DIRECT_LATEST"]);
  });

  it("日期較新優先，且不同帳戶、不同市場不互相抹除", async () => {
    await write(
      db,
      {
        connectorId: "sinotrade",
        sourceId: "fixture:direct-old",
        date: "2026-10-20",
        symbol: "OLD",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 100,
      },
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-new",
        date: "2026-10-21",
        symbol: "NEW",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 110,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:other-account",
        date: "2026-10-20",
        symbol: "OTHER",
        brokerNo: "807",
        brokerAccount: "A002",
        market: "TW",
        marketValue: 120,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:us",
        date: "2026-10-20",
        symbol: "US01",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "US",
        marketValue: 130,
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows.map(({ symbol }) => symbol)).toEqual(["NEW", "OTHER", "US01"]);
    expect(rows.find(({ symbol }) => symbol === "OLD")).toBeUndefined();
  });

  it("同一集保帳戶的股票與 ETF 最新日期不同時，兩種資產類型都保留", async () => {
    await write(
      db,
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-stock",
        date: "2026-10-20",
        symbol: "STK1",
        assetType: "stock",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 100,
      },
      {
        connectorId: "tdcc",
        sourceId: "fixture:tdcc-etf",
        date: "2026-10-21",
        symbol: "ETF1",
        assetType: "etf",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        marketValue: 110,
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows.map(({ symbol }) => symbol)).toEqual(
      expect.arrayContaining(["ETF1", "STK1"]),
    );
    expect(rows).toHaveLength(2);
  });

  it("先取 sinotrade 每種資產類型的最新完整 snapshot，再做帳戶 scope 去重", async () => {
    await write(
      db,
      {
        connectorId: "sinotrade",
        sourceId: "fixture:stale-account",
        date: "2026-10-20",
        symbol: "STALE",
        brokerNo: "807",
        brokerAccount: "A002",
        market: "TW",
        marketValue: 200,
      },
      {
        connectorId: "sinotrade",
        sourceId: "empty:TW:807:A001",
        date: "2026-10-21",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "TW",
        quantity: 0,
        marketValue: 0,
        raw: { snapshotMarker: true },
      },
      {
        connectorId: "sinotrade",
        sourceId: "empty:US:807:A001",
        date: "2026-10-21",
        assetType: "etf",
        brokerNo: "807",
        brokerAccount: "A001",
        market: "US",
        quantity: 0,
        marketValue: 0,
        raw: { snapshotMarker: true },
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(rows.map(({ sourceId }) => sourceId)).toEqual([
      "empty:US:807:A001",
      "empty:TW:807:A001",
    ]);
    expect(rows.find(({ symbol }) => symbol === "STALE")).toBeUndefined();
  });

  it("未識別帳戶只在各 connector 內隔離，不跨來源猜測合併", async () => {
    await write(
      db,
      {
        connectorId: "tdcc",
        sourceId: "fixture:unknown-tdcc",
        date: "2026-10-20",
        symbol: "UNKNOWN_TW",
        marketValue: 10,
      },
      {
        connectorId: "sinotrade",
        sourceId: "fixture:unknown-sinotrade",
        date: "2026-10-20",
        symbol: "UNKNOWN_DIRECT",
        marketValue: 20,
      },
    );

    const rows = await listLatestInvestmentPositions(db, 20);
    expect(
      rows.map(({ connectorId, symbol }) => ({ connectorId, symbol })),
    ).toEqual([
      { connectorId: "sinotrade", symbol: "UNKNOWN_DIRECT" },
      { connectorId: "tdcc", symbol: "UNKNOWN_TW" },
    ]);
  });

  it("migration 只回填格式明確的既有 TDCC 帳戶，不猜測未知 sourceId", async () => {
    const migrationDirectory = fileURLToPath(
      new URL("../../../migrations/", import.meta.url),
    );
    const migrationNames = readdirSync(migrationDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
    const migrations = readMigrations();
    const migrationIndex = migrationNames.indexOf(
      "0072_investment_position_identity_and_pnl.sql",
    );
    expect(migrationIndex).toBeGreaterThan(0);
    const legacyHarness = await createTestD1(
      undefined,
      migrations.slice(0, migrationIndex),
    );
    try {
      const legacyDb = legacyHarness.binding;
      await legacyDb.batch([
        legacyDb.prepare(
          "INSERT INTO investment_positions (id, connector_id, source_id, asset_type, symbol, name, currency, as_of_date, created_at, updated_at) VALUES ('legacy-alphanumeric', 'tdcc', 'Z999:0000001:TEST:2026-10-20', 'stock', 'TEST', '合成標的', 'TWD', '2026-10-20', 't', 't')",
        ),
        legacyDb
          .prepare(
            "INSERT INTO investment_positions (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, created_at, updated_at) VALUES (?, 'tdcc', ?, 'stock', 'TW01', '合成標的', 1, 12, 0, 'TWD', ?, 't', 't')",
          )
          .bind(
            "legacy-safe",
            "807:1234567:TW01:2026-10-20T00:00:00.000Z",
            "2026-10-20T00:00:00.000Z",
          ),
        legacyDb
          .prepare(
            "INSERT INTO investment_positions (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, created_at, updated_at) VALUES (?, 'tdcc', ?, 'stock', 'TW02', '未知標的', 1, 13, 0, 'TWD', ?, 't', 't')",
          )
          .bind(
            "legacy-unsafe",
            "807:UNKNOWN:TW02:2026-10-20T00:00:00.000Z",
            "2026-10-20T00:00:00.000Z",
          ),
      ]);

      const migration = migrations[migrationIndex];
      expect(migration).toBeDefined();
      await legacyDb.batch(
        unstable_splitSqlQuery(migration!)
          .map((statement) => statement.trim())
          .filter(Boolean)
          .map((statement) => legacyDb.prepare(statement)),
      );

      expect(
        await legacyDb
          .prepare(
            "SELECT broker_no, broker_account, market FROM investment_positions WHERE id = ?",
          )
          .bind("legacy-safe")
          .first(),
      ).toEqual({ broker_no: "807", broker_account: "1234567", market: "TW" });
      expect(
        await legacyDb
          .prepare(
            "SELECT broker_no, broker_account, market FROM investment_positions WHERE id = 'legacy-alphanumeric'",
          )
          .first(),
      ).toEqual({ broker_no: "Z999", broker_account: "0000001", market: "TW" });
      expect(
        await legacyDb
          .prepare(
            "SELECT broker_no, broker_account, market FROM investment_positions WHERE id = ?",
          )
          .bind("legacy-unsafe")
          .first(),
      ).toEqual({ broker_no: null, broker_account: null, market: null });
    } finally {
      await legacyHarness.mf.dispose();
    }
  });
});
