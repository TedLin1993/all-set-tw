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

// 每個分類固定一個顏色，讓圖表、列表與詳情在不同月份與收支別都一致。
// 少用的分類共用相近分類的顏色；未分類固定為淺灰。
const ACTIVITY_CATEGORY_COLOR_BY_ID: Record<string, string> = {
  food: "#b75b45",
  shopping: "#a45c78",
  transport: "#3e6f7c",
  utilities: "#c7922b",
  software: "#4a64a0",
  housing: "#8c6844",
  health: "#388d82",
  entertainment: "#7665a8",
  investment: "#2f6b4f",
  salary: "#687f42",
  reward: "#d07a3a",
  transfer: "#68747b",
  fee: "#a08a5a",
  other: "#b0aca3",
  "other-income": "#3e6f7c",
  education: "#4a64a0",
  insurance: "#388d82",
  tax: "#a08a5a",
  donation: "#7665a8",
};

// 自訂分類依 ID 雜湊取色，不含灰階以免和轉帳、未分類混淆。
const CUSTOM_CATEGORY_COLORS = [
  "#b75b45",
  "#a45c78",
  "#3e6f7c",
  "#c7922b",
  "#4a64a0",
  "#8c6844",
  "#388d82",
  "#7665a8",
  "#2f6b4f",
  "#687f42",
  "#d07a3a",
];

export function activityCategoryColor(categoryId: string | undefined): string {
  const id = categoryId ?? "other";
  const fixed = ACTIVITY_CATEGORY_COLOR_BY_ID[id];
  if (fixed) return fixed;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return CUSTOM_CATEGORY_COLORS[hash % CUSTOM_CATEGORY_COLORS.length]!;
}

export function buildActivityCategorySlices(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Record<string, number>,
): ActivityCategorySlice[] {
  // A category whose refunds exceed its spending has no slice to draw.
  const sorted = activityCategoryTotalsTwd(items, flow, rates);
  const total = sorted.reduce((sum, { amount }) => sum + amount, 0);
  const categoryIds = new Map<string, string | undefined>();
  for (const item of items)
    if (!categoryIds.has(item.category))
      categoryIds.set(item.category, item.categoryId);

  return sorted.map(({ category, amount }) => ({
    category,
    amount,
    percentage: total === 0 ? 0 : (amount / total) * 100,
    color: activityCategoryColor(categoryIds.get(category)),
  }));
}
