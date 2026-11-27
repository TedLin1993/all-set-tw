import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type {
  ConnectorDataSummary,
  ConnectorSettings,
  SyncJobRow,
  SyncScheduleSettings,
} from "./types";

type ApiProvider = () => ApiClient;

const SYNC_JOBS_POLL_MS = 3_000;

export const syncJobsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.syncJobs,
    queryFn: () => getApi().get<SyncJobRow[]>("/api/sync-jobs"),
    // 背景同步不依附頁面；任一來源執行中時持續更新狀態，全部閒置即停止。
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.running) ? SYNC_JOBS_POLL_MS : false,
  });

export const syncScheduleQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.syncSchedule,
    queryFn: () => getApi().get<SyncScheduleSettings>("/api/sync-schedule"),
  });

export const connectorSettingsQuery = (
  getApi: ApiProvider,
  connectorId: string,
) =>
  queryOptions({
    queryKey: queryKeys.connectorSettings(connectorId),
    queryFn: () =>
      getApi().get<ConnectorSettings>(
        `/api/connectors/${connectorId}/settings`,
      ),
  });

/** 解除連結確認時才讀取；每次打開都重新計算，筆數須反映當下的資料。 */
export const connectorDataSummaryQuery = (
  getApi: ApiProvider,
  connectorId: string,
) =>
  queryOptions({
    queryKey: queryKeys.connectorDataSummary(connectorId),
    queryFn: () =>
      getApi().get<ConnectorDataSummary>(
        `/api/connectors/${connectorId}/data-summary`,
      ),
    staleTime: 0,
    gcTime: 0,
  });
