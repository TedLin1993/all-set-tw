/**
 * Durable state for TDCC's paginated provider work.
 *
 * The repository deliberately only owns run/item state.  The sync service is
 * responsible for mapping a completed item into `sync_write_staging` and for
 * promoting that staging data after every item is done.
 */

export type TdccRunStatus =
  | "queued"
  | "initializing"
  | "processing"
  | "promoting"
  | "completed"
  | "failed"
  | "needs_user_action";

export type TdccRunPhase =
  | "initialize"
  | "snapshot"
  | "positions"
  | "bank"
  | "investments"
  | "trades"
  | "promote"
  | "finalize";

export type TdccRunTrigger = "manual" | "scheduled";
export type TdccRunScope = "all" | "investments" | "bank" | "trades";
export type TdccRunItemStatus = "pending" | "processing" | "done" | "failed";

export type TdccRunRow = {
  id: string;
  connector_id: "tdcc";
  trigger: TdccRunTrigger;
  scope: TdccRunScope;
  sync_job_id: string | null;
  scheduled_batch_id: string | null;
  settings_version: string | null;
  phase: TdccRunPhase;
  status: TdccRunStatus;
  encrypted_config: string | null;
  encrypted_session: string | null;
  session_json: string | null;
  total_item_count: number;
  pending_item_count: number;
  processing_item_count: number;
  done_item_count: number;
  failed_item_count: number;
  session_refresh_count: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
  completed_at: string | null;
};

export type TdccRunItemRow = {
  id: string;
  run_id: string;
  task_type: string;
  task_key: string;
  account_id: string | null;
  page_cursor: string;
  next_page_cursor: string | null;
  page_number: number;
  task_json: string;
  payload_json: string | null;
  status: TdccRunItemStatus;
  attempt_count: number;
  last_error: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CreateTdccRunInput = {
  id?: string;
  trigger: TdccRunTrigger;
  scope?: TdccRunScope;
  syncJobId?: string | null;
  scheduledBatchId?: string | null;
  settingsVersion?: string | null;
  encryptedConfig?: string | null;
  encryptedSession?: string | null;
  session?: unknown;
  phase?: TdccRunPhase;
  now?: string;
};

export type UpsertTdccRunItemInput = {
  id?: string;
  taskType: string;
  taskKey?: string;
  accountId?: string | null;
  pageCursor?: string;
  nextPageCursor?: string | null;
  pageNumber?: number;
  task?: unknown;
  payload?: unknown;
  status?: TdccRunItemStatus;
  lastError?: string | null;
  now?: string;
};

export type UpdateTdccRunItemInput = {
  runId: string;
  itemId?: string;
  taskType?: string;
  taskKey?: string;
  pageCursor?: string;
  claimToken?: string;
  status?: TdccRunItemStatus;
  accountId?: string | null;
  nextPageCursor?: string | null;
  pageNumber?: number;
  task?: unknown;
  payload?: unknown;
  error?: string | null;
  completedAt?: string | null;
  now?: string;
};

export type TdccRunLeaseInput = {
  runId: string;
  owner: string;
  leaseMs: number;
  now?: Date;
};

const ACTIVE_RUN_STATUSES: TdccRunStatus[] = [
  "queued",
  "initializing",
  "processing",
  "promoting",
];

const TERMINAL_RUN_STATUSES: TdccRunStatus[] = [
  "completed",
  "failed",
  "needs_user_action",
];

/** Creates the connector's only active run, or returns the existing one. */
export async function createOrGetActiveTdccRun(
  db: D1Database,
  input: CreateTdccRunInput,
): Promise<{ run: TdccRunRow; created: boolean }> {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? `tdcc:${crypto.randomUUID()}`;
  const scope = input.scope ?? "all";
  try {
    await db
      .prepare(
        `INSERT INTO tdcc_sync_runs (
           id, connector_id, trigger, scope, sync_job_id, scheduled_batch_id,
           settings_version, phase, status, encrypted_config,
           encrypted_session, session_json, created_at, updated_at
         ) VALUES (?, 'tdcc', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.trigger,
        scope,
        input.syncJobId ?? null,
        input.scheduledBatchId ?? null,
        input.settingsVersion ?? null,
        input.phase ?? "initialize",
        input.encryptedConfig ?? null,
        input.encryptedSession ?? null,
        // Never persist a provider token in plaintext. `session` is retained
        // in the input type for callers migrating from an early prototype;
        // callers must provide encryptedSession instead.
        null,
        now,
        now,
      )
      .run();
  } catch (error) {
    const active = await getActiveTdccRun(db);
    if (!active) throw error;
    return { run: active, created: false };
  }
  const run = await getTdccRun(db, id);
  if (!run) throw new Error(`TDCC run ${id} was not found after creation`);
  return { run, created: true };
}

export async function getActiveTdccRun(
  db: D1Database,
): Promise<TdccRunRow | null> {
  return (
    (await db
      .prepare(
        `SELECT * FROM tdcc_sync_runs
         WHERE connector_id = 'tdcc'
           AND status IN ('queued', 'initializing', 'processing', 'promoting')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .first<TdccRunRow>()) ?? null
  );
}

export async function getTdccRun(
  db: D1Database,
  runId: string,
): Promise<TdccRunRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM tdcc_sync_runs WHERE id = ?")
      .bind(runId)
      .first<TdccRunRow>()) ?? null
  );
}

