import type { ActivityItem } from "./types";

import {
  activityDisplayAmount,
  activityCashFlow,
  type ActivityFlow,
} from "@taiwan-fin-hub/shared";
export {
  activityDisplayAmount,
  activityCashFlow,
  type ActivityFlow,
} from "@taiwan-fin-hub/shared";

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

export function activityAmountTwd(
  item: ActivityItem,
  rates: Record<string, number>,
): number | undefined {
  const amount = activityDisplayAmount(item);
  if (amount == null) return undefined;
  if (amount === 0) return 0;
  if (item.currency === "TWD") return amount;
  const rate = rates[item.currency];
  return rate != null && Number.isFinite(rate) && rate > 0
    ? amount * rate
    : undefined;
}

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
  return activityAmountTwd(item, rates) ?? 0;
}

/**
 * Contribution to one flow's total in TWD. Refunds sit on the expense side as
 * negative amounts, so they reduce their category instead of adding income.
 */
export function activityFlowAmountTwd(
  item: ActivityItem,
  flow: ActivityFlow,
  rates: Record<string, number>,
) {
  if (activityCashFlow(item) !== flow) return 0;
  const amount = activityCashAmountTwd(item, rates);
  return flow === "expense" ? -amount : amount;
}

/** Net flow total; a refund from an earlier month still reduces this month. */
export function activityFlowTotalTwd(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Record<string, number>,
) {
  return items.reduce(
    (sum, item) => sum + activityFlowAmountTwd(item, flow, rates),
    0,
  );
}

export function buildActivityCategorySlices(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Record<string, number>,
): ActivityCategorySlice[] {
  const grouped = new Map<string, number>();

  for (const item of items) {
    if (activityCashFlow(item) !== flow) continue;
    grouped.set(
      item.category,
      (grouped.get(item.category) ?? 0) +
        activityFlowAmountTwd(item, flow, rates),
    );
  }

  // A category whose refunds exceed its spending has no slice to draw.
  const sorted = [...grouped.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((sum, [, amount]) => sum + amount, 0);

  return sorted.map(([category, amount], index) => ({
    category,
    amount,
    percentage: total === 0 ? 0 : (amount / total) * 100,
    color: ACTIVITY_CATEGORY_COLORS[index % ACTIVITY_CATEGORY_COLORS.length]!,
  }));
}
