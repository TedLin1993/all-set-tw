import type { ActivityItem } from "@taiwan-fin-hub/core";
import { infiniteQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import type { BankData } from "@/data/bank/types";
import type { InvoiceSummaryRow } from "@/data/invoices/types";
import type { InvestmentTransactionRow } from "@/data/investments/types";

export interface ActivitySearchPage {
  items: ActivityItem[];
  bank: BankData;
  invoices: InvoiceSummaryRow[];
  trades: InvestmentTransactionRow[];
  nextCursor: string | null;
}

export function activitySearchQuery(
  getApi: () => ApiClient,
  q: string,
  from = "",
  to = "",
  source = "all",
  flow = "all",
  category = "",
) {
  return infiniteQueryOptions({
    queryKey: ["bank", "activity-search", q, from, to, source, flow, category],
    enabled: Boolean(q.trim()) && (!from || !to || from <= to),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ q, source, flow });
      if (category) params.set("category", category);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (pageParam) params.set("cursor", pageParam);
      return getApi().get<ActivitySearchPage>(`/api/activity/search?${params}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
