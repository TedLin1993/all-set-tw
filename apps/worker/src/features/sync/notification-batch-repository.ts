import type { ConnectorId, SyncNotificationStatus } from "@taiwan-fin-hub/core";
import type { SyncJobRow } from "@taiwan-fin-hub/db";
import type { SyncNotificationEvent } from "../notifications/payload";

type BatchRow = {
  id: string;
};

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

  const jobs = await db
    .prepare(
      `SELECT id, connector_id
       FROM sync_jobs
       WHERE enabled = 1
         AND EXISTS (
           SELECT 1
           FROM connector_settings
           WHERE connector_settings.connector_id = sync_jobs.connector_id
         )
         AND schedule_mode = 'inherit'
         AND (last_status IS NULL OR last_status != 'needs_user_action')
       ORDER BY id ASC`,
    )
    .all<{ id: string; connector_id: ConnectorId }>();
  if (jobs.results.length === 0) return null;

  const batchId = `default:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO scheduled_sync_batches (
             id, schedule_key, notification_claimed_at, created_at
           ) VALUES (?, 'default', NULL, ?)`,
        )
        .bind(batchId, now),
      ...jobs.results.map((job) =>
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
  const batch = await db
    .prepare(
      `SELECT id
       FROM scheduled_sync_batches
       WHERE schedule_key = 'default' AND notification_claimed_at IS NULL
       LIMIT 1`,
    )
    .first<BatchRow>();
  return batch?.id ?? null;
}

export async function findNextDefaultScheduleBatchJob(
  db: D1Database,
  batchId: string,
) {
  return (
    (await db
      .prepare(
        `SELECT j.*
         FROM scheduled_sync_batch_results r
         JOIN sync_jobs j ON j.id = r.job_id
         WHERE r.batch_id = ?
           AND r.completed_at IS NULL
           AND j.enabled = 1
           AND EXISTS (
             SELECT 1
             FROM connector_settings
             WHERE connector_settings.connector_id = j.connector_id
           )
           AND j.schedule_mode = 'inherit'
           AND (j.last_status IS NULL OR j.last_status != 'needs_user_action')
           AND (j.locked_until IS NULL OR j.locked_until < ?)
         ORDER BY j.next_run_at ASC, j.id ASC
         LIMIT 1`,
      )
      .bind(batchId, new Date().toISOString())
      .first<SyncJobRow<ConnectorId>>()) ?? null
  );
}

export async function recordDefaultScheduleBatchResult(
  db: D1Database,
  input: {
    batchId: string;
    jobId: string;
    notification: SyncNotificationEvent;
  },
) {
  const result = await db
    .prepare(
      `UPDATE scheduled_sync_batch_results
       SET connector_id = ?, status = ?, completed_at = ?
       WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL`,
    )
    .bind(
      input.notification.connectorId,
      input.notification.status,
      new Date().toISOString(),
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
  const claim = await db
    .prepare(
      `UPDATE scheduled_sync_batches
       SET notification_claimed_at = ?
       WHERE id = ?
         AND notification_claimed_at IS NULL
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
    .bind(now, batchId, batchId, batchId)
    .run();
  if (claim.meta.changes !== 1) return null;

  const results = await db
    .prepare(
      `SELECT connector_id, status
       FROM scheduled_sync_batch_results
       WHERE batch_id = ? AND status IS NOT NULL
       ORDER BY job_id ASC`,
    )
    .bind(batchId)
    .all<BatchResultRow>();
  return results.results.map((row) => ({
    connectorId: row.connector_id,
    status: row.status,
  }));
}

async function reconcileDefaultScheduleBatchMembers(
  db: D1Database,
  batchId: string,
) {
  const rows = await db
    .prepare(
      `SELECT
         r.job_id,
         j.enabled,
         j.schedule_mode,
         j.last_status,
         j.locked_until,
         j.lock_trigger,
         connector_settings.connector_id AS configured_connector_id
       FROM scheduled_sync_batch_results r
       LEFT JOIN sync_jobs j ON j.id = r.job_id
       LEFT JOIN connector_settings
         ON connector_settings.connector_id = j.connector_id
       WHERE r.batch_id = ? AND r.completed_at IS NULL`,
    )
    .bind(batchId)
    .all<BatchMemberRow>();
  const now = Date.now();

  for (const row of rows.results) {
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
