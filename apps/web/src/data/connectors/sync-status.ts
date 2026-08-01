import type { SyncJobRow } from "./types";

export type SyncSourceStatus =
  "unconfigured" | "needs_action" | "healthy" | "not_synced";

type SyncJobStatusInput = Pick<
  SyncJobRow,
  "configured" | "lastStatus" | "lastSuccessAt"
>;

export function getSyncSourceStatus(
  job: SyncJobStatusInput | undefined,
  configured = job?.configured ?? false,
): SyncSourceStatus {
  if (!configured) return "unconfigured";
  if (job?.lastStatus === "failed" || job?.lastStatus === "needs_user_action")
    return "needs_action";
  return job?.lastSuccessAt ? "healthy" : "not_synced";
}

export function isActionableSyncJob(
  job: SyncJobStatusInput | undefined,
): boolean {
  return getSyncSourceStatus(job) === "needs_action";
}

export function getConfiguredSyncJobs(jobs: SyncJobRow[]) {
  return jobs.filter((job) => job.configured && job.scope === "all");
}

export function getActionableSyncJobs(jobs: SyncJobRow[]) {
  return getConfiguredSyncJobs(jobs).filter(isActionableSyncJob);
}
