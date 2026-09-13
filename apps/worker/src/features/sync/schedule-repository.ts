import {
  createDrizzle,
  sanitizeDatabaseError,
  syncJobs,
  syncScheduleSettings,
  connectorSettings,
  syncJobConfiguredJoin,
  syncJobConfiguredSelection,
  syncJobSelection,
} from "@taiwan-fin-hub/db";
import { and, asc, eq, sql } from "drizzle-orm";
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
  return (
    (await createDrizzle(db)
      .select({
        intervalMinutes: syncScheduleSettings.intervalMinutes,
        preferredTime: syncScheduleSettings.preferredTime,
        preferredWeekday: syncScheduleSettings.preferredWeekday,
        timezone: sql<
          DefaultSyncSchedule["timezone"]
        >`${syncScheduleSettings.timezone}`,
        updatedAt: syncScheduleSettings.updatedAt,
      })
      .from(syncScheduleSettings)
      .where(eq(syncScheduleSettings.id, "default"))
      .limit(1)
      .get()
      .catch((error) => {
        throw sanitizeDatabaseError(error);
      })) ?? null
  );
}

export async function listInheritedSyncJobs(db: D1Database) {
  return createDrizzle(db)
    .select({ id: syncJobs.id, nextRunAt: syncJobs.nextRunAt })
    .from(syncJobs)
    .where(eq(syncJobs.scheduleMode, "inherit"))
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
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
  return createDrizzle(db)
    .select({
      id: syncJobs.id,
      connectorId: sql<ConnectorId>`${syncJobs.connectorId}`,
      configured: syncJobConfiguredSelection,
      scope: syncJobs.scope,
      enabled: syncJobs.enabled,
      intervalMinutes: syncJobs.intervalMinutes,
      nextRunAt: syncJobs.nextRunAt,
      scheduleMode: sql<SyncScheduleMode>`${syncJobs.scheduleMode}`,
      preferredTime: syncJobs.preferredTime,
      preferredWeekday: syncJobs.preferredWeekday,
      lockedUntil: syncJobs.lockedUntil,
      lockedBy: syncJobs.lockedBy,
      lockTrigger: sql<SyncTrigger | null>`${syncJobs.lockTrigger}`,
      lockScope: syncJobs.lockScope,
      lastRunAt: syncJobs.lastRunAt,
      lastSuccessAt: syncJobs.lastSuccessAt,
      lastStatus: sql<SyncStatus | null>`${syncJobs.lastStatus}`,
      lastError: syncJobs.lastError,
      updatedAt: syncJobs.updatedAt,
    })
    .from(syncJobs)
    .leftJoin(connectorSettings, syncJobConfiguredJoin)
    .orderBy(asc(syncJobs.connectorId), asc(syncJobs.scope))
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}

export async function findSyncJob(
  db: D1Database,
  connectorId: ConnectorId,
  scope: string,
) {
  const row = await createDrizzle(db)
    .select(syncJobSelection)
    .from(syncJobs)
    .where(
      and(eq(syncJobs.connectorId, connectorId), eq(syncJobs.scope, scope)),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return (row as SyncJobRow<ConnectorId> | undefined) ?? null;
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
