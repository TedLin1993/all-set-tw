import type { ActivityItem } from "./types";

export function countPendingActivityItems(
  items: ActivityItem[],
  month: string,
) {
  return items.filter(
    (item) =>
      item.date.startsWith(month) &&
      (item.source === "bank" || item.source === "card") &&
      (item.status === "pending" || item.categoryId === "other"),
  ).length;
}
