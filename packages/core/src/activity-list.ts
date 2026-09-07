import type { ActivityItem } from "./activity-types";

const TAIPEI_TIME_ZONE = "Asia/Taipei";
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const ISO_DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TAIPEI_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: TAIPEI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const TAIPEI_TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  timeZone: TAIPEI_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface ActivityDateGroup {
  dateKey: string;
  items: ActivityItem[];
}

/**
 * Returns whether a value is an ISO timestamp with an explicit offset.
 * Date-only values and local timestamps are deliberately treated as dates.
 */
export function isActivityDateTime(value?: string): value is string {
  return value != null && ISO_DATE_TIME_WITH_OFFSET.test(value);
}

export function activityDateKey(
  item: Pick<ActivityItem, "date" | "dateHasTime" | "source">,
) {
  const timestamp = activityTimestamp(item);
  if (timestamp != null) {
    const parts = Object.fromEntries(
      TAIPEI_DATE_FORMATTER.formatToParts(new Date(timestamp)).map(
        ({ type, value }) => [type, value],
      ),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  return item.date.match(ISO_DATE_PREFIX)?.[0] ?? "";
}

export function activityTimestamp(
  item: Pick<ActivityItem, "date" | "dateHasTime" | "source">,
) {
  if (!hasReliableActivityTime(item)) return undefined;
  const timestamp = Date.parse(item.date);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function formatActivityTime(
  item: Pick<ActivityItem, "date" | "dateHasTime" | "source">,
) {
  const timestamp = activityTimestamp(item);
  if (timestamp == null) return undefined;
  const parts = Object.fromEntries(
    TAIPEI_TIME_FORMATTER.formatToParts(new Date(timestamp)).map(
      ({ type, value }) => [type, value],
    ),
  );
  return `${parts.hour}:${parts.minute}`;
}

export function formatActivityDate(item: ActivityItem) {
  const date = formatActivityDateGroup(activityDateKey(item));
  const time = formatActivityTime(item);
  return time ? `${date} · ${time}` : date;
}

export function currentActivityMonthKey(now = new Date()) {
  const parts = Object.fromEntries(
    TAIPEI_DATE_FORMATTER.formatToParts(now).map(({ type, value }) => [
      type,
      value,
    ]),
  );
  return `${parts.year}-${parts.month}`;
}

export type ActivityOrderKey = Pick<
  ActivityItem,
  "id" | "source" | "date" | "dateHasTime"
>;

export function compareActivityItems(
  left: ActivityOrderKey,
  right: ActivityOrderKey,
) {
  const leftDateKey = activityDateKey(left);
  const rightDateKey = activityDateKey(right);
  if (leftDateKey !== rightDateKey) {
    if (!leftDateKey) return 1;
    if (!rightDateKey) return -1;
    return rightDateKey.localeCompare(leftDateKey);
  }

  const leftTimestamp = activityTimestamp(left);
  const rightTimestamp = activityTimestamp(right);
  if (leftTimestamp != null && rightTimestamp != null) {
    if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  } else if (leftTimestamp != null) {
    return -1;
  } else if (rightTimestamp != null) {
    return 1;
  }

  return `${left.source}\u0000${left.id}`.localeCompare(
    `${right.source}\u0000${right.id}`,
    "en",
  );
}

export function groupActivitiesByDate(
  items: ActivityItem[],
): ActivityDateGroup[] {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const dateKey = activityDateKey(item);
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

function hasReliableActivityTime(
  item: Pick<ActivityItem, "date" | "dateHasTime" | "source">,
) {
  if (item.dateHasTime != null) {
    return item.dateHasTime && isActivityDateTime(item.date);
  }
  // Legacy view-model callers may not provide the marker. Never infer a
  // bank/card time from postedDate; invoice timestamps are independently
  // authoritative when they carry an explicit offset.
  return item.source === "invoice" && isActivityDateTime(item.date);
}