/**
 * Changes a run state with compare-and-set semantics.  Omitting `from` means
 * any active state is accepted, which is useful for an idempotent Queue retry.
 */
export async function transitionTdccRun(
  db: D1Database,
  input: {
    runId: string;
    from?: TdccRunStatus | TdccRunStatus[];
    to: TdccRunStatus;
    phase?: TdccRunPhase;
    error?: string | null;
    now?: string;
  },
) {
  const fromStatuses = input.from
    ? Array.isArray(input.from)
      ? input.from
      : [input.from]
    : ACTIVE_RUN_STATUSES;
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const now = input.now ?? new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET status = ?,
           phase = COALESCE(?, phase),
           last_error = CASE WHEN ? IS NULL THEN last_error ELSE ? END,
           updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .bind(
      input.to,
      input.phase ?? null,
      input.error ?? null,
      input.error ?? null,
      now,
      input.runId,
      ...fromStatuses,
    )
    .run();
  return result.meta.changes === 1;
}

/** Alias matching the e-invoice repository's explicit function name. */
export async function transitionTdccRunStatus(
  db: D1Database,
  input: Parameters<typeof transitionTdccRun>[1],
) {
  return transitionTdccRun(db, input);
}

/** Acquires a run lease; an expired delivery may safely take it over. */
export async function acquireTdccRunLease(
  db: D1Database,
  input: TdccRunLeaseInput,
) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing', 'promoting')
         AND (
           lease_owner IS NULL
           OR lease_expires_at IS NULL
           OR lease_expires_at < ?
         )`,
    )
    .bind(input.owner, expiresAt, nowIso, input.runId, nowIso)
    .run();
  return result.meta.changes === 1;
}

export async function renewTdccRunLease(
  db: D1Database,
  input: TdccRunLeaseInput,
) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing', 'promoting')
         AND lease_owner = ?`,
    )
    .bind(expiresAt, nowIso, input.runId, input.owner)
    .run();
  return result.meta.changes === 1;
}

