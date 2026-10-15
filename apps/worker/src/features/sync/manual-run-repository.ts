import type { ConnectorId, SyncErrorCode } from "@taiwan-fin-hub/shared";
import { and, eq, lte, sql } from "drizzle-orm";
import { createDrizzle, manualSyncRuns, sanitizeDatabaseError } from "../../db";
import { canonicalSyncLockRowId } from "./lock";

export type ManualSyncRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "needs_user_action"
  | "cancelled";

export type ManualSyncRunRow = {
  id: string;
  connectorId: ConnectorId;
  scope: string;
  status: ManualSyncRunStatus;
  errorCode: SyncErrorCode | null;
  lastError: string | null;
  retryCount: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
};

const runSelection = {
  id: manualSyncRuns.id,
  connectorId: sql<ConnectorId>`${manualSyncRuns.connectorId}`,
  scope: manualSyncRuns.scope,
  status: sql<ManualSyncRunStatus>`${manualSyncRuns.status}`,
  errorCode: sql<SyncErrorCode | null>`${manualSyncRuns.errorCode}`,
  lastError: manualSyncRuns.lastError,
  retryCount: manualSyncRuns.retryCount,
  createdAt: manualSyncRuns.createdAt,
  startedAt: manualSyncRuns.startedAt,
  updatedAt: manualSyncRuns.updatedAt,
  completedAt: manualSyncRuns.completedAt,
};

function rethrow(error: unknown): never {
  throw sanitizeDatabaseError(error);
}

function holdsConnectorLock(now: string) {
  return sql`EXISTS (SELECT 1 FROM sync_jobs AS lock_owner
    WHERE lock_owner.locked_by = manual_sync_runs.id AND lock_owner.locked_until > ${now})`;
}

export type CreateManualSyncRunResult =
  | { status: "created" | "existing"; run: ManualSyncRunRow }
  | { status: "connector_busy" };

/**
 * 已有背景手動 run 時回傳該 run；其他同步持有 connector lock 時不建立，
 * 讓排程與手動同步不在同一來源排隊。
 */
export async function createOrGetActiveManualSyncRun(
  db: D1Database,
  input: {
    connectorId: ConnectorId;
    scope: string;
    id?: string;
    now?: string;
  },
): Promise<CreateManualSyncRunResult> {
  const active = await getActiveManualSyncRun(db, input.connectorId);
  if (active) return { status: "existing", run: active };

  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO manual_sync_runs (id, connector_id, scope, status, created_at, updated_at)
       SELECT ?, ?, ?, 'queued', ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM sync_jobs
         WHERE id = ? AND locked_by IS NOT NULL AND locked_until >= ?
       )
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      id,
      input.connectorId,
      input.scope,
      now,
      now,
      canonicalSyncLockRowId(input.connectorId),
      now,
    )
    .run()
    .catch(rethrow);
  if (result.meta.changes === 1)
    return { status: "created", run: (await getManualSyncRun(db, id))! };
  const existing = await getActiveManualSyncRun(db, input.connectorId);
  return existing
    ? { status: "existing", run: existing }
    : { status: "connector_busy" };
}

export async function getManualSyncRun(db: D1Database, id: string) {
  return ((await createDrizzle(db)
    .select(runSelection)
    .from(manualSyncRuns)
    .where(eq(manualSyncRuns.id, id))
    .get()
    .catch(rethrow)) ?? null) as ManualSyncRunRow | null;
}

export async function getActiveManualSyncRun(
  db: D1Database,
  connectorId: ConnectorId,
) {
  return ((await createDrizzle(db)
    .select(runSelection)
    .from(manualSyncRuns)
    .where(
      and(
        eq(manualSyncRuns.connectorId, connectorId),
        sql`${manualSyncRuns.status} IN ('queued', 'running')`,
      ),
    )
    .get()
    .catch(rethrow)) ?? null) as ManualSyncRunRow | null;
}

