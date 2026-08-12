import type { ConnectorId, QueuedSyncResponse } from "@taiwan-fin-hub/core";

export type { ConnectorId, QueuedSyncResponse } from "@taiwan-fin-hub/core";

export type SyncTarget = "default" | "investments" | "bank" | "trades";

export interface ConnectorSettings {
  connectorId: ConnectorId;
  configured: boolean;
  updatedAt?: string;
  publicConfig?: Record<string, unknown> | null;
  credentialsComplete?: boolean;
  sessionAvailable?: boolean;
}

export interface SyncJobRow {
  id: string;
  connectorId: ConnectorId;
  configured: boolean;
  scope: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: string;
  scheduleMode: "inherit" | "custom";
  preferredTime: string;
  preferredWeekday: number;
  lockedUntil: string | null;
  lockedBy: string | null;
  lockTrigger: "manual" | "scheduled" | null;
  lockScope: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: "success" | "failed" | "needs_user_action" | null;
  lastError: string | null;
  updatedAt: string;
  running: boolean;
}

export interface SyncScheduleSettings {
  intervalMinutes: number;
  preferredTime: string;
  preferredWeekday: number;
  timezone: "Asia/Taipei";
  updatedAt: string;
}

export interface ConnectorField<TKey extends string = string> {
  key: TKey;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
}