export async function releaseTdccRunLease(
  db: D1Database,
  input: { runId: string; owner: string; now?: string },
) {
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_owner = ?`,
    )
    .bind(input.now ?? new Date().toISOString(), input.runId, input.owner)
    .run();
  return result.meta.changes === 1;
}

// Keep the terminology used by the e-invoice Queue consumer available to
// callers while using one TDCC run-level lease internally.
export const acquireTdccRunChunkLease = acquireTdccRunLease;
export const renewTdccRunChunkLease = renewTdccRunLease;
export const releaseTdccRunChunkLease = releaseTdccRunLease;

/** Writes encrypted state captured during initialization with a run guard. */
export async function updateTdccRunState(
  db: D1Database,
  input: {
    runId: string;
    settingsVersion?: string | null;
    encryptedConfig?: string | null;
    encryptedSession?: string | null;
    session?: unknown;
    phase?: TdccRunPhase;
    status?: TdccRunStatus;
    now?: string;
  },
) {
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.settingsVersion !== undefined) {
    assignments.push("settings_version = ?");
    values.push(input.settingsVersion);
  }
  if (input.encryptedConfig !== undefined) {
    assignments.push("encrypted_config = ?");
    values.push(input.encryptedConfig);
  }
  if (input.encryptedSession !== undefined) {
    assignments.push("encrypted_session = ?");
    values.push(input.encryptedSession);
  }
  // `session` is intentionally not written: TDCC session tokens are secrets.
  // Keep the optional input for source compatibility with the initialization
  // helper; encryptedSession is the only persisted representation.
  if (input.phase !== undefined) {
    assignments.push("phase = ?");
    values.push(input.phase);
  }
  if (input.status !== undefined) {
    assignments.push("status = ?");
    values.push(input.status);
  }
  if (assignments.length === 0) return false;
  const now = input.now ?? new Date().toISOString();
  assignments.push("updated_at = ?");
  values.push(now, input.runId);
  const result = await db
    .prepare(`UPDATE tdcc_sync_runs SET ${assignments.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  return result.meta.changes === 1;
}

export const updateTdccRunSession = updateTdccRunState;

/** Bounds automatic session rebuilds so an expired TDCC session cannot loop. */
export async function claimTdccRunSessionRefresh(
  db: D1Database,
  input: { runId: string; maxRefreshes?: number; now?: string },
) {
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET session_refresh_count = session_refresh_count + 1, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing', 'promoting')
         AND session_refresh_count < ?`,
    )
    .bind(
      input.now ?? new Date().toISOString(),
      input.runId,
      Math.max(1, Math.floor(input.maxRefreshes ?? 1)),
    )
    .run();
  return result.meta.changes === 1;
}

/** Adds or refreshes a page item without resetting a claimed/completed item. */
export async function upsertTdccRunItem(
  db: D1Database,
  runId: string,
  input: UpsertTdccRunItemInput,
): Promise<TdccRunItemRow> {
  const now = input.now ?? new Date().toISOString();
  const taskKey = input.taskKey ?? "";
  const pageCursor = input.pageCursor ?? "";
  const id =
    input.id ??
    `${runId}:${input.taskType}:${taskKey}:${pageCursor || "first"}`;
  const taskJson = json(input.task ?? {});
  const payloadJson = input.payload === undefined ? null : json(input.payload);
  const status = input.status ?? "pending";
  await db
    .prepare(
      `INSERT INTO tdcc_sync_run_items (
         id, run_id, task_type, task_key, account_id, page_cursor,
         next_page_cursor, page_number, task_json, payload_json, status,
         last_error, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, task_type, task_key, page_cursor) DO UPDATE SET
         account_id = COALESCE(excluded.account_id, tdcc_sync_run_items.account_id),
         next_page_cursor = COALESCE(
           excluded.next_page_cursor, tdcc_sync_run_items.next_page_cursor
         ),
         page_number = excluded.page_number,
         task_json = CASE
           WHEN tdcc_sync_run_items.status IN ('processing', 'done')
             THEN tdcc_sync_run_items.task_json
           ELSE excluded.task_json
         END,
         payload_json = CASE
           WHEN tdcc_sync_run_items.status = 'done'
             THEN tdcc_sync_run_items.payload_json
           ELSE COALESCE(excluded.payload_json, tdcc_sync_run_items.payload_json)
         END,
         status = CASE
           WHEN tdcc_sync_run_items.status IN ('processing', 'done')
             THEN tdcc_sync_run_items.status
           ELSE excluded.status
         END,
         last_error = CASE
           WHEN excluded.status = 'pending' THEN excluded.last_error
           ELSE tdcc_sync_run_items.last_error
         END,
         completed_at = CASE
           WHEN tdcc_sync_run_items.status = 'done'
             THEN tdcc_sync_run_items.completed_at
           WHEN excluded.status = 'done' THEN excluded.completed_at
           ELSE NULL
         END,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      runId,
      input.taskType,
      taskKey,
      input.accountId ?? null,
      pageCursor,
      input.nextPageCursor ?? null,
      Math.max(0, Math.floor(input.pageNumber ?? 0)),
      taskJson,
      payloadJson,
      status,
      input.lastError ?? null,
      now,
      now,
      status === "done" ? now : null,
    )
    .run();
  await refreshTdccRunCounts(db, runId, now);
  const item = await getTdccRunItem(db, runId, id, input);
  if (!item) throw new Error(`TDCC run item ${id} was not found after upsert`);
  return item;
}

