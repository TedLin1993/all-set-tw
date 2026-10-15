import type { SyncErrorCode } from "./api-error-codes";
import type { SyncNotificationStatus } from "./api-types";
import type { ConnectorId } from "./connector-catalog";

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

/** `GET /api/connectors/:connectorId/settings` 的非敏感設定狀態。 */
export interface ConnectorSettingsResponse {
  connectorId: ConnectorId;
  configured: boolean;
  updatedAt?: string;
  publicConfig: Record<string, unknown> | null;
  credentialsComplete: boolean;
  sessionAvailable: boolean;
  verificationPending: boolean;
  verificationChannel: "app" | "email" | "sms" | null;
  verificationExpiresAt: string | null;
}

/** 使用者可建立的分類規則比對欄位。 */
export const CLASSIFICATION_RULE_FIELDS = [
  "any_text",
  "description",
  "counterparty",
  "source_id",
] as const;

export type ClassificationRuleField =
  (typeof CLASSIFICATION_RULE_FIELDS)[number];

/** 使用者可建立或修改的分類規則比對方式。 */
export const CLASSIFICATION_RULE_OPERATORS = [
  "contains",
  "equals",
  "starts_with",
  "regex",
] as const;

export type ClassificationRuleOperator =
  (typeof CLASSIFICATION_RULE_OPERATORS)[number];

/**
 * `GET /api/classification/rules` 的規則回應。資料庫以文字保存 field／operator，
 * 回應維持 string；寫入時才以上方清單驗證。
 */
export interface ClassificationRuleResponse {
  id: string;
  categoryId: string;
  targetType: string | null;
  field: string;
  operator: string;
  pattern: string;
  priority: number;
  enabled: boolean;
  isSystem: boolean;
  source: string;
  description: string | null;
  excludedFromCalculation: boolean;
}

export interface ClassificationCategoryResponse {
  id: string;
  label: string;
  sortOrder: number;
  isSystem: boolean;
}