/** 每個來源最近一次背景手動同步，供狀態 API 判斷排隊中與結果。 */
export async function listLatestManualSyncRuns(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT id, connector_id AS connectorId, scope, status,
              error_code AS errorCode, last_error AS lastError,
              retry_count AS retryCount, created_at AS createdAt,
              started_at AS startedAt, updated_at AS updatedAt,
              completed_at AS completedAt
       FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY connector_id ORDER BY created_at DESC, id DESC
         ) AS rank
         FROM manual_sync_runs
       )
       WHERE rank = 1`,
    )
    .all<ManualSyncRunRow>()
    .catch(rethrow);
  return results;
}

export async function deleteFinishedManualSyncRuns(
  db: D1Database,
  completedBefore: string,
) {
  await createDrizzle(db)
    .delete(manualSyncRuns)
    .where(lte(manualSyncRuns.completedAt, completedBefore))
    .run()
    .catch(rethrow);
}

/** 只有已取得 connector lock 的 queued run 才能開始；重送的訊息會在此失敗。 */
export async function claimManualSyncRun(db: D1Database, id: string) {
  const now = new Date().toISOString();
  const result = await createDrizzle(db)
    .update(manualSyncRuns)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(
      and(
        eq(manualSyncRuns.id, id),
        eq(manualSyncRuns.status, "queued"),
        holdsConnectorLock(now),
      ),
    )
    .run()
    .catch(rethrow);
  return result.meta.changes === 1;
}

/** Browser 容量不足時在登入前放回佇列，不計入同步失敗。 */
export async function requeueManualSyncRun(db: D1Database, id: string) {
  const now = new Date().toISOString();
  const result = await createDrizzle(db)
    .update(manualSyncRuns)
    .set({
      status: "queued",
      startedAt: null,
      retryCount: sql`${manualSyncRuns.retryCount} + 1`,
      updatedAt: now,
    })
    .where(and(eq(manualSyncRuns.id, id), eq(manualSyncRuns.status, "running")))
    .run()
    .catch(rethrow);
  return result.meta.changes === 1;
}

export async function finishManualSyncRun(
  db: D1Database,
  id: string,
  input:
    | { status: "completed" }
    | {
        status: "failed" | "needs_user_action";
        errorCode: SyncErrorCode;
        lastError: string;
      },
) {
  const now = new Date().toISOString();
  const result = await createDrizzle(db)
    .update(manualSyncRuns)
    .set({
      status: input.status,
      errorCode: input.status === "completed" ? null : input.errorCode,
      lastError: input.status === "completed" ? null : input.lastError,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(manualSyncRuns.id, id), eq(manualSyncRuns.status, "running")))
    .run()
    .catch(rethrow);
  return result.meta.changes === 1;
}

/**
 * 尚未開始的 run 結案；用於排隊逾時、enqueue 失敗或來源已被其他同步占用。
 * 容量重試放回 queued 後、釋放自己的 lock 前，重送訊息不得結案此 run。
 */
export async function closeQueuedManualSyncRun(
  db: D1Database,
  id: string,
  input: {
    status: "failed" | "cancelled";
    errorCode: SyncErrorCode;
    lastError: string;
  },
) {
  const now = new Date().toISOString();
  const result = await createDrizzle(db)
    .update(manualSyncRuns)
    .set({ ...input, completedAt: now, updatedAt: now })
    .where(
      and(
        eq(manualSyncRuns.id, id),
        eq(manualSyncRuns.status, "queued"),
        sql`NOT ${holdsConnectorLock(now)}`,
      ),
    )
    .run()
    .catch(rethrow);
  return result.meta.changes === 1;
}

export async function expireQueuedManualSyncRuns(
  db: D1Database,
  input: {
    createdBefore: string;
    errorCode: SyncErrorCode;
    lastError: string;
  },
) {
  const now = new Date().toISOString();
  await createDrizzle(db)
    .update(manualSyncRuns)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      lastError: input.lastError,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(manualSyncRuns.status, "queued"),
        lte(manualSyncRuns.createdAt, input.createdBefore),
        sql`NOT ${holdsConnectorLock(now)}`,
      ),
    )
    .run()
    .catch(rethrow);
}

/** Invocation 中斷後 connector lock 會停止續租；沒有有效 lock 的 running run 視為中斷。 */
export async function failInterruptedManualSyncRuns(
  db: D1Database,
  input: { errorCode: SyncErrorCode; lastError: string },
) {
  const now = new Date().toISOString();
  await createDrizzle(db)
    .update(manualSyncRuns)
    .set({
      status: "failed",
      errorCode: input.errorCode,
      lastError: input.lastError,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(manualSyncRuns.status, "running"),
        sql`NOT ${holdsConnectorLock(now)}`,
      ),
    )
    .run()
    .catch(rethrow);
}