export async function insertTdccRunItem(
  db: D1Database,
  runId: string,
  input: UpsertTdccRunItemInput,
) {
  return upsertTdccRunItem(db, runId, input);
}

/** Inserts the next provider page; repeated Queue deliveries are idempotent. */
export async function insertNextTdccRunItem(
  db: D1Database,
  runId: string,
  input: UpsertTdccRunItemInput,
) {
  return upsertTdccRunItem(db, runId, input);
}

export async function getTdccRunItem(
  db: D1Database,
  runId: string,
  itemId: string,
  identity?: Pick<
    UpsertTdccRunItemInput,
    "taskType" | "taskKey" | "pageCursor"
  >,
) {
  const clause = identity
    ? " AND task_type = ? AND task_key = ? AND page_cursor = ?"
    : "";
  const bindings: unknown[] = [runId, itemId];
  if (identity) {
    bindings.push(
      identity.taskType,
      identity.taskKey ?? "",
      identity.pageCursor ?? "",
    );
  }
  return (
    (await db
      .prepare(
        `SELECT * FROM tdcc_sync_run_items
         WHERE run_id = ? AND id = ?${clause}`,
      )
      .bind(...bindings)
      .first<TdccRunItemRow>()) ?? null
  );
}

/** Claims a bounded page set using an owner-scoped rolling lease. */
export async function claimTdccRunItems(
  db: D1Database,
  input: {
    runId: string;
    claimToken?: string;
    limit?: number;
    leaseMs: number;
    taskType?: string;
    now?: Date;
  },
): Promise<TdccRunItemRow[]> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const claimToken = input.claimToken ?? crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const limit = Math.max(1, Math.floor(input.limit ?? 1));
  const taskTypeClause = input.taskType ? " AND task_type = ?" : "";
  const taskTypeBindings = input.taskType ? [input.taskType] : [];
  await db.batch([
    db
      .prepare(
        `UPDATE tdcc_sync_run_items
         SET status = 'processing',
             lease_token = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1,
             last_error = NULL, updated_at = ?
         WHERE id IN (
           SELECT id FROM tdcc_sync_run_items
           WHERE run_id = ?${taskTypeClause}
             AND (
               status = 'pending'
               OR (status = 'processing' AND (
                 lease_expires_at IS NULL OR lease_expires_at < ?
               ))
             )
           ORDER BY created_at ASC, task_type ASC, task_key ASC, page_number ASC
           LIMIT ?
         )`,
      )
      .bind(
        claimToken,
        leaseExpiresAt,
        nowIso,
        input.runId,
        ...taskTypeBindings,
        nowIso,
        limit,
      ),
    refreshTdccRunCountsStatement(db, input.runId, nowIso),
  ]);
  return (
    await db
      .prepare(
        `SELECT * FROM tdcc_sync_run_items
         WHERE run_id = ? AND lease_token = ? AND status = 'processing'
         ORDER BY created_at ASC, task_type ASC, task_key ASC, page_number ASC`,
      )
      .bind(input.runId, claimToken)
      .all<TdccRunItemRow>()
  ).results;
}

