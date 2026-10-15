import {
  SYNC_INTERVAL_MINUTES,
  type SyncIntervalMinutes,
  type SyncScheduleResponse,
} from "@taiwan-fin-hub/shared";

const syncIntervalLabels: Record<SyncIntervalMinutes, string> = {
  60: "每小時",
  360: "每 6 小時",
  720: "每 12 小時",
  1440: "每天",
  10080: "每週",
};

export const syncIntervalOptions = SYNC_INTERVAL_MINUTES.map((minutes) => ({
  minutes,
  label: syncIntervalLabels[minutes],
}));

export function syncIntervalLabel(minutes: number) {
  return (
    syncIntervalOptions.find((option) => option.minutes === minutes)?.label ??
    `${minutes} 分鐘`
  );
}

export const weekdayOptions = [
  { value: 1, label: "週一" },
  { value: 2, label: "週二" },
  { value: 3, label: "週三" },
  { value: 4, label: "週四" },
  { value: 5, label: "週五" },
  { value: 6, label: "週六" },
  { value: 0, label: "週日" },
];

export function formatScheduleWeekdays(days: number[]) {
  return `每${weekdayOptions
    .filter((option) => days.includes(option.value))
    .map((option) => option.label)
    .join("、")}`;
}

export function formatSyncSchedule(
  schedule: Pick<
    SyncScheduleResponse,
    "intervalMinutes" | "preferredTime" | "preferredWeekdays"
  >,
) {
  if (schedule.intervalMinutes === 1440)
    return `每天 ${schedule.preferredTime}`;
  if (schedule.intervalMinutes === 10080)
    return `${formatScheduleWeekdays(schedule.preferredWeekdays)} ${schedule.preferredTime}`;
  return `每 ${schedule.intervalMinutes / 60} 小時`;
}
