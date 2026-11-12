import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  createDrizzle,
  investmentPositions,
  netWorthHistory,
} from "../../../src/db";
import { getNetWorthChartHistory } from "../../../src/features/net-worth/service";

const now = "2026-11-12T00:00:00.000Z";

function point(source: string, assetType: string, date: string, value: number) {
  return {
    id: `${source}:${assetType}:${date}`,
    date,
    netWorth: value,
    assetType,
    source,
    snapshottedAt: now,
  };
}

describe("資產走勢的台股合併（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare("DELETE FROM net_worth_history"),
      harness.binding.prepare("DELETE FROM investment_positions"),
    ]);
  });

  async function stockRows() {
    return (await getNetWorthChartHistory(harness.binding))
      .filter((row) => row.assetType === "stock")
      .map(({ date, netWorth, source }) => ({ date, netWorth, source }));
  }

  it("集保有資料的日期不重複加券商台股，集保之後才接券商；美股另外相加", async () => {
    await createDrizzle(harness.binding)
      .insert(netWorthHistory)
      .values([
        point("tdcc", "stock", "2026-11-05", 1_000_000),
        point("tdcc", "stock", "2026-11-06", 1_020_000),
        // 與集保同日：集保涵蓋所有券商，券商台股不得再加。
        point("sinotrade", "tw_stock", "2026-11-06", 1_019_000),
        // 集保尚未更新的日期改用券商台股，與集保同一序列，前端沿用前值時不會重複。
        point("sinotrade", "tw_stock", "2026-11-08", 1_030_000),
        point("sinotrade", "stock", "2026-11-08", 45_000),
      ]);

    expect(await stockRows()).toEqual([
      { date: "2026-11-05", netWorth: 1_000_000, source: "tw-stock" },
      { date: "2026-11-06", netWorth: 1_020_000, source: "tw-stock" },
      { date: "2026-11-08", netWorth: 45_000, source: "sinotrade" },
      { date: "2026-11-08", netWorth: 1_030_000, source: "tw-stock" },
    ]);
  });

  it("沒有連接集保時，台股走勢完全來自券商", async () => {
    await createDrizzle(harness.binding)
      .insert(netWorthHistory)
      .values([
        point("sinotrade", "tw_stock", "2026-11-08", 500_000),
        point("sinotrade", "tw_stock", "2026-11-09", 510_000),
      ]);

    expect(await stockRows()).toEqual([
      { date: "2026-11-08", netWorth: 500_000, source: "tw-stock" },
      { date: "2026-11-09", netWorth: 510_000, source: "tw-stock" },
    ]);
  });

  it("集保持股只由券商最新快照涵蓋：帳戶已不在最新快照時不輸出成本", async () => {
    const position = (
      id: string,
      connectorId: string,
      brokerAccount: string,
      asOfDate: string,
      costBasis?: number,
    ) => ({
      id,
      connectorId,
      sourceId: id,
      assetType: "stock",
      name: id,
      brokerNo: "9A00",
      brokerAccount,
      market: "TW",
      marketValue: 100_000,
      costBasis,
      currency: "TWD",
      asOfDate,
      createdAt: now,
      updatedAt: now,
    });
    const costRows = async () =>
      (await getNetWorthChartHistory(harness.binding)).filter(
        (row) => row.assetType === "stock_cost",
      );
    const database = createDrizzle(harness.binding);
    await database
      .insert(investmentPositions)
      .values([
        position("tdcc-a", "tdcc", "A", "2026-11-10"),
        position("direct-a", "sinotrade", "A", "2026-11-10", 80_000),
      ]);
    expect(await costRows()).not.toEqual([]);

    // 最新快照只剩帳戶 B；帳戶 A 的舊列不得讓集保的 A 持股被視為已涵蓋。
    await database
      .insert(investmentPositions)
      .values([position("direct-b", "sinotrade", "B", "2026-11-11", 10_000)]);
    expect(await costRows()).toEqual([]);
  });
});
