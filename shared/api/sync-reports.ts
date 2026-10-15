import type { ConnectorId } from "../connector-catalog";
import type { SyncNewRecordCounts, SyncNotificationStatus } from "./sync";

/** 排程同步報告與各來源活動變化明細的 API 契約。 */
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
