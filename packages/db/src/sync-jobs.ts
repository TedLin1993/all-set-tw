import {
  and,
  asc,
  eq,
  exists,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createDrizzle } from "./client";
import { sanitizeDatabaseError } from "./errors";
import { syncJobs, connectorSettings } from "./schema";

export type SyncTrigger = "manual" | "scheduled";
export type SyncStatus = "success" | "failed" | "needs_user_action";
export type SyncScheduleMode = "inherit" | "custom";

export interface SyncJobRow<TConnectorId extends string = string> {
  id: string;
  connector_id: TConnectorId;
  scope: string;
  enabled: number;
  interval_minutes: number;
  next_run_at: string;
  schedule_mode: SyncScheduleMode;
  preferred_time: string;
  preferred_weekday: number;
  locked_until: string | null;
  locked_by: string | null;
  lock_trigger: SyncTrigger | null;
  lock_scope: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: SyncStatus | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const syncJobConfiguredJoin = eq(
  connectorSettings.connectorId,
  syncJobs.connectorId,
);

export const syncJobConfiguredSelection = sql<number>`CASE WHEN ${connectorSettings.connectorId} IS NOT NULL THEN 1 ELSE 0 END`;

export function hasConnectorSettings(db: ReturnType<typeof createDrizzle>) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(connectorSettings)
      .where(syncJobConfiguredJoin),
  );
}

export const syncJobSelection = {
  id: sql<SyncJobRow["id"]>`${syncJobs.id}`,
  connector_id: sql<SyncJobRow["connector_id"]>`${syncJobs.connectorId}`,
  scope: syncJobs.scope,
  enabled: syncJobs.enabled,
  interval_minutes: syncJobs.intervalMinutes,
  next_run_at: syncJobs.nextRunAt,
  schedule_mode: sql<SyncJobRow["schedule_mode"]>`${syncJobs.scheduleMode}`,
  preferred_time: syncJobs.preferredTime,
  preferred_weekday: syncJobs.preferredWeekday,
  locked_until: syncJobs.lockedUntil,
  locked_by: syncJobs.lockedBy,
  lock_trigger: sql<SyncJobRow["lock_trigger"]>`${syncJobs.lockTrigger}`,
  lock_scope: syncJobs.lockScope,
  last_run_at: syncJobs.lastRunAt,
  last_success_at: syncJobs.lastSuccessAt,
  last_status: sql<SyncJobRow["last_status"]>`${syncJobs.lastStatus}`,
  last_error: syncJobs.lastError,
  created_at: syncJobs.createdAt,
  updated_at: syncJobs.updatedAt,
};

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function nextSyncRunAt(
  intervalMinutes: number,
  preferredTime: string,
  now = new Date(),
  _anchor?: string,
  preferredWeekday = 1,
) {
  if (intervalMinutes < 1440) {
    return new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
  }

  const match = /^(\d{2}):(\d{2})$/.exec(preferredTime);
  if (!match)
    return new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
  }

  const taipeiNow = new Date(now.getTime() + TAIPEI_OFFSET_MS);
  let candidate =
    Date.UTC(
      taipeiNow.getUTCFullYear(),
      taipeiNow.getUTCMonth(),
      taipeiNow.getUTCDate(),
      hours,
      minutes,
    ) - TAIPEI_OFFSET_MS;

  if (intervalMinutes === 10080) {
    const safeWeekday = Number.isInteger(preferredWeekday)
      ? Math.min(6, Math.max(0, preferredWeekday))
      : 1;
    const daysAhead = (safeWeekday - taipeiNow.getUTCDay() + 7) % 7;
    candidate += daysAhead * 86_400_000;
    if (candidate <= now.getTime()) candidate += 7 * 86_400_000;
  } else if (candidate <= now.getTime()) {
    candidate += 86_400_000;
  }
  return new Date(candidate).toISOString();
}

