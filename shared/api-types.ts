import type { ConnectorId } from "./connector-catalog";

export interface Summary {
  invoiceCount: number;
  investmentCount: number;
  totalInvestmentValue: number;
  bankAccountCount: number;
  totalBankBalance: number;
}

export interface ConnectorSettingsMetadata {
  connectorId: string;
  configured: boolean;
  updatedAt?: string;
  publicConfig?: Record<string, unknown> | null;
}

export interface SyncResponse {
  success: true;
  connectorId: ConnectorId;
  scope: string;
  records: number;
  newRecords: SyncNewRecordCounts;
  detailRecords?: number;
  cursorUpdated: boolean;
}

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

export interface ScheduledSyncSourceReport {
  connectorId: ConnectorId;
  status: SyncNotificationStatus;
  completedAt: string;
  /** Time when a later manual sync repaired this source in the latest report. */
  recoveredAt: string | null;
  newRecords: SyncNewRecordCounts;
}

export type SyncFinancialChangeUnavailableReason =
  "baseline" | "partial_sync" | "snapshot_unavailable";

export interface ScheduledSyncReport {
  id: string;
  startedAt: string;
  completedAt: string;
  status: SyncNotificationStatus;
  sources: ScheduledSyncSourceReport[];
  sourceSummary: {
    total: number;
    success: number;
    failed: number;
    needsUserAction: number;
  };
  newRecords: SyncNewRecordCounts;
  financialChange: {
    assets: number;
    creditCardDebt: number;
    loanDebt: number;
    netWorth: number;
  } | null;
  financialChangeUnavailableReason: SyncFinancialChangeUnavailableReason | null;
  missingCurrencies: string[];
  /** Time when a later manual sync repaired one or more sources in this report. */
  recoveredAt: string | null;
}

export interface NotificationPreferences {
  success: boolean;
  failed: boolean;
  needsUserAction: boolean;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NotificationConfig {
  enabled: boolean;
  publicKey: string | null;
  subscribedDevices: number;
  preferences: NotificationPreferences;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export interface SyncActivityDetail {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  amount?: number;
  currency: string;
  status: string;
  changes: Array<"added" | "posted" | "invoice_linked">;
  invoiceId?: string;
  syncedAt: string;
}

export interface SyncActivityDetailsPage {
  availability: "available" | "legacy" | "pending";
  items: SyncActivityDetail[];
}

export interface SyncReportActivities {
  sources: Partial<Record<ConnectorId, SyncActivityDetailsPage>>;
}
