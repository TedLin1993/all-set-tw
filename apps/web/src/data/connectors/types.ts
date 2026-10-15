export type {
  ConnectorId,
  QueuedSyncResponse,
  ConnectorSettingsResponse as ConnectorSettings,
  ManualSyncRunSummary as ManualSyncRun,
  SyncJobResponse as SyncJobRow,
  SyncScheduleResponse as SyncScheduleSettings,
} from "@taiwan-fin-hub/shared";

export type SyncTarget = "default" | "investments" | "bank" | "trades";
