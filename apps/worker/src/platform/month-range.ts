import { z } from "zod";

const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export const monthRangeQuerySchema = z
  .object({
    month: z.string().regex(monthPattern).optional(),
    from: z.string().regex(monthPattern).optional(),
    to: z.string().regex(monthPattern).optional(),
  })
  .superRefine((value, context) => {
    const hasFrom = value.from !== undefined;
    const hasTo = value.to !== undefined;
    if (value.month !== undefined && (hasFrom || hasTo)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["month"],
        message: "month cannot be combined with from/to.",
      });
    }
    if (hasFrom !== hasTo) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasFrom ? "to" : "from"],
        message: "from and to must be provided together.",
      });
    }
    if (value.from && value.to) {
      const fromIndex = monthIndex(value.from);
      const toIndex = monthIndex(value.to);
      if (toIndex < fromIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["to"],
          message: "to must not be earlier than from.",
        });
      } else if (toIndex - fromIndex > 11) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["to"],
          message: "The requested range cannot exceed 12 months.",
        });
      }
    }
  });

export type MonthRangeQuery = z.infer<typeof monthRangeQuerySchema>;

export type MonthDateRange = {
  from: string;
  to: string;
};

export function resolveMonthDateRange(
  query: MonthRangeQuery,
): MonthDateRange | undefined {
  if (query.month) return monthToDateRange(query.month);
  if (!query.from || !query.to) return undefined;
  return {
    from: `${query.from}-01`,
    to: nextMonthStart(query.to),
  };
}

function monthToDateRange(month: string): MonthDateRange {
  return { from: `${month}-01`, to: nextMonthStart(month) };
}

function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

function monthIndex(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return year * 12 + monthNumber;
}
