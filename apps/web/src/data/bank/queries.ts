import { queryOptions } from "@tanstack/svelte-query";
import type { CreateQueryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type { MonthRange } from "@/shared/date-range";
import type {
  BankAccountRow,
  BankData,
  BankTransactionRow,
  CreditCardBillRow,
} from "./types";

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

const TRANSACTION_IDS_PER_REQUEST = 100;

/** 依 ID 讀取交易；沒有 ID 時不送出請求。 */
export const bankTransactionsByIdsQuery = (
  getApi: ApiProvider,
  ids: readonly string[],
) =>
  queryOptions({
    queryKey: queryKeys.bankTransactions(ids),
    enabled: ids.length > 0,
    queryFn: async () => {
      const requests: Promise<BankTransactionRow[]>[] = [];
      for (
        let offset = 0;
        offset < ids.length;
        offset += TRANSACTION_IDS_PER_REQUEST
      ) {
        const params = new URLSearchParams();
        for (const id of ids.slice(
          offset,
          offset + TRANSACTION_IDS_PER_REQUEST,
        ))
          params.append("ids", id);
        requests.push(
          getApi().get<BankTransactionRow[]>(
            `/api/bank/transactions?${params}`,
          ),
        );
      }
      return (await Promise.all(requests)).flat();
    },
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
