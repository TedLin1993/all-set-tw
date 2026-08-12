export type EinvoiceRunStatus =
  | "queued"
  | "initializing"
  | "processing"
  | "completed"
  | "failed"
  | "needs_user_action";

export type EinvoiceRunTrigger = "manual" | "scheduled";
export type EinvoiceRunItemStatus = "pending" | "processing" | "done";

export type EinvoiceRunRow = {
  id: string;
  connector_id: "einvoice";
  trigger: EinvoiceRunTrigger;
  sync_job_id: string | null;
  scheduled_batch_id: string | null;
  settings_version: string | null;
  status: EinvoiceRunStatus;
  total_item_count: number;
  pending_item_count: number;
  processing_item_count: number;
  done_item_count: number;
  line_item_count: number;
  new_invoice_count: number;
  session_refresh_count: number;
  last_error: string | null;
  chunk_lease_owner: string | null;
  chunk_lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
  completed_at: string | null;
};

export type EinvoiceRunItemRow = {
  id: string;
  run_id: string;
  invoice_source_id: string;
  header_json: string;
  normalized_invoice_json: string;
  detail_key: string | null;
  detail_metadata_json: string | null;
  detail_items_json: string | null;
  line_item_count: number;
  status: EinvoiceRunItemStatus;
  attempt_count: number;
  last_error: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type CreateEinvoiceRunInput = {
  id?: string;
  trigger: EinvoiceRunTrigger;
  syncJobId?: string | null;
  scheduledBatchId?: string | null;
  now?: string;
};

export type MergeEinvoiceRunItemInput = {
  invoiceSourceId: string;
  /** The provider's list/header payload, retained for retry-safe detail work. */
  header: unknown;
  /** The normalized Invoice record to promote only after this run is complete. */
  normalizedInvoice: unknown;
  detailKey?: string | null;
  detailMetadata?: unknown;
  /** Supplying this (including []) means detail work already completed. */
  detailItems?: unknown[];
};

const ACTIVE_RUN_STATUSES: EinvoiceRunStatus[] = [
  "queued",
  "initializing",
  "processing",
];

const TERMINAL_RUN_STATUSES: EinvoiceRunStatus[] = [
  "completed",
  "failed",
  "needs_user_action",
];

/**
 * Creates the connector's only active run, or returns the concurrent active
 * one unchanged. Callers must use `created` to decide whether they own enqueue
 * compensation; a retry must never rewrite another trigger's job or batch.
 */
export async function createOrGetActiveEinvoiceRun(
  db: D1Database,
  input: CreateEinvoiceRunInput,
): Promise<{ run: EinvoiceRunRow; created: boolean }> {
  const now = input.now ?? new Date().toISOString();
  const id = input.id ?? `einvoice:${crypto.randomUUID()}`;
  try {
    await db
      .prepare(
        `INSERT INTO einvoice_sync_runs (
           id, connector_id, trigger, sync_job_id, scheduled_batch_id, status,
           created_at, updated_at
         ) VALUES (?, 'einvoice', ?, ?, ?, 'queued', ?, ?)`,
      )
      .bind(
        id,
        input.trigger,
        input.syncJobId ?? null,
        input.scheduledBatchId ?? null,
        now,
        now,
      )
      .run();
  } catch (error) {
    const existing = await getActiveEinvoiceRun(db);
    if (!existing) throw error;
    return { run: existing, created: false };
  }
  return { run: (await getEinvoiceRun(db, id))!, created: true };
}

export async function getActiveEinvoiceRun(db: D1Database) {
  return (
    (await db
      .prepare(
        `SELECT * FROM einvoice_sync_runs
         WHERE connector_id = 'einvoice'
           AND status IN ('queued', 'initializing', 'processing')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .first<EinvoiceRunRow>()) ?? null
  );
}

export async function getEinvoiceRun(db: D1Database, runId: string) {
  return (
    (await db
      .prepare("SELECT * FROM einvoice_sync_runs WHERE id = ?")
      .bind(runId)
      .first<EinvoiceRunRow>()) ?? null
  );
}

/**
 * Acquires the one run-level Queue chunk lease. A replay may take over only
 * after the previous lease has expired; active and terminal runs are never
 * accidentally leased.
 */
export async function acquireEinvoiceRunChunkLease(
  db: D1Database,
  input: {
    runId: string;
    owner: string;
    leaseMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET chunk_lease_owner = ?, chunk_lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing')
         AND (
           chunk_lease_owner IS NULL
           OR chunk_lease_expires_at IS NULL
           OR chunk_lease_expires_at < ?
         )`,
    )
    .bind(input.owner, expiresAt, nowIso, input.runId, nowIso)
    .run();
  return result.meta.changes === 1;
}

/** Extends only the active owner's lease while a long detail chunk is running. */
export async function renewEinvoiceRunChunkLease(
  db: D1Database,
  input: {
    runId: string;
    owner: string;
    leaseMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET chunk_lease_expires_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing')
         AND chunk_lease_owner = ?`,
    )
    .bind(expiresAt, nowIso, input.runId, input.owner)
    .run();
  return result.meta.changes === 1;
}

/** Releases only the caller's lease; stale Queue deliveries cannot unlock it. */
export async function releaseEinvoiceRunChunkLease(
  db: D1Database,
  input: { runId: string; owner: string; now?: string },
) {
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET chunk_lease_owner = NULL, chunk_lease_expires_at = NULL,
           updated_at = ?
       WHERE id = ? AND chunk_lease_owner = ?`,
    )
    .bind(input.now ?? new Date().toISOString(), input.runId, input.owner)
    .run();
  return result.meta.changes === 1;
}

export async function transitionEinvoiceRunStatus(
  db: D1Database,
  input: {
    runId: string;
    from: Extract<EinvoiceRunStatus, "queued" | "initializing" | "processing">;
    to: Extract<EinvoiceRunStatus, "initializing" | "processing">;
    now?: string;
  },
) {
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .bind(
      input.to,
      input.now ?? new Date().toISOString(),
      input.runId,
      input.from,
    )
    .run();
  return result.meta.changes === 1;
}

/** Durable merge of discovered invoice headers. Existing processing/done work is never reset. */
export async function mergeEinvoiceRunItems(
  db: D1Database,
  runId: string,
  items: MergeEinvoiceRunItemInput[],
  now = new Date().toISOString(),
) {
  if (items.length === 0) {
    await refreshEinvoiceRunCounts(db, runId, now);
    return;
  }
  await db.batch([
    mergeEinvoiceRunItemsStatement(db, runId, items, now),
    refreshEinvoiceRunCountsStatement(db, runId, now),
  ]);
}

/**
 * Persists provider headers, refreshed secret session state, and the run phase
 * in one D1 batch. The settings version guard prevents an in-flight login from
 * overwriting credentials that the user saved while the network calls ran.
 */
export async function initializeEinvoiceRun(
  db: D1Database,
  input: {
    runId: string;
    items: MergeEinvoiceRunItemInput[];
    encryptedConfig: string;
    expectedSettingsUpdatedAt: string;
    cursor: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const results = await db.batch([
    mergeEinvoiceRunItemsStatement(
      db,
      input.runId,
      input.items,
      now,
      input.expectedSettingsUpdatedAt,
    ),
    refreshEinvoiceRunCountsStatement(db, input.runId, now),
    db
      .prepare(
        `UPDATE connector_settings
         SET encrypted_config = ?, public_config = NULL, sync_cursor = ?,
             updated_at = ?
         WHERE connector_id = 'einvoice' AND updated_at = ?`,
      )
      .bind(
        input.encryptedConfig,
        input.cursor,
        now,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `UPDATE einvoice_sync_runs
         SET status = 'processing', settings_version = ?, updated_at = ?
         WHERE id = ? AND status = 'initializing'
           AND EXISTS (
             SELECT 1 FROM connector_settings
             WHERE connector_id = 'einvoice'
               AND encrypted_config = ? AND updated_at = ?
           )`,
      )
      .bind(now, now, input.runId, input.encryptedConfig, now),
  ]);
  return {
    settingsUpdated: results[2]!.meta.changes === 1,
    transitioned: results[3]!.meta.changes === 1,
  };
}

/** Allows at most a bounded number of automatic session rebuilds per run. */
export async function claimEinvoiceRunSessionRefresh(
  db: D1Database,
  input: { runId: string; maxRefreshes?: number; now?: string },
) {
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET session_refresh_count = session_refresh_count + 1, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing')
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

/**
 * Clears an expired provider session and advances the run's pinned settings
 * version in the same transaction. A concurrent credential save makes both
 * compare-and-set statements no-ops.
 */
export async function resetEinvoiceRunSession(
  db: D1Database,
  input: {
    runId: string;
    encryptedConfig: string;
    expectedSettingsUpdatedAt: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE connector_settings
         SET encrypted_config = ?, updated_at = ?
         WHERE connector_id = 'einvoice' AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM einvoice_sync_runs
             WHERE id = ? AND (
               (status = 'processing' AND settings_version = ?)
               OR (status = 'initializing' AND settings_version IS NULL)
             )
           )`,
      )
      .bind(
        input.encryptedConfig,
        now,
        input.expectedSettingsUpdatedAt,
        input.runId,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `UPDATE einvoice_sync_runs
         SET status = 'initializing', settings_version = ?, updated_at = ?
         WHERE id = ? AND (
             (status = 'processing' AND settings_version = ?)
             OR (status = 'initializing' AND settings_version IS NULL)
           )
           AND EXISTS (
             SELECT 1 FROM connector_settings
             WHERE connector_id = 'einvoice'
               AND encrypted_config = ? AND updated_at = ?
           )`,
      )
      .bind(
        now,
        now,
        input.runId,
        input.expectedSettingsUpdatedAt,
        input.encryptedConfig,
        now,
      ),
  ]);
  return {
    settingsUpdated: results[0]!.meta.changes === 1,
    transitioned: results[1]!.meta.changes === 1,
  };
}

/** Atomically leases up to limit pending (or expired) detail items to one consumer. */
export async function claimEinvoiceRunItems(
  db: D1Database,
  input: {
    runId: string;
    claimToken?: string;
    limit?: number;
    leaseMs: number;
    now?: Date;
  },
): Promise<EinvoiceRunItemRow[]> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const claimToken = input.claimToken ?? crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
  const limit = Math.max(1, Math.floor(input.limit ?? 35));
  await db.batch([
    db
      .prepare(
        `UPDATE einvoice_sync_run_items
         SET status = 'processing',
             lease_token = ?,
             lease_expires_at = ?,
             attempt_count = attempt_count + 1,
             last_error = NULL,
             updated_at = ?
         WHERE id IN (
           SELECT id
           FROM einvoice_sync_run_items
           WHERE run_id = ?
             AND (status = 'pending' OR (
               status = 'processing'
               AND (lease_expires_at IS NULL OR lease_expires_at < ?)
             ))
           ORDER BY created_at ASC, invoice_source_id ASC
           LIMIT ?
         )`,
      )
      .bind(claimToken, leaseExpiresAt, nowIso, input.runId, nowIso, limit),
    refreshEinvoiceRunCountsStatement(db, input.runId, nowIso),
  ]);
  return (
    await db
      .prepare(
        `SELECT * FROM einvoice_sync_run_items
         WHERE run_id = ? AND lease_token = ? AND status = 'processing'
         ORDER BY created_at ASC, invoice_source_id ASC`,
      )
      .bind(input.runId, claimToken)
      .all<EinvoiceRunItemRow>()
  ).results;
}

/**
 * CAS completion: a stale retry cannot overwrite another worker's lease. The
 * item update and run-counter refresh execute in one D1 batch.
 */
export async function markEinvoiceRunItemSucceeded(
  db: D1Database,
  input: {
    runId: string;
    invoiceSourceId: string;
    claimToken: string;
    detailItems: unknown[];
    normalizedInvoice?: unknown;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE einvoice_sync_run_items
         SET detail_items_json = ?,
             normalized_invoice_json = CASE
               WHEN ? IS NULL THEN normalized_invoice_json
               ELSE ?
             END,
             line_item_count = ?,
             status = 'done',
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error = NULL,
             completed_at = ?,
             updated_at = ?
         WHERE run_id = ?
           AND invoice_source_id = ?
           AND status = 'processing'
           AND lease_token = ?`,
      )
      .bind(
        json(input.detailItems),
        input.normalizedInvoice === undefined
          ? null
          : json(input.normalizedInvoice),
        input.normalizedInvoice === undefined
          ? null
          : json(input.normalizedInvoice),
        input.detailItems.length,
        now,
        now,
        input.runId,
        input.invoiceSourceId,
        input.claimToken,
      ),
    refreshEinvoiceRunCountsStatement(db, input.runId, now),
  ]);
  return result[0]!.meta.changes === 1;
}

/**
 * Completes one whole provider chunk with one set-based D1 update. This keeps a
 * 35-detail Queue invocation below D1's Free-plan 50-query limit.
 */
export async function markEinvoiceRunItemsSucceeded(
  db: D1Database,
  input: {
    runId: string;
    claimToken: string;
    items: Array<{
      invoiceSourceId: string;
      detailItems: unknown[];
      normalizedInvoice: unknown;
    }>;
    now?: string;
  },
) {
  if (input.items.length === 0) return 0;
  const now = input.now ?? new Date().toISOString();
  const payload = input.items.map((item) => ({
    invoiceSourceId: item.invoiceSourceId,
    detailItemsJson: json(item.detailItems),
    normalizedInvoiceJson: json(item.normalizedInvoice),
    lineItemCount: item.detailItems.length,
  }));
  const results = await db.batch([
    db
      .prepare(
        `WITH updates AS (
           SELECT
             json_extract(value, '$.invoiceSourceId') AS invoice_source_id,
             json_extract(value, '$.detailItemsJson') AS detail_items_json,
             json_extract(value, '$.normalizedInvoiceJson') AS normalized_invoice_json,
             json_extract(value, '$.lineItemCount') AS line_item_count
           FROM json_each(?)
         )
         UPDATE einvoice_sync_run_items
         SET detail_items_json = (
               SELECT detail_items_json FROM updates
               WHERE updates.invoice_source_id = einvoice_sync_run_items.invoice_source_id
             ),
             normalized_invoice_json = (
               SELECT normalized_invoice_json FROM updates
               WHERE updates.invoice_source_id = einvoice_sync_run_items.invoice_source_id
             ),
             line_item_count = (
               SELECT line_item_count FROM updates
               WHERE updates.invoice_source_id = einvoice_sync_run_items.invoice_source_id
             ),
             status = 'done', lease_token = NULL, lease_expires_at = NULL,
             last_error = NULL, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'processing' AND lease_token = ?
           AND EXISTS (
             SELECT 1 FROM updates
             WHERE updates.invoice_source_id = einvoice_sync_run_items.invoice_source_id
           )`,
      )
      .bind(json(payload), now, now, input.runId, input.claimToken),
    refreshEinvoiceRunCountsStatement(db, input.runId, now),
  ]);
  return results[0]!.meta.changes;
}

/** Releases a matching lease for retry while retaining the durable header and error. */
export async function releaseEinvoiceRunItemForRetry(
  db: D1Database,
  input: {
    runId: string;
    invoiceSourceId: string;
    claimToken: string;
    error: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE einvoice_sync_run_items
         SET status = 'pending',
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?
         WHERE run_id = ?
           AND invoice_source_id = ?
           AND status = 'processing'
           AND lease_token = ?`,
      )
      .bind(
        input.error,
        now,
        input.runId,
        input.invoiceSourceId,
        input.claimToken,
      ),
    refreshEinvoiceRunCountsStatement(db, input.runId, now),
  ]);
  return result[0]!.meta.changes === 1;
}

/** Releases every remaining item owned by a failed chunk in one idempotent write. */
export async function releaseEinvoiceRunClaimForRetry(
  db: D1Database,
  input: {
    runId: string;
    claimToken: string;
    error: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE einvoice_sync_run_items
         SET status = 'pending',
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?
         WHERE run_id = ?
           AND status = 'processing'
           AND lease_token = ?`,
      )
      .bind(input.error, now, input.runId, input.claimToken),
    refreshEinvoiceRunCountsStatement(db, input.runId, now),
  ]);
  return result[0]!.meta.changes;
}

