import type { ActivityItem } from "./types";
import { activityDateKey } from "./list";

export function countPendingActivityItems(
  items: ActivityItem[],
  month: string,
) {
  return items.filter(
    (item) =>
      activityDateKey(item).startsWith(month) &&
      (item.source === "bank" || item.source === "card") &&
      (item.status === "pending" || item.categoryId === "other"),
  ).length;
}
