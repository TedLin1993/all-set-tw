import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type {
  ExchangeRateRow,
  ManualAssetHistoryEntry,
  ManualAssetRow,
  NetWorthHistoryRow,
} from "./types";

type ApiProvider = () => ApiClient;

export const manualAssetsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.manualAssets,
    queryFn: () => getApi().get<ManualAssetRow[]>("/api/manual-assets"),
  });

export const manualAssetHistoryQuery = (
  getApi: ApiProvider,
  assetId: string | null,
) =>
  queryOptions({
    queryKey: queryKeys.manualAssetHistory(assetId ?? ""),
    queryFn: () =>
      getApi().get<ManualAssetHistoryEntry[]>(
        `/api/manual-assets/${assetId}/history`,
      ),
    enabled: Boolean(assetId),
  });

export const exchangeRatesQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.exchangeRates,
    queryFn: () => getApi().get<ExchangeRateRow[]>("/api/exchange-rates"),
  });

export const exchangeRateCurrenciesQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.exchangeRateCurrencies,
    queryFn: () => getApi().get<string[]>("/api/exchange-rates/currencies"),
    staleTime: 0,
  });

export const netWorthHistoryQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.netWorthHistory,
    queryFn: () =>
      getApi().get<NetWorthHistoryRow[]>("/api/history/net-worth/chart"),
  });