/** Generic CAS item update for a page worker. */
export async function updateTdccRunItem(
  db: D1Database,
  input: UpdateTdccRunItemInput,
) {
  if (
    input.itemId === undefined &&
    input.taskType === undefined &&
    input.taskKey === undefined &&
    input.pageCursor === undefined
  ) {
    return false;
  }
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (input.status !== undefined) {
    assignments.push("status = ?");
    values.push(input.status);
    if (input.status === "done") {
      assignments.push(
        "lease_token = NULL",
        "lease_expires_at = NULL",
        "last_error = NULL",
      );
      if (input.completedAt === undefined) {
        assignments.push("completed_at = ?");
        values.push(input.now ?? new Date().toISOString());
      }
    } else if (input.status !== "processing") {
      assignments.push("lease_token = NULL", "lease_expires_at = NULL");
    }
  }
  if (input.accountId !== undefined) {
    assignments.push("account_id = ?");
    values.push(input.accountId);
  }
  if (input.nextPageCursor !== undefined) {
    assignments.push("next_page_cursor = ?");
    values.push(input.nextPageCursor);
  }
  if (input.pageNumber !== undefined) {
    assignments.push("page_number = ?");
    values.push(Math.max(0, Math.floor(input.pageNumber)));
  }
  if (input.task !== undefined) {
    assignments.push("task_json = ?");
    values.push(json(input.task));
  }
  if (input.payload !== undefined) {
    assignments.push("payload_json = ?");
    values.push(json(input.payload));
  }
  if (input.error !== undefined) {
    assignments.push("last_error = ?");
    values.push(input.error);
  }
  if (input.completedAt !== undefined) {
    assignments.push("completed_at = ?");
    values.push(input.completedAt);
  }
  if (assignments.length === 0) return false;
  const now = input.now ?? new Date().toISOString();
  assignments.push("updated_at = ?");
  values.push(now, input.runId);
  const where: string[] = ["run_id = ?"];
  if (input.itemId !== undefined) {
    where.push("id = ?");
    values.push(input.itemId);
  }
  if (input.taskType !== undefined) {
    where.push("task_type = ?");
    values.push(input.taskType);
  }
  if (input.taskKey !== undefined) {
    where.push("task_key = ?");
    values.push(input.taskKey);
  }
  if (input.pageCursor !== undefined) {
    where.push("page_cursor = ?");
    values.push(input.pageCursor);
  }
  if (input.claimToken !== undefined) {
    where.push("status = 'processing'");
    where.push("lease_token = ?");
    values.push(input.claimToken);
  }
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_run_items SET ${assignments.join(", ")}
       WHERE ${where.join(" AND ")}`,
    )
    .bind(...values)
    .run();
  await refreshTdccRunCounts(db, input.runId, now);
  return result.meta.changes === 1;
}

/** Completes a claimed page; a stale delivery cannot overwrite a new lease. */
export async function markTdccRunItemSucceeded(
  db: D1Database,
  input: {
    runId: string;
    itemId: string;
    claimToken: string;
    payload?: unknown;
    nextPageCursor?: string | null;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const nextCursorExpression =
    input.nextPageCursor === undefined ? "next_page_cursor" : "?";
  const nextCursorBindings =
    input.nextPageCursor === undefined ? [] : [input.nextPageCursor];
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_run_items
       SET payload_json = CASE
             WHEN ? IS NULL THEN payload_json ELSE ? END,
           next_page_cursor = ${nextCursorExpression},
           status = 'done', lease_token = NULL, lease_expires_at = NULL,
           last_error = NULL, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND id = ?
         AND status = 'processing' AND lease_token = ?`,
    )
    .bind(
      input.payload === undefined ? null : json(input.payload),
      input.payload === undefined ? null : json(input.payload),
      ...nextCursorBindings,
      now,
      now,
      input.runId,
      input.itemId,
      input.claimToken,
    )
    .run();
  await refreshTdccRunCounts(db, input.runId, now);
  return result.meta.changes === 1;
}

