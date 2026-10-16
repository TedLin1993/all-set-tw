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