/**
 * Promotes every completed invoice and line item directly from the durable run
 * tables with a fixed five-statement D1 transaction. Every write repeats the
 * pinned-settings guard, so a concurrent credential save makes the whole batch
 * a no-op instead of mixing two accounts' data.
 */
export async function promoteEinvoiceRunRecords(
  db: D1Database,
  input: {
    runId: string;
    expectedSettingsUpdatedAt: string;
    cursor: string;
    now: string;
  },
) {
  const guard = `EXISTS (
    SELECT 1
    FROM einvoice_sync_runs guard_run
    JOIN connector_settings guard_settings
      ON guard_settings.connector_id = 'einvoice'
    WHERE guard_run.id = ?
      AND guard_run.status = 'processing'
      AND guard_run.promoted_at IS NULL
      AND guard_run.settings_version = guard_settings.updated_at
      AND guard_settings.updated_at = ?
      AND NOT EXISTS (
        SELECT 1 FROM einvoice_sync_run_items unfinished
        WHERE unfinished.run_id = guard_run.id AND unfinished.status != 'done'
      )
  )`;
  const invoiceRaw = jsonRawPayloadExpression("source.normalized_invoice_json");
  const lineItemRaw = jsonRawPayloadExpression("line.value");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE einvoice_sync_runs
         SET new_invoice_count = (
               SELECT COUNT(*)
               FROM einvoice_sync_run_items source
               WHERE source.run_id = ? AND source.status = 'done'
                 AND NOT EXISTS (
                   SELECT 1 FROM invoices target
                   WHERE target.connector_id = 'einvoice'
                     AND target.source_id = source.invoice_source_id
                 )
             ),
             updated_at = ?
         WHERE id = ? AND ${guard}`,
      )
      .bind(
        input.runId,
        input.now,
        input.runId,
        input.runId,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `INSERT INTO invoices (
           id, connector_id, source_id, invoice_number, invoice_date,
           seller_name, amount, raw_payload, created_at, updated_at
         )
         SELECT
           'einvoice:' || source.invoice_source_id,
           'einvoice',
           source.invoice_source_id,
           json_extract(source.normalized_invoice_json, '$.invoiceNumber'),
           json_extract(source.normalized_invoice_json, '$.invoiceDate'),
           json_extract(source.normalized_invoice_json, '$.sellerName'),
           CAST(json_extract(source.normalized_invoice_json, '$.amount') AS INTEGER),
           ${invoiceRaw},
           ?,
           ?
         FROM einvoice_sync_run_items source
         WHERE source.run_id = ? AND source.status = 'done' AND ${guard}
         ON CONFLICT(connector_id, source_id) DO UPDATE SET
           invoice_number = excluded.invoice_number,
           invoice_date = excluded.invoice_date,
           seller_name = excluded.seller_name,
           amount = excluded.amount,
           raw_payload = excluded.raw_payload,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.now,
        input.now,
        input.runId,
        input.runId,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `INSERT INTO invoice_line_items (
           id, invoice_id, connector_id, invoice_source_id, source_id,
           line_number, description, quantity, unit_price, amount,
           raw_payload, created_at, updated_at
         )
         SELECT
           'einvoice:' || source.invoice_source_id || ':item:' ||
             json_extract(line.value, '$.sourceId'),
           'einvoice:' || source.invoice_source_id,
           'einvoice',
           source.invoice_source_id,
           json_extract(line.value, '$.sourceId'),
           CAST(json_extract(line.value, '$.lineNumber') AS INTEGER),
           json_extract(line.value, '$.description'),
           CAST(json_extract(line.value, '$.quantity') AS REAL),
           CAST(json_extract(line.value, '$.unitPrice') AS INTEGER),
           CAST(json_extract(line.value, '$.amount') AS INTEGER),
           ${lineItemRaw},
           ?,
           ?
         FROM einvoice_sync_run_items source
         JOIN json_each(COALESCE(source.detail_items_json, '[]')) line
         WHERE source.run_id = ? AND source.status = 'done' AND ${guard}
         ON CONFLICT(connector_id, invoice_source_id, source_id) DO UPDATE SET
           invoice_id = excluded.invoice_id,
           line_number = excluded.line_number,
           description = excluded.description,
           quantity = excluded.quantity,
           unit_price = excluded.unit_price,
           amount = excluded.amount,
           raw_payload = excluded.raw_payload,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.now,
        input.now,
        input.runId,
        input.runId,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `UPDATE einvoice_sync_runs
         SET promoted_at = ?, settings_version = ?, updated_at = ?
         WHERE id = ? AND ${guard}`,
      )
      .bind(
        input.now,
        input.now,
        input.now,
        input.runId,
        input.runId,
        input.expectedSettingsUpdatedAt,
      ),
    db
      .prepare(
        `UPDATE connector_settings
         SET sync_cursor = ?, updated_at = ?
         WHERE connector_id = 'einvoice' AND updated_at = ?
           AND EXISTS (
             SELECT 1 FROM einvoice_sync_runs
             WHERE id = ? AND status = 'processing'
               AND promoted_at = ? AND settings_version = ?
           )`,
      )
      .bind(
        input.cursor,
        input.now,
        input.expectedSettingsUpdatedAt,
        input.runId,
        input.now,
        input.now,
      ),
  ]);
  return results[3]!.meta.changes === 1 && results[4]!.meta.changes === 1;
}

/** Terminal CAS. A completed run additionally requires every item to be done. */
export async function completeEinvoiceRun(
  db: D1Database,
  input: {
    runId: string;
    status: Extract<
      EinvoiceRunStatus,
      "completed" | "failed" | "needs_user_action"
    >;
    error?: string | null;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET status = ?, last_error = ?, completed_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'initializing', 'processing')
         AND (
           ? != 'completed'
           OR NOT EXISTS (
             SELECT 1 FROM einvoice_sync_run_items
             WHERE run_id = einvoice_sync_runs.id AND status != 'done'
           )
         )`,
    )
    .bind(
      input.status,
      input.error ?? null,
      now,
      now,
      input.runId,
      input.status,
    )
    .run();
  return result.meta.changes === 1;
}

