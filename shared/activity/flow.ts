import type { ActivityItem } from "./types";
export type ActivityFlow = "income" | "expense";
export function activityDisplayAmount(item: ActivityItem) {
  if (item.amount == null) return undefined;
  return item.source === "invoice" ? -Math.abs(item.amount) : item.amount;
}

export function activityCashFlow(item: ActivityItem): ActivityFlow | null {
  if (
    item.amount == null ||
    (item.source !== "bank" &&
      item.source !== "card" &&
      item.source !== "invoice")
  )
    return null;
  const amount = activityDisplayAmount(item);
  if (amount == null) return null;
  // A refund returns money spent in its category, so it reduces that expense.
  if (amount > 0) return item.refund ? "expense" : "income";
  if (amount < 0) return "expense";
  return null;
}

/** 以台幣計的顯示金額；外幣缺少匯率時為 undefined。 */
export function activityAmountTwd(
  item: ActivityItem,
  rates: Readonly<Record<string, number>>,
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

/** 計入收支的台幣金額；排除計算、非收支來源或缺匯率時為 0。 */
export function activityCashAmountTwd(
  item: ActivityItem,
  rates: Readonly<Record<string, number>>,
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
  rates: Readonly<Record<string, number>>,
) {
  if (activityCashFlow(item) !== flow) return 0;
  const amount = activityCashAmountTwd(item, rates);
  return flow === "expense" ? -amount : amount;
}

/** Net flow total; a refund from an earlier month still reduces this month. */
export function activityFlowTotalTwd(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Readonly<Record<string, number>>,
) {
  return items.reduce(
    (sum, item) => sum + activityFlowAmountTwd(item, flow, rates),
    0,
  );
}

/** 各分類的台幣淨額，由大到小；退款大於支出的分類不列入。 */
export function activityCategoryTotalsTwd(
  items: ActivityItem[],
  flow: ActivityFlow,
  rates: Readonly<Record<string, number>>,
): { category: string; amount: number }[] {
  const grouped = new Map<string, number>();
  for (const item of items) {
    if (activityCashFlow(item) !== flow) continue;
    grouped.set(
      item.category,
      (grouped.get(item.category) ?? 0) +
        activityFlowAmountTwd(item, flow, rates),
    );
  }
  return [...grouped.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, amount]) => ({ category, amount }));
}
