import type { ActivityItem } from "./types";

import {
  activityCategoryTotalsTwd,
  type ActivityFlow,
} from "@taiwan-fin-hub/shared";
export {
  activityDisplayAmount,
  activityCashFlow,
  activityAmountTwd,
  activityCashAmountTwd,
  activityFlowAmountTwd,
  activityFlowTotalTwd,
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

export function buildActivityCategorySlices(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Record<string, number>,
): ActivityCategorySlice[] {
  // A category whose refunds exceed its spending has no slice to draw.
  const sorted = activityCategoryTotalsTwd(items, flow, rates);
  const total = sorted.reduce((sum, { amount }) => sum + amount, 0);

  return sorted.map(({ category, amount }, index) => ({
    category,
    amount,
    percentage: total === 0 ? 0 : (amount / total) * 100,
    color: ACTIVITY_CATEGORY_COLORS[index % ACTIVITY_CATEGORY_COLORS.length]!,
  }));
}
