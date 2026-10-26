// 手機底部分類快篩卡（CategoryDetailSheet）用的清單與近 6 個月長條圖資料。
import { activityDateKey, compareActivityItems } from "@taiwan-fin-hub/shared";
import {
  activityCashFlow,
  activityFlowAmountTwd,
  type ActivityFlow,
} from "./chart";
import type { ActivityItem } from "./types";

export interface ActivityCategoryItemAmount {
  item: ActivityItem;
  /** 這筆活動算入該分類的金額（已換算台幣；支出分類的退款為負數）。 */
  amount: number;
}

/** 是否計入指定收支別與分類；口徑與 buildActivityCategorySlices 一致。 */
function isCategoryItem(
  item: ActivityItem,
  flow: ActivityFlow,
  category: string,
) {
  return (
    (item.source === "bank" ||
      item.source === "card" ||
      item.source === "invoice") &&
    !item.excludedFromCalculation &&
    item.amount != null &&
    activityCashFlow(item) === flow &&
    item.category === category
  );
}

/**
 * 指定月份、收支別、分類下的活動清單（供手機底部快篩卡使用），新到舊排序。
 * 金額加總等於 buildActivityCategorySlices 該分類的 amount。
 */
export function activityCategoryItemsForMonth(
  items: ActivityItem[],
  flow: ActivityFlow,
  category: string,
  monthKey: string,
  rates: Record<string, number>,
): ActivityCategoryItemAmount[] {
  const rows: ActivityCategoryItemAmount[] = [];
  for (const item of items) {
    if (!isCategoryItem(item, flow, category)) continue;
    if (!activityDateKey(item).startsWith(monthKey)) continue;
    rows.push({ item, amount: activityFlowAmountTwd(item, flow, rates) });
  }
  return rows.sort((a, b) => compareActivityItems(a.item, b.item));
}

export interface ActivityCategoryMonthPoint {
  month: string;
  amount: number;
}

/**
 * 指定分類在一串月份（例如活動頁已載入的近 6 個月）各月的加總金額，
 * 供手機底部快篩卡的 6 個月長條圖使用；口徑與 buildActivityCategorySlices 一致。
 */
export function activityCategorySixMonthSeries(
  items: ActivityItem[],
  flow: ActivityFlow,
  category: string,
  monthKeys: string[],
  rates: Record<string, number>,
): ActivityCategoryMonthPoint[] {
  return monthKeys.map((month) => {
    let amount = 0;
    for (const item of items) {
      if (!isCategoryItem(item, flow, category)) continue;
      if (!activityDateKey(item).startsWith(month)) continue;
      amount += activityFlowAmountTwd(item, flow, rates);
    }
    return { month, amount };
  });
}
