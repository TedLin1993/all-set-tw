import { activityCashFlow, type ActivityFlow } from "./chart";
import type { ActivityItem } from "./types";

export type ActivityFlowFilter = "all" | ActivityFlow;
export type ActivitySourceFilter = "all" | "bank" | "card" | "invoice";

export interface ActivityCategoryFilter {
  flow: ActivityFlow;
  category: string;
}

export interface ActivityListFilters {
  month: string;
  flow: ActivityFlowFilter;
  source: ActivitySourceFilter;
  search: string;
  category: ActivityCategoryFilter | null;
}

export function filterActivities(
  items: ActivityItem[],
  filters: ActivityListFilters,
) {
  const normalizedSearch = filters.search.trim().toLowerCase();

  return items.filter((item) => {
    const itemFlow = activityCashFlow(item);
    const matchesFlow = filters.flow === "all" || itemFlow === filters.flow;
    const matchesSource =
      filters.source === "all" ||
      item.source === filters.source ||
      (filters.source === "invoice" && Boolean(item.invoiceId));
    const matchesSearch =
      !normalizedSearch ||
      `${item.title} ${item.subtitle} ${item.institutionName ?? ""} ${item.accountName ?? ""} ${item.category}`
        .toLowerCase()
        .includes(normalizedSearch);
    const matchesCategory =
      !filters.category ||
      (item.category === filters.category.category &&
        itemFlow === filters.category.flow);

    return (
      item.date.startsWith(filters.month) &&
      matchesFlow &&
      matchesSource &&
      matchesSearch &&
      matchesCategory
    );
  });
}
