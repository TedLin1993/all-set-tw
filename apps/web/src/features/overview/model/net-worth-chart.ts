import type { NetWorthHistoryRow } from "@/data/assets/types";

export type NetWorthAssetType = "stock" | "fund" | "deposit" | "manual";
export type NetWorthDisplayMode = "sum" | "breakdown";
export type NetWorthTimeframe = "1M" | "3M" | "6M" | "1Y" | "ALL";
export type NetWorthComparisonPeriod = "day" | "week" | "month";

export const NET_WORTH_COMPARISON_PERIODS: Array<{
  key: NetWorthComparisonPeriod;
  label: string;
  days?: number;
}> = [
  { key: "day", label: "較昨日", days: 1 },
  { key: "week", label: "較上週", days: 7 },
  { key: "month", label: "較上月" },
];

export interface NetWorthChartPoint {
  date: string;
  stock?: number;
  fund?: number;
  deposit?: number;
  manual?: number;
  selectedTotal: number;
}

export interface NetWorthComparison {
  currentDate: string;
  currentValue: number;
  targetDate: string;
  previousDate: string;
  previousValue: number;
  changeValue: number;
  changePercent: number | null;
}

export const NET_WORTH_ASSET_SERIES: Array<{
  key: NetWorthAssetType;
  label: string;
  color: string;
}> = [
  { key: "stock", label: "股票/ETF", color: "#6574cd" },
  { key: "fund", label: "基金", color: "#9b6bb0" },
  { key: "deposit", label: "存款", color: "#3e6f7c" },
  { key: "manual", label: "其他資產", color: "#b5853f" },
];

export const NET_WORTH_DEFAULT_ASSETS: NetWorthAssetType[] = [
  "stock",
  "fund",
  "deposit",
];

const TIMEFRAME_MONTHS: Record<NetWorthTimeframe, number | null> = {
  "1M": 1,
  "3M": 3,
  "6M": 6,
  "1Y": 12,
  ALL: null,
};

function matchesAssetType(row: NetWorthHistoryRow, type: NetWorthAssetType) {
  if (type === "manual") return row.source === "manual";
  if (type === "deposit")
    return row.source === "bank" && row.assetType === "deposit";
  return row.assetType === type;
}

function cutoffDate(timeframe: NetWorthTimeframe, now: Date) {
  const months = TIMEFRAME_MONTHS[timeframe];
  if (months === null) return null;
  const targetMonth = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const lastDay = new Date(
    targetMonth.getFullYear(),
    targetMonth.getMonth() + 1,
    0,
  ).getDate();
  const cutoff = new Date(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(now.getDate(), lastDay),
  );
  const year = cutoff.getFullYear();
  const month = String(cutoff.getMonth() + 1).padStart(2, "0");
  const day = String(cutoff.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function latestValue(rows: NetWorthHistoryRow[], date: string) {
  let value: number | undefined;
  for (const row of rows) {
    if (row.date > date) break;
    value = row.netWorth;
  }
  return value;
}

function subtractDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function subtractCalendarMonth(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  const originalDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() - 1);
  const lastDay = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
  ).getUTCDate();
  value.setUTCDate(Math.min(originalDay, lastDay));
  return value.toISOString().slice(0, 10);
}

/**
 * Compares the latest valid snapshot with the latest snapshot on or before
 * the requested target date. Missing dates are expected for this history.
 */
export function getNetWorthComparison(
  points: NetWorthChartPoint[],
  period: NetWorthComparisonPeriod,
): NetWorthComparison | null {
  const option = NET_WORTH_COMPARISON_PERIODS.find(
    (option) => option.key === period,
  );
  if (!option || points.length === 0) return null;
  const sorted = points.slice().sort((a, b) => a.date.localeCompare(b.date));
  const current = sorted.at(-1);
  if (!current) return null;
  const targetDate =
    option.days === undefined
      ? subtractCalendarMonth(current.date)
      : subtractDays(current.date, option.days);
  const previous = sorted.filter((point) => point.date <= targetDate).at(-1);
  if (!previous) return null;
  const changeValue = current.selectedTotal - previous.selectedTotal;
  return {
    currentDate: current.date,
    currentValue: current.selectedTotal,
    targetDate,
    previousDate: previous.date,
    previousValue: previous.selectedTotal,
    changeValue,
    changePercent:
      previous.selectedTotal === 0
        ? null
        : (changeValue / Math.abs(previous.selectedTotal)) * 100,
  };
}

function buildAssetSeries(
  rows: NetWorthHistoryRow[],
  type: NetWorthAssetType,
  dates: string[],
) {
  const matchingRows = rows.filter((row) => matchesAssetType(row, type));
  const identities = new Map<string, NetWorthHistoryRow[]>();

  for (const row of matchingRows) {
    const identity = `${row.source}:${row.assetType}`;
    const values = identities.get(identity) ?? [];
    values.push(row);
    identities.set(identity, values);
  }

  for (const values of identities.values()) {
    values.sort((a, b) => a.date.localeCompare(b.date));
  }

  return new Map(
    dates.map((date) => [
      date,
      [...identities.values()].reduce<number | undefined>((sum, values) => {
        const value = latestValue(values, date);
        return value === undefined ? sum : (sum ?? 0) + value;
      }, undefined),
    ]),
  );
}

export function getAvailableNetWorthAssets(rows: NetWorthHistoryRow[]) {
  return new Set(
    NET_WORTH_ASSET_SERIES.filter(({ key }) =>
      rows.some((row) => matchesAssetType(row, key)),
    ).map(({ key }) => key),
  );
}

export function buildNetWorthChartData(
  rows: NetWorthHistoryRow[],
  includedAssets: NetWorthAssetType[],
  timeframe: NetWorthTimeframe,
  now = new Date(),
): NetWorthChartPoint[] {
  const sortedRows = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = cutoffDate(timeframe, now);
  const included = new Set(includedAssets);
  const dates = [
    ...new Set(
      sortedRows
        .filter((row) =>
          NET_WORTH_ASSET_SERIES.some(
            ({ key }) => included.has(key) && matchesAssetType(row, key),
          ),
        )
        .map((row) => row.date)
        .filter((date) => cutoff === null || date >= cutoff),
    ),
  ].sort();

  const valuesByType = Object.fromEntries(
    NET_WORTH_ASSET_SERIES.map(({ key }) => [
      key,
      buildAssetSeries(sortedRows, key, dates),
    ]),
  ) as Record<NetWorthAssetType, Map<string, number | undefined>>;

  return dates.map((date) => {
    const point: NetWorthChartPoint = {
      date,
      stock: valuesByType.stock.get(date),
      fund: valuesByType.fund.get(date),
      deposit: valuesByType.deposit.get(date),
      manual: valuesByType.manual.get(date),
      selectedTotal: 0,
    };
    point.selectedTotal = includedAssets.reduce(
      (sum, key) => sum + (point[key] ?? 0),
      0,
    );
    return point;
  });
}
