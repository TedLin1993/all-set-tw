import type { ActivityItem } from "./activity-types";
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
  if (amount > 0) return "income";
  if (amount < 0) return "expense";
  return null;
}
