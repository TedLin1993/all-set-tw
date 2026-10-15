import type { ConnectorId } from "../connector-catalog";
import type { SyncErrorCode } from "./errors";

/** 手動同步、排程設定與 sync job 狀態的 API 契約。 */
export interface QueuedSyncResponse {
  success: true;
  connectorId: ConnectorId;
  scope: string;
  status: "queued";
  runId: string;
}

export type SyncNotificationStatus = "success" | "failed" | "needs_user_action";

export interface SyncNewRecordCounts {
  invoices: number;
  bankTransactions: number;
  investmentTransactions: number;
}

/** 排程同步支援的間隔（分鐘）；Worker 驗證與前端選項共用同一份清單。 */
export const SYNC_INTERVAL_MINUTES = [60, 360, 720, 1440, 10080] as const;

export type SyncIntervalMinutes = (typeof SYNC_INTERVAL_MINUTES)[number];

export function isSyncIntervalMinutes(
  value: number,
): value is SyncIntervalMinutes {
  return (SYNC_INTERVAL_MINUTES as readonly number[]).includes(value);
}

export type SyncScheduleMode = "inherit" | "custom";

/** `GET／PUT /api/sync-schedule` 的預設排程回應。 */
export interface SyncScheduleResponse {
  intervalMinutes: number;
  preferredTime: string;
  /** 舊版單一星期欄位；用戶端應使用 `preferredWeekdays`。 */
  preferredWeekday: number;
  preferredWeekdays: number[];
  timezone: "Asia/Taipei";
  updatedAt: string;
}

export type ManualSyncRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "needs_user_action"
  | "cancelled";

export interface ManualSyncRunSummary {
  id: string;
  status: ManualSyncRunStatus;
  errorCode: SyncErrorCode | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** `GET /api/sync-jobs` 的單一來源排程與執行狀態。 */
export interface SyncJobResponse {
  id: string;
  connectorId: ConnectorId;
  configured: boolean;
  scope: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  scheduleMode: SyncScheduleMode;
  preferredTime: string;
  /** 舊版單一星期欄位；用戶端應使用 `preferredWeekdays`。 */
  preferredWeekday: number;
  preferredWeekdays: number[];
  lockedUntil: string | null;
  lockedBy: string | null;
  lockTrigger: "manual" | "scheduled" | null;
  lockScope: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: SyncNotificationStatus | null;
  lastError: string | null;
  /** 最近一次失敗的 API 錯誤代碼；需要處理時用來接續驗證流程。 */
  lastErrorCode: SyncErrorCode | null;
  updatedAt: string;
  running: boolean;
  runId: string | null;
  phase: string | null;
  lastProgressAt: string | null;
  retryAfterSeconds: number;
  /** 最近一次背景手動同步；電子發票與集保使用各自的 durable run，固定為 null。 */
  manualRun: ManualSyncRunSummary | null;
}
