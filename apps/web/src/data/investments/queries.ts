import { queryOptions } from "@tanstack/svelte-query";
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type { MonthRange } from "@/shared/date-range";
import type { InvestmentRow, InvestmentTransactionRow } from "./types";

type ApiProvider = () => ApiClient;

export const investmentsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.investments,
    queryFn: () => getApi().get<InvestmentRow[]>("/api/investments"),
  });

export const investmentTransactionsRangeQuery = (
  getApi: ApiProvider,
  range: MonthRange,
) =>
  queryOptions({
    queryKey: queryKeys.investmentTransactionsRange(range.from, range.to),
    queryFn: () =>
      getApi().get<InvestmentTransactionRow[]>(
        `/api/investment-transactions?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });

export const investmentTransactionsQuery = (
  getApi: ApiProvider,
  range?: MonthRange,
): CreateQueryOptions<InvestmentTransactionRow[]> => ({
  queryKey: range
    ? queryKeys.investmentTransactionsRange(range.from, range.to)
    : queryKeys.investmentTransactions,
  queryFn: () =>
    getApi().get<InvestmentTransactionRow[]>(
      range
        ? `/api/investment-transactions?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        : "/api/investment-transactions",
    ),
});
