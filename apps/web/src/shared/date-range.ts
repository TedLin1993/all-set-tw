export interface MonthRange {
  from: string;
  to: string;
}

export function recentMonthRange(count: number, now = new Date()): MonthRange {
  return monthRangeEndingAt(monthKey(now), count);
}

export function monthRangeEndingAt(month: string, count: number): MonthRange {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(year, monthNumber - count, 1);
  return {
    from: monthKey(start),
    to: month,
  };
}

export function recentMonthKeys(count: number, now = new Date()) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - count + 1 + index,
      1,
    );
    return monthKey(date);
  });
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
