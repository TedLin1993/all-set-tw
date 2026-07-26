import { queryOptions } from "@tanstack/svelte-query";
import type { ApiClient } from "@/shared/api/client";
import { queryKeys } from "@/shared/api/query-keys";
import type {
  ConnectorSettings,
  SyncJobRow,
  SyncScheduleSettings,
} from "./types";

type ApiProvider = () => ApiClient;

const syncJobSnapshots = new Map<
  string,
  Pick<SyncJobRow, "updatedAt" | "running" | "lastStatus">
>();

function publishCompletedSyncJobs(jobs: SyncJobRow[]) {
  if (typeof window === "undefined") return;

  const completed: SyncJobRow[] = [];
  for (const job of jobs) {
    const previous = syncJobSnapshots.get(job.id);
    if (previous && previous.updatedAt !== job.updatedAt && !job.running) {
      completed.push(job);
    }
    syncJobSnapshots.set(job.id, {
      updatedAt: job.updatedAt,
      running: job.running,
      lastStatus: job.lastStatus,
    });
  }

  if (completed.length > 0) {
    window.dispatchEvent(
      new CustomEvent("taiwan-fin-hub:sync-jobs-completed", {
        detail: completed,
      }),
    );
  }
}

export const syncJobsQuery = (getApi: ApiProvider) =>
  queryOptions({
    queryKey: queryKeys.syncJobs,
    queryFn: async () => {
      const jobs = await getApi().get<SyncJobRow[]>("/api/sync-jobs");
      publishCompletedSyncJobs(jobs);
      return jobs;
    },
    refetchInterval: (query) => {
      const jobs = query.state.data as SyncJobRow[] | undefined;
      return jobs?.some((job) => job.running) ? 2_000 : false;
    },
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