/** Releases a claimed page for Queue retry while retaining the error. */
export async function releaseTdccRunItemForRetry(
  db: D1Database,
  input: {
    runId: string;
    itemId: string;
    claimToken: string;
    error: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_run_items
       SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
           last_error = ?, updated_at = ?
       WHERE run_id = ? AND id = ?
         AND status = 'processing' AND lease_token = ?`,
    )
    .bind(input.error, now, input.runId, input.itemId, input.claimToken)
    .run();
  await refreshTdccRunCounts(db, input.runId, now);
  return result.meta.changes === 1;
}

export const releaseTdccRunItem = releaseTdccRunItemForRetry;

/** Terminal run transition. Completion is allowed only when every item is done. */
export async function finalizeTdccRun(
  db: D1Database,
  input: {
    runId: string;
    status: Extract<
      TdccRunStatus,
      "completed" | "failed" | "needs_user_action"
    >;
    error?: string | null;
    phase?: TdccRunPhase;
    promotedAt?: string | null;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET status = ?,
           phase = COALESCE(?, phase),
           last_error = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           promoted_at = COALESCE(?, promoted_at),
           completed_at = ?,
           updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing', 'promoting')
         AND (
           ? != 'completed'
           OR NOT EXISTS (
             SELECT 1 FROM tdcc_sync_run_items
             WHERE run_id = tdcc_sync_runs.id AND status != 'done'
           )
         )`,
    )
    .bind(
      input.status,
      input.phase ?? null,
      input.error ?? null,
      input.promotedAt ?? null,
      now,
      now,
      input.runId,
      input.status,
    )
    .run();
  return result.meta.changes === 1;
}

export async function listPendingTdccRunItems(db: D1Database, runId: string) {
  return (
    await db
      .prepare(
        `SELECT * FROM tdcc_sync_run_items
         WHERE run_id = ? AND status != 'done'
         ORDER BY created_at ASC, task_type ASC, task_key ASC, page_number ASC`,
      )
      .bind(runId)
      .all<TdccRunItemRow>()
  ).results;
}

export async function listCompletedTdccRunItems(db: D1Database, runId: string) {
  return (
    await db
      .prepare(
        `SELECT * FROM tdcc_sync_run_items
         WHERE run_id = ? AND status = 'done'
         ORDER BY created_at ASC, task_type ASC, task_key ASC, page_number ASC`,
      )
      .bind(runId)
      .all<TdccRunItemRow>()
  ).results;
}

function refreshTdccRunCountsStatement(
  db: D1Database,
  runId: string,
  now: string,
) {
  return db
    .prepare(
      `UPDATE tdcc_sync_runs
       SET total_item_count = (
             SELECT COUNT(*) FROM tdcc_sync_run_items WHERE run_id = ?
           ),
           pending_item_count = (
             SELECT COUNT(*) FROM tdcc_sync_run_items
             WHERE run_id = ? AND status = 'pending'
           ),
           processing_item_count = (
             SELECT COUNT(*) FROM tdcc_sync_run_items
             WHERE run_id = ? AND status = 'processing'
           ),
           done_item_count = (
             SELECT COUNT(*) FROM tdcc_sync_run_items
             WHERE run_id = ? AND status = 'done'
           ),
           failed_item_count = (
             SELECT COUNT(*) FROM tdcc_sync_run_items
             WHERE run_id = ? AND status = 'failed'
           ),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(runId, runId, runId, runId, runId, now, runId);
}

async function refreshTdccRunCounts(
  db: D1Database,
  runId: string,
  now: string,
) {
  await refreshTdccRunCountsStatement(db, runId, now).run();
}

function json(value: unknown) {
  return JSON.stringify(value) ?? "null";
}

export { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES };
