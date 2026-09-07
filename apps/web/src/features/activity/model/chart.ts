import type { ActivityItem } from "./types";

import {
  activityDisplayAmount,
  activityCashFlow,
  type ActivityFlow,
} from "@taiwan-fin-hub/core";
export {
  activityDisplayAmount,
  activityCashFlow,
  type ActivityFlow,
} from "@taiwan-fin-hub/core";

export interface ActivityCategorySlice {
  category: string;
  amount: number;
  percentage: number;
  color: string;
}

export const ACTIVITY_CATEGORY_COLORS = [
  "#3e6f7c",
  "#687f42",
  "#b75b45",
  "#c7922b",
  "#7665a8",
  "#388d82",
  "#a45c78",
  "#68747b",
];

export function activityCashAmountTwd(
  item: ActivityItem,
  rates: Record<string, number>,
) {
  if (
    item.amount == null ||
    item.excludedFromCalculation ||
    (item.source !== "bank" &&
      item.source !== "card" &&
      item.source !== "invoice")
  )
    return 0;
  const rate = item.currency === "TWD" ? 1 : (rates[item.currency] ?? 0);
  return (activityDisplayAmount(item) ?? 0) * rate;
}

export function buildActivityCategorySlices(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Record<string, number>,
): ActivityCategorySlice[] {
  const grouped = new Map<string, number>();

  for (const item of items) {
    if (activityCashFlow(item) !== flow) continue;
    const amount = Math.abs(activityCashAmountTwd(item, rates));
    grouped.set(item.category, (grouped.get(item.category) ?? 0) + amount);
  }

  const sorted = [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, amount]) => sum + amount, 0);

  return sorted.map(([category, amount], index) => ({
    category,
    amount,
    percentage: total === 0 ? 0 : (amount / total) * 100,
    color: ACTIVITY_CATEGORY_COLORS[index % ACTIVITY_CATEGORY_COLORS.length]!,
  }));
}