export async function listPendingEinvoiceRunItems(
  db: D1Database,
  runId: string,
) {
  return (
    await db
      .prepare(
        `SELECT * FROM einvoice_sync_run_items
         WHERE run_id = ? AND status != 'done'
         ORDER BY created_at ASC, invoice_source_id ASC`,
      )
      .bind(runId)
      .all<EinvoiceRunItemRow>()
  ).results;
}

export async function listCompletedEinvoiceRunItems(
  db: D1Database,
  runId: string,
) {
  return (
    await db
      .prepare(
        `SELECT * FROM einvoice_sync_run_items
         WHERE run_id = ? AND status = 'done'
         ORDER BY created_at ASC, invoice_source_id ASC`,
      )
      .bind(runId)
      .all<EinvoiceRunItemRow>()
  ).results;
}

function refreshEinvoiceRunCountsStatement(
  db: D1Database,
  runId: string,
  now: string,
) {
  return db
    .prepare(
      `UPDATE einvoice_sync_runs
       SET total_item_count = (
             SELECT COUNT(*) FROM einvoice_sync_run_items WHERE run_id = ?
           ),
           pending_item_count = (
             SELECT COUNT(*) FROM einvoice_sync_run_items
             WHERE run_id = ? AND status = 'pending'
           ),
           processing_item_count = (
             SELECT COUNT(*) FROM einvoice_sync_run_items
             WHERE run_id = ? AND status = 'processing'
           ),
           done_item_count = (
             SELECT COUNT(*) FROM einvoice_sync_run_items
             WHERE run_id = ? AND status = 'done'
           ),
           line_item_count = (
             SELECT COALESCE(SUM(line_item_count), 0)
             FROM einvoice_sync_run_items WHERE run_id = ? AND status = 'done'
           ),
           updated_at = ?
       WHERE id = ?`,
    )
    .bind(runId, runId, runId, runId, runId, now, runId);
}

