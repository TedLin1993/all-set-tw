import type {
  SyncJobRow,
  SyncScheduleMode,
  SyncStatus,
  SyncTrigger,
} from "@taiwan-fin-hub/db";
import type { ConnectorId } from "@taiwan-fin-hub/core";

export type DefaultSyncSchedule = {
  intervalMinutes: number;
  preferredTime: string;
  preferredWeekday: number;
  timezone: "Asia/Taipei";
  updatedAt: string;
};

export async function findDefaultSyncSchedule(db: D1Database) {
  return db
    .prepare(
      `SELECT
       interval_minutes AS intervalMinutes,
       preferred_time AS preferredTime,
       preferred_weekday AS preferredWeekday,
       timezone,
       updated_at AS updatedAt
     FROM sync_schedule_settings
     WHERE id = 'default'`,
    )
    .first<DefaultSyncSchedule>();
}

export async function listInheritedSyncJobs(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT id, next_run_at AS nextRunAt
     FROM sync_jobs
     WHERE schedule_mode = 'inherit'`,
    )
    .all<{ id: string; nextRunAt: string }>();
  return rows.results;
}

export async function saveDefaultSyncSchedule(
  db: D1Database,
  input: {
    intervalMinutes: number;
    preferredTime: string;
    preferredWeekday: number;
    updatedAt: string;
    inheritedJobs: Array<{ id: string; nextRunAt: string }>;
  },
) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO sync_schedule_settings (
         id, interval_minutes, preferred_time, preferred_weekday, timezone, updated_at
       ) VALUES ('default', ?, ?, ?, 'Asia/Taipei', ?)
       ON CONFLICT(id) DO UPDATE SET
         interval_minutes = excluded.interval_minutes,
         preferred_time = excluded.preferred_time,
         preferred_weekday = excluded.preferred_weekday,
         timezone = excluded.timezone,
         updated_at = excluded.updated_at`,
      )
      .bind(
        input.intervalMinutes,
        input.preferredTime,
        input.preferredWeekday,
        input.updatedAt,
      ),
    ...input.inheritedJobs.map((job) =>
      db
        .prepare(
          `UPDATE sync_jobs
         SET interval_minutes = ?, preferred_time = ?, preferred_weekday = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
        )
        .bind(
          input.intervalMinutes,
          input.preferredTime,
          input.preferredWeekday,
          job.nextRunAt,
          input.updatedAt,
          job.id,
        ),
    ),
  ]);
}

export async function listSyncJobs(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT
       id,
       connector_id AS connectorId,
       EXISTS (
         SELECT 1
         FROM connector_settings
         WHERE connector_settings.connector_id = sync_jobs.connector_id
       ) AS configured,
       scope,
       enabled,
       interval_minutes AS intervalMinutes,
       next_run_at AS nextRunAt,
       schedule_mode AS scheduleMode,
       preferred_time AS preferredTime,
       preferred_weekday AS preferredWeekday,
       locked_until AS lockedUntil,
       locked_by AS lockedBy,
       lock_trigger AS lockTrigger,
       lock_scope AS lockScope,
       last_run_at AS lastRunAt,
       last_success_at AS lastSuccessAt,
       last_status AS lastStatus,
       last_error AS lastError,
       updated_at AS updatedAt
     FROM sync_jobs
     ORDER BY connector_id ASC, scope ASC`,
    )
    .all<{
      id: string;
      connectorId: ConnectorId;
      configured: number;
      scope: string;
      enabled: number;
      intervalMinutes: number;
      nextRunAt: string;
      scheduleMode: SyncScheduleMode;
      preferredTime: string;
      preferredWeekday: number;
      lockedUntil: string | null;
      lockedBy: string | null;
      lockTrigger: SyncTrigger | null;
      lockScope: string | null;
      lastRunAt: string | null;
      lastSuccessAt: string | null;
      lastStatus: SyncStatus | null;
      lastError: string | null;
      updatedAt: string;
    }>();
  return rows.results;
}

export function findSyncJob(
  db: D1Database,
  connectorId: ConnectorId,
  scope: string,
) {
  return db
    .prepare("SELECT * FROM sync_jobs WHERE connector_id = ? AND scope = ?")
    .bind(connectorId, scope)
    .first<SyncJobRow<ConnectorId>>();
}

export async function updateSyncJob(
  db: D1Database,
  connectorId: ConnectorId,
  scope: string,
  input: {
    enabled: boolean | undefined;
    nextRunAt: string;
    intervalMinutes: number;
    scheduleMode: SyncScheduleMode;
    preferredTime: string;
    preferredWeekday: number;
    updatedAt: string;
  },
) {
  const result = await db
    .prepare(
      `UPDATE sync_jobs
     SET enabled = COALESCE(?, enabled),
         next_run_at = ?,
         interval_minutes = ?,
         schedule_mode = ?,
         preferred_time = ?,
         preferred_weekday = ?,
         updated_at = ?
     WHERE connector_id = ?
       AND scope = ?`,
    )
    .bind(
      input.enabled !== undefined ? (input.enabled ? 1 : 0) : null,
      input.nextRunAt,
      input.intervalMinutes,
      input.scheduleMode,
      input.preferredTime,
      input.preferredWeekday,
      input.updatedAt,
      connectorId,
      scope,
    )
    .run();
  return result.meta.changes === 1;
}
