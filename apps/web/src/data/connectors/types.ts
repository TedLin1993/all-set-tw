export type {
  ConnectorId,
  QueuedSyncResponse,
  ConnectorDataSummaryResponse as ConnectorDataSummary,
  ConnectorSettingsResponse as ConnectorSettings,
  ConnectorUnlinkResponse,
  ManualSyncRunSummary as ManualSyncRun,
  SyncJobResponse as SyncJobRow,
  SyncScheduleResponse as SyncScheduleSettings,
} from "@taiwan-fin-hub/shared";

export type SyncTarget = "default" | "investments" | "bank" | "trades";
