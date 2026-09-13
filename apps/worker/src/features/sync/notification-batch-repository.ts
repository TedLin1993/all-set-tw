import {
  createDrizzle,
  sanitizeDatabaseError,
  syncJobs,
  syncJobSelection,
  connectorSettings,
  scheduledSyncBatches,
  scheduledSyncBatchResults,
  einvoiceSyncRuns,
} from "@taiwan-fin-hub/db";
import { and, asc, eq, isNull, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type {
  ConnectorId,
  SyncNewRecordCounts,
  SyncNotificationStatus,
} from "@taiwan-fin-hub/core";
import type { SyncJobRow } from "@taiwan-fin-hub/db";
import type { SyncNotificationEvent } from "../notifications/payload";
import {
  calculateCurrentFinancialSnapshot,
  hasCompletedFinancialBaseline,
} from "./report-repository";

type BatchMemberRow = {
  job_id: string;
  enabled: number | null;
  schedule_mode: "inherit" | "custom" | null;
  last_status: SyncNotificationStatus | null;
  locked_until: string | null;
  lock_trigger: "manual" | "scheduled" | null;
  configured_connector_id: string | null;
};

type BatchResultRow = {
  connector_id: ConnectorId;
  status: SyncNotificationStatus;
};

const CLAIMED_BATCH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function ensureDefaultScheduleBatch(db: D1Database) {
  const openBatchId = await findOpenDefaultScheduleBatchId(db);
  if (openBatchId) return openBatchId;

  await pruneClaimedDefaultScheduleBatches(db);

  const jobs = await createDrizzle(db)
    .select({
      id: sql<string>`${syncJobs.id}`,
      connector_id: sql<ConnectorId>`${syncJobs.connectorId}`,
    })
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.enabled, 1),
        sql`EXISTS (SELECT 1 FROM ${connectorSettings} WHERE ${connectorSettings.connectorId} = ${syncJobs.connectorId})`,
        eq(syncJobs.scheduleMode, "inherit"),
        or(
          isNull(syncJobs.lastStatus),
          ne(syncJobs.lastStatus, "needs_user_action"),
        ),
      ),
    )
    .orderBy(asc(syncJobs.id))
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  if (jobs.length === 0) return null;

  const batchId = `default:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const snapshot = await calculateCurrentFinancialSnapshot(db);
  const isBaseline = !(await hasCompletedFinancialBaseline(db));
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO scheduled_sync_batches (
             id, schedule_key, notification_claimed_at, created_at,
             is_baseline, assets_before_twd, credit_card_debt_before_twd,
             missing_currencies_before
           ) VALUES (?, 'default', NULL, ?, ?, ?, ?, ?)`,
        )
        .bind(
          batchId,
          now,
          isBaseline ? 1 : 0,
          snapshot.assetsTwd,
          snapshot.creditCardDebtTwd,
          JSON.stringify(snapshot.missingCurrencies),
        ),
      ...jobs.map((job) =>
        db
          .prepare(
            `INSERT INTO scheduled_sync_batch_results (
               batch_id, job_id, connector_id, status, completed_at
             ) VALUES (?, ?, ?, NULL, NULL)`,
          )
          .bind(batchId, job.id, job.connector_id),
      ),
    ]);
    return batchId;
  } catch (error) {
    // Another scheduler may have atomically created the only open default round.
    const existingBatchId = await findOpenDefaultScheduleBatchId(db);
    if (!existingBatchId) throw error;
    return existingBatchId;
  }
}

