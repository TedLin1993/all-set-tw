import type { ActivityItem } from "./types";
export type ActivityFlow = "income" | "expense";
export function activityDisplayAmount(item: ActivityItem) {
  if (item.amount == null) return undefined;
  return item.source === "invoice" ? -Math.abs(item.amount) : item.amount;
}

/** 計入收支的來源；投資交易不算現金收支。手動記錄不是信用卡，只是另一種銀行外的現金來源。 */
export function isActivityCashSource(item: Pick<ActivityItem, "source">) {
  return (
    item.source === "bank" ||
    item.source === "card" ||
    item.source === "invoice" ||
    item.source === "manual"
  );
}

export function activityCashFlow(item: ActivityItem): ActivityFlow | null {
  if (item.amount == null || !isActivityCashSource(item)) return null;
  const amount = activityDisplayAmount(item);
  if (amount == null) return null;
  // A refund returns money spent in its category, so it reduces that expense.
  if (amount > 0) return item.refund ? "expense" : "income";
  if (amount < 0) return "expense";
  return null;
}
