import type { ActivityItem } from "./types";

export interface ActivityDateGroup {
  dateKey: string;
  items: ActivityItem[];
}

export function groupActivitiesByDate(
  items: ActivityItem[],
): ActivityDateGroup[] {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const dateKey = item.date.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
    const group = groups.get(dateKey);
    if (group) group.push(item);
    else groups.set(dateKey, [item]);
  }
  return Array.from(groups, ([dateKey, groupedItems]) => ({
    dateKey,
    items: groupedItems,
  }));
}

export function formatActivityDateGroup(dateKey: string) {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "日期未提供";
  const [, year, month, day] = match;
  const weekday = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const dayOfWeek = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  ).getUTCDay();
  return `${Number(month)} 月 ${Number(day)} 日・${weekday[dayOfWeek]}`;
}

export function activityStatusLabel(
  item: Pick<ActivityItem, "invoiceId" | "source" | "status">,
) {
  if (item.invoiceId && item.source !== "invoice") return "已配對發票";
  if (item.status === "pending") return "待入帳";
  if (item.status === "posted") return "已入帳";
  return item.status;
}
