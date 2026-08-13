import { describe, expect, it } from "vitest";
import {
  buildNetWorthChartData,
  getNetWorthComparison,
  getAvailableNetWorthAssets,
} from "./net-worth-chart";
import type { NetWorthHistoryRow } from "@/data/assets/types";

const rows: NetWorthHistoryRow[] = [
  { date: "2026-01-01", netWorth: 100, assetType: "stock", source: "tdcc" },
  { date: "2026-01-02", netWorth: 40, assetType: "fund", source: "tdcc" },
  { date: "2026-01-02", netWorth: 500, assetType: "deposit", source: "bank" },
  { date: "2026-01-03", netWorth: 110, assetType: "stock", source: "tdcc" },
  {
    date: "2026-01-03",
    netWorth: 200,
    assetType: "manual:home",
    source: "manual",
  },
  {
    date: "2026-01-03",
    netWorth: 50,
    assetType: "manual:policy",
    source: "manual",
  },
];

describe("net worth chart data", () => {
  it("aggregates selected asset types into one point per date", () => {
    const points = buildNetWorthChartData(
      rows,
      ["stock", "fund", "deposit"],
      "ALL",
    );

    expect(points).toEqual([
      {
        date: "2026-01-01",
        stock: 100,
        fund: undefined,
        deposit: undefined,
        manual: undefined,
        selectedTotal: 100,
      },
      {
        date: "2026-01-02",
        stock: 100,
        fund: 40,
        deposit: 500,
        manual: undefined,
        selectedTotal: 640,
      },
      {
        date: "2026-01-03",
        stock: 110,
        fund: 40,
        deposit: 500,
        manual: 250,
        selectedTotal: 650,
      },
    ]);
  });

  it("starts each category at its own first valuation date", () => {
    const points = buildNetWorthChartData(rows, ["stock", "manual"], "ALL");

    expect(
      points.map(({ date, stock, manual, selectedTotal }) => ({
        date,
        stock,
        manual,
        selectedTotal,
      })),
    ).toEqual([
      {
        date: "2026-01-01",
        stock: 100,
        manual: undefined,
        selectedTotal: 100,
      },
      {
        date: "2026-01-03",
        stock: 110,
        manual: 250,
        selectedTotal: 360,
      },
    ]);
  });

  it("aggregates independent manual assets and includes them only when selected", () => {
    const points = buildNetWorthChartData(rows, ["manual"], "ALL");

    expect(points).toEqual([
      {
        date: "2026-01-03",
        stock: 110,
        fund: 40,
        deposit: 500,
        manual: 250,
        selectedTotal: 250,
      },
    ]);
  });

  it("reports the asset types that have history", () => {
    expect([...getAvailableNetWorthAssets(rows)]).toEqual([
      "stock",
      "fund",
      "deposit",
      "manual",
    ]);
  });

  it("filters points outside the selected timeframe", () => {
    const points = buildNetWorthChartData(
      rows,
      ["stock"],
      "1M",
      new Date("2026-02-02T00:00:00Z"),
    );

    expect(points.map((point) => point.date)).toEqual(["2026-01-03"]);
    expect(points[0]?.stock).toBe(110);
  });

  it("compares with the latest snapshot on or before the target date", () => {
    const points = [
      { date: "2026-01-01", selectedTotal: 100 },
      { date: "2026-01-03", selectedTotal: 125 },
      { date: "2026-01-08", selectedTotal: 150 },
      { date: "2026-01-10", selectedTotal: 140 },
    ];
    expect(getNetWorthComparison(points, "week")).toEqual({
      currentDate: "2026-01-10",
      currentValue: 140,
      targetDate: "2026-01-03",
      previousDate: "2026-01-03",
      previousValue: 125,
      changeValue: 15,
      changePercent: 12,
    });
  });

  it("returns no comparison when the history has no target snapshot", () => {
    expect(
      getNetWorthComparison(
        [{ date: "2026-01-10", selectedTotal: 140 }],
        "day",
      ),
    ).toBeNull();
  });

  it("uses the same day in the previous calendar month and clamps month end", () => {
    const points = [
      { date: "2026-01-31", selectedTotal: 90 },
      { date: "2026-02-28", selectedTotal: 100 },
      { date: "2026-03-31", selectedTotal: 120 },
    ];
    expect(getNetWorthComparison(points, "month")).toMatchObject({
      targetDate: "2026-02-28",
      previousDate: "2026-02-28",
      changeValue: 20,
    });
  });

  it("leaves the percentage unavailable when the baseline is zero", () => {
    expect(
      getNetWorthComparison(
        [
          { date: "2026-01-01", selectedTotal: 0 },
          { date: "2026-01-02", selectedTotal: 30 },
        ],
        "day",
      )?.changePercent,
    ).toBeNull();
  });
});