function mergeEinvoiceRunItemsStatement(
  db: D1Database,
  runId: string,
  items: MergeEinvoiceRunItemInput[],
  now: string,
  expectedSettingsUpdatedAt?: string,
) {
  const payload = items.map((item) => {
    const isDone = item.detailItems !== undefined || item.detailKey == null;
    return {
      id: `${runId}:${item.invoiceSourceId}`,
      invoiceSourceId: item.invoiceSourceId,
      headerJson: json(item.header),
      normalizedInvoiceJson: json(item.normalizedInvoice),
      detailKey: item.detailKey ?? null,
      detailMetadataJson:
        item.detailMetadata === undefined ? null : json(item.detailMetadata),
      detailItemsJson:
        item.detailItems === undefined ? null : json(item.detailItems),
      lineItemCount: item.detailItems?.length ?? 0,
      status: isDone ? "done" : "pending",
      completedAt: isDone ? now : null,
    };
  });
  const settingsGuard = expectedSettingsUpdatedAt
    ? `WHERE EXISTS (
         SELECT 1 FROM connector_settings
         WHERE connector_id = 'einvoice' AND updated_at = ?
       )`
    : "WHERE 1";
  const statement = db.prepare(
    `INSERT INTO einvoice_sync_run_items (
       id, run_id, invoice_source_id, header_json, normalized_invoice_json,
       detail_key, detail_metadata_json, detail_items_json, line_item_count,
       status, created_at, updated_at, completed_at
     )
     SELECT
       json_extract(value, '$.id'), ?,
       json_extract(value, '$.invoiceSourceId'),
       json_extract(value, '$.headerJson'),
       json_extract(value, '$.normalizedInvoiceJson'),
       json_extract(value, '$.detailKey'),
       json_extract(value, '$.detailMetadataJson'),
       json_extract(value, '$.detailItemsJson'),
       json_extract(value, '$.lineItemCount'),
       json_extract(value, '$.status'), ?, ?,
       json_extract(value, '$.completedAt')
     FROM json_each(?)
     ${settingsGuard}
     ON CONFLICT(run_id, invoice_source_id) DO UPDATE SET
       header_json = excluded.header_json,
       normalized_invoice_json = CASE
         WHEN einvoice_sync_run_items.status IN ('processing', 'done')
           THEN einvoice_sync_run_items.normalized_invoice_json
         ELSE excluded.normalized_invoice_json
       END,
       detail_key = excluded.detail_key,
       detail_metadata_json = excluded.detail_metadata_json,
       detail_items_json = CASE
         WHEN einvoice_sync_run_items.status = 'done'
           THEN einvoice_sync_run_items.detail_items_json
         ELSE COALESCE(excluded.detail_items_json, einvoice_sync_run_items.detail_items_json)
       END,
       line_item_count = CASE
         WHEN einvoice_sync_run_items.status = 'done'
           THEN einvoice_sync_run_items.line_item_count
         WHEN excluded.detail_items_json IS NOT NULL THEN excluded.line_item_count
         ELSE einvoice_sync_run_items.line_item_count
       END,
       status = CASE
         WHEN einvoice_sync_run_items.status IN ('processing', 'done')
           THEN einvoice_sync_run_items.status
         ELSE excluded.status
       END,
       completed_at = CASE
         WHEN einvoice_sync_run_items.status = 'done'
           THEN einvoice_sync_run_items.completed_at
         WHEN excluded.status = 'done' THEN excluded.completed_at
         ELSE NULL
       END,
       updated_at = excluded.updated_at`,
  );
  const bindings: unknown[] = [runId, now, now, json(payload)];
  if (expectedSettingsUpdatedAt) bindings.push(expectedSettingsUpdatedAt);
  return statement.bind(...bindings);
}

async function refreshEinvoiceRunCounts(
  db: D1Database,
  runId: string,
  now: string,
) {
  await refreshEinvoiceRunCountsStatement(db, runId, now).run();
}

function json(value: unknown) {
  return JSON.stringify(value) ?? "null";
}

function jsonRawPayloadExpression(document: string) {
  return `CASE json_type(${document}, '$.raw')
    WHEN 'text' THEN json_quote(json_extract(${document}, '$.raw'))
    WHEN 'integer' THEN CAST(json_extract(${document}, '$.raw') AS TEXT)
    WHEN 'real' THEN CAST(json_extract(${document}, '$.raw') AS TEXT)
    WHEN 'true' THEN 'true'
    WHEN 'false' THEN 'false'
    WHEN 'object' THEN json_extract(${document}, '$.raw')
    WHEN 'array' THEN json_extract(${document}, '$.raw')
    ELSE ${document}
  END`;
}

export { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES };
