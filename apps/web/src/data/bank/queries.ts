import { queryOptions } from "@tanstack/svelte-query";
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type { MonthRange } from "@/shared/date-range";
import type { BankAccountRow, BankData, CreditCardBillRow } from "./types";

type ApiProvider = () => ApiClient;

export const bankAccountsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.bankAccounts,
    queryFn: () => getApi().get<BankAccountRow[]>("/api/bank/accounts"),
  });

export const bankRangeQuery = (getApi: ApiProvider, range: MonthRange) =>
  queryOptions({
    queryKey: queryKeys.bankRange(range.from, range.to),
    queryFn: () =>
      getApi().get<BankData>(
        `/api/bank?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });

export const creditCardBillsRangeQuery = (
  getApi: ApiProvider,
  range: MonthRange,
) =>
  queryOptions({
    queryKey: queryKeys.billsRange(range.from, range.to),
    queryFn: () =>
      getApi().get<CreditCardBillRow[]>(
        `/api/bank/bills?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });

export const creditCardBillsQuery = (
  getApi: ApiProvider,
  range?: MonthRange,
): CreateQueryOptions<CreditCardBillRow[]> => ({
  queryKey: range
    ? queryKeys.billsRange(range.from, range.to)
    : queryKeys.bills,
  queryFn: () =>
    getApi().get<CreditCardBillRow[]>(
      range
        ? `/api/bank/bills?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
        : "/api/bank/bills",
    ),
});