export async function findOpenDefaultScheduleBatchId(db: D1Database) {
  const batch = await createDrizzle(db)
    .select({ id: scheduledSyncBatches.id })
    .from(scheduledSyncBatches)
    .where(
      and(
        eq(scheduledSyncBatches.scheduleKey, "default"),
        isNull(scheduledSyncBatches.notificationClaimedAt),
      ),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return batch?.id ?? null;
}

export async function findNextDefaultScheduleBatchJob(
  db: D1Database,
  batchId: string,
) {
  const row = await createDrizzle(db)
    .select(syncJobSelection)
    .from(scheduledSyncBatchResults)
    .innerJoin(syncJobs, eq(syncJobs.id, scheduledSyncBatchResults.jobId))
    .where(
      and(
        eq(scheduledSyncBatchResults.batchId, batchId),
        isNull(scheduledSyncBatchResults.completedAt),
        eq(syncJobs.enabled, 1),
        sql`EXISTS (SELECT 1 FROM ${connectorSettings} WHERE ${connectorSettings.connectorId} = ${syncJobs.connectorId})`,
        eq(syncJobs.scheduleMode, "inherit"),
        or(
          isNull(syncJobs.lastStatus),
          ne(syncJobs.lastStatus, "needs_user_action"),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${einvoiceSyncRuns} WHERE ${einvoiceSyncRuns.syncJobId} = ${syncJobs.id} AND ${einvoiceSyncRuns.status} IN ('queued', 'initializing', 'processing'))`,
        or(
          isNull(syncJobs.lockedUntil),
          lt(syncJobs.lockedUntil, new Date().toISOString()),
        ),
      ),
    )
    .orderBy(asc(syncJobs.nextRunAt), asc(syncJobs.id))
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return (row as SyncJobRow<ConnectorId> | undefined) ?? null;
}

export async function recordDefaultScheduleBatchResult(
  db: D1Database,
  input: {
    batchId: string;
    jobId: string;
    notification: SyncNotificationEvent;
    newRecords: SyncNewRecordCounts;
  },
) {
  const result = await db
    .prepare(
      `UPDATE scheduled_sync_batch_results
       SET connector_id = ?, status = ?, completed_at = ?,
           new_invoices = ?,
           new_bank_transactions = ?,
           new_investment_transactions = ?
       WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL`,
    )
    .bind(
      input.notification.connectorId,
      input.notification.status,
      new Date().toISOString(),
      input.newRecords.invoices,
      input.newRecords.bankTransactions,
      input.newRecords.investmentTransactions,
      input.batchId,
      input.jobId,
    )
    .run();
  return result.meta.changes === 1;
}

export async function finalizeOpenDefaultScheduleBatch(db: D1Database) {
  const batchId = await findOpenDefaultScheduleBatchId(db);
  if (!batchId) return null;
  return claimCompletedDefaultScheduleBatch(db, batchId);
}

export async function claimCompletedDefaultScheduleBatch(
  db: D1Database,
  batchId: string,
): Promise<SyncNotificationEvent[] | null> {
  await reconcileDefaultScheduleBatchMembers(db, batchId);

  const now = new Date().toISOString();
  const snapshot = await calculateCurrentFinancialSnapshot(db);
  const claim = await db
    .prepare(
      `UPDATE scheduled_sync_batches
       SET notification_claimed_at = ?,
           completed_at = ?,
           assets_after_twd = ?,
           credit_card_debt_after_twd = ?,
           missing_currencies_after = ?
       WHERE id = ?
         AND notification_claimed_at IS NULL
         AND completed_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM scheduled_sync_batch_results
           WHERE batch_id = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM scheduled_sync_batch_results
           WHERE batch_id = ? AND completed_at IS NULL
         )`,
    )
    .bind(
      now,
      now,
      snapshot.assetsTwd,
      snapshot.creditCardDebtTwd,
      JSON.stringify(snapshot.missingCurrencies),
      batchId,
      batchId,
      batchId,
    )
    .run();
  if (claim.meta.changes !== 1) return null;

  const results = await createDrizzle(db)
    .select({
      connector_id: sql<
        BatchResultRow["connector_id"]
      >`${scheduledSyncBatchResults.connectorId}`,
      status: sql<
        BatchResultRow["status"]
      >`${scheduledSyncBatchResults.status}`,
    })
    .from(scheduledSyncBatchResults)
    .where(
      and(
        eq(scheduledSyncBatchResults.batchId, batchId),
        isNotNull(scheduledSyncBatchResults.status),
      ),
    )
    .orderBy(asc(scheduledSyncBatchResults.jobId))
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return results.map((row) => ({
    connectorId: row.connector_id,
    status: row.status,
  }));
}

async function reconcileDefaultScheduleBatchMembers(
  db: D1Database,
  batchId: string,
) {
  const rows = await createDrizzle(db)
    .select({
      job_id: scheduledSyncBatchResults.jobId,
      enabled: syncJobs.enabled,
      schedule_mode: sql<
        BatchMemberRow["schedule_mode"]
      >`${syncJobs.scheduleMode}`,
      last_status: sql<BatchMemberRow["last_status"]>`${syncJobs.lastStatus}`,
      locked_until: syncJobs.lockedUntil,
      lock_trigger: sql<
        BatchMemberRow["lock_trigger"]
      >`${syncJobs.lockTrigger}`,
      configured_connector_id: connectorSettings.connectorId,
    })
    .from(scheduledSyncBatchResults)
    .leftJoin(syncJobs, eq(syncJobs.id, scheduledSyncBatchResults.jobId))
    .leftJoin(
      connectorSettings,
      eq(connectorSettings.connectorId, syncJobs.connectorId),
    )
    .where(
      and(
        eq(scheduledSyncBatchResults.batchId, batchId),
        isNull(scheduledSyncBatchResults.completedAt),
      ),
    )
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  const now = Date.now();

  for (const row of rows) {
    const noLongerInherited =
      row.enabled === null ||
      row.enabled !== 1 ||
      row.schedule_mode === null ||
      row.schedule_mode !== "inherit" ||
      row.configured_connector_id === null;
    const needsUserAction = row.last_status === "needs_user_action";
    const scheduledRunIsActive =
      row.lock_trigger === "scheduled" &&
      row.locked_until !== null &&
      new Date(row.locked_until).getTime() > now;
    if ((!noLongerInherited && !needsUserAction) || scheduledRunIsActive) {
      continue;
    }

    await db
      .prepare(
        `UPDATE scheduled_sync_batch_results
         SET completed_at = ?
         WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL`,
      )
      .bind(new Date().toISOString(), batchId, row.job_id)
      .run();
  }
}

async function pruneClaimedDefaultScheduleBatches(db: D1Database) {
  const cutoff = new Date(
    Date.now() - CLAIMED_BATCH_RETENTION_MS,
  ).toISOString();
  await db
    .prepare(
      `DELETE FROM scheduled_sync_batches
       WHERE schedule_key = 'default'
         AND notification_claimed_at IS NOT NULL
         AND notification_claimed_at < ?`,
    )
    .bind(cutoff)
    .run();
}