export async function findNextDueSyncJob<TConnectorId extends string>(
  db: D1Database,
  now = new Date(),
  scheduleMode?: SyncScheduleMode,
) {
  const row = await createDrizzle(db)
    .select(syncJobSelection)
    .from(syncJobs)
    .where(
      and(
        eq(syncJobs.enabled, 1),
        hasConnectorSettings(createDrizzle(db)),
        or(
          isNull(syncJobs.lastStatus),
          ne(syncJobs.lastStatus, "needs_user_action"),
        ),
        lte(syncJobs.nextRunAt, now.toISOString()),
        or(
          isNull(syncJobs.lockedUntil),
          lt(syncJobs.lockedUntil, now.toISOString()),
        ),
        scheduleMode === undefined
          ? undefined
          : eq(syncJobs.scheduleMode, scheduleMode),
      ),
    )
    .orderBy(asc(syncJobs.nextRunAt), asc(syncJobs.id))
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return (row as SyncJobRow<TConnectorId> | undefined) ?? null;
}

export async function acquireSyncJobLock(
  db: D1Database,
  input: {
    lockRowId: string;
    scope: string;
    trigger: SyncTrigger;
    runId: string;
    leaseMs: number;
  },
) {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + input.leaseMs).toISOString();
  const result = await createDrizzle(db)
    .update(syncJobs)
    .set({
      lockedBy: input.runId,
      lockedUntil,
      lockTrigger: input.trigger,
      lockScope: input.scope,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(syncJobs.id, input.lockRowId),
        or(
          isNull(syncJobs.lockedUntil),
          lt(syncJobs.lockedUntil, now.toISOString()),
        ),
      ),
    )
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return result.meta.changes === 1;
}

export async function renewSyncJobLock(
  db: D1Database,
  input: { lockRowId: string; runId: string; leaseMs: number },
) {
  const now = new Date();
  const result = await createDrizzle(db)
    .update(syncJobs)
    .set({
      lockedUntil: new Date(now.getTime() + input.leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(eq(syncJobs.id, input.lockRowId), eq(syncJobs.lockedBy, input.runId)),
    )
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return result.meta.changes === 1;
}

export async function releaseSyncJobLock(
  db: D1Database,
  lockRowId: string,
  runId: string,
) {
  await createDrizzle(db)
    .update(syncJobs)
    .set({
      lockedBy: null,
      lockedUntil: null,
      lockTrigger: null,
      lockScope: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(syncJobs.id, lockRowId), eq(syncJobs.lockedBy, runId)))
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}

export async function completeSyncJob(db: D1Database, job: SyncJobRow) {
  const now = new Date();
  const nextRunAt = nextSyncRunAt(
    job.interval_minutes,
    job.preferred_time,
    now,
    job.next_run_at,
    job.preferred_weekday,
  );
  await createDrizzle(db)
    .update(syncJobs)
    .set({
      lastStatus: "success",
      lastError: null,
      lastRunAt: now.toISOString(),
      lastSuccessAt: now.toISOString(),
      nextRunAt,
      updatedAt: now.toISOString(),
    })
    .where(eq(syncJobs.id, job.id))
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}

export async function failSyncJob(
  db: D1Database,
  job: SyncJobRow,
  input: { status: SyncStatus; errorMessage: string },
) {
  const now = new Date();
  const nextRunAt =
    input.status === "failed"
      ? nextSyncRunAt(
          job.interval_minutes,
          job.preferred_time,
          now,
          job.next_run_at,
          job.preferred_weekday,
        )
      : job.next_run_at;
  await createDrizzle(db)
    .update(syncJobs)
    .set({
      lastStatus: input.status,
      lastError: input.errorMessage,
      lastRunAt: now.toISOString(),
      nextRunAt,
      updatedAt: now.toISOString(),
    })
    .where(eq(syncJobs.id, job.id))
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}

export async function markManualSyncSuccess(
  db: D1Database,
  connectorId: string,
  scope: string,
) {
  const jobId = `${connectorId}:${scope}`;
  const job = await createDrizzle(db)
    .select(syncJobSelection)
    .from(syncJobs)
    .where(eq(syncJobs.id, jobId))
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  if (!job) return;

  await completeSyncJob(db, job);
}

export async function markManualSyncFailure(
  db: D1Database,
  connectorId: string,
  scope: string,
  input: { status: SyncStatus; errorMessage: string },
) {
  const now = new Date().toISOString();
  await createDrizzle(db)
    .update(syncJobs)
    .set({
      lastStatus: input.status,
      lastError: input.errorMessage,
      lastRunAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(syncJobs.connectorId, connectorId), eq(syncJobs.scope, scope)),
    )
    .run()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
}
