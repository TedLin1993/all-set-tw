import type { ScheduledSyncReport } from "@taiwan-fin-hub/core";
import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";

type ApiProvider = () => ApiClient;

export const latestSyncReportQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.latestSyncReport,
    queryFn: () =>
      getApi().get<ScheduledSyncReport | null>("/api/sync-reports/latest"),
  });
