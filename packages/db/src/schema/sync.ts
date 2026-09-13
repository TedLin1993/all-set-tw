import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  unique,
  uniqueIndex,
  index,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id").notNull(),
    scope: text("scope").notNull(),
    enabled: integer("enabled")
      .notNull()
      .default(sql`1`),
    intervalMinutes: integer("interval_minutes").notNull(),
    nextRunAt: text("next_run_at").notNull(),
    lockedUntil: text("locked_until"),
    lockedBy: text("locked_by"),
    lockTrigger: text("lock_trigger"),
    lockScope: text("lock_scope"),
    lastRunAt: text("last_run_at"),
    lastSuccessAt: text("last_success_at"),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    scheduleMode: text("schedule_mode")
      .notNull()
      .default(sql`'inherit'`),
    preferredTime: text("preferred_time")
      .notNull()
      .default(sql`'06:00'`),
    preferredWeekday: integer("preferred_weekday")
      .notNull()
      .default(sql`1`),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_sync_jobs_due").on(table.enabled, table.nextRunAt),
    unique().on(table.connectorId, table.scope),
    check(
      "sync_jobs_check_1",
      sql`lock_trigger IS NULL OR lock_trigger IN ('manual', 'scheduled')`,
    ),
    check("sync_jobs_check_2", sql`schedule_mode IN ('inherit', 'custom')`),
    check("sync_jobs_check_3", sql`preferred_weekday BETWEEN 0 AND 6`),
  ],
);

export const syncScheduleSettings = sqliteTable(
  "sync_schedule_settings",
  {
    id: text("id").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    preferredTime: text("preferred_time").notNull(),
    timezone: text("timezone").notNull(),
    updatedAt: text("updated_at").notNull(),
    preferredWeekday: integer("preferred_weekday")
      .notNull()
      .default(sql`1`),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check("sync_schedule_settings_check_1", sql`id = 'default'`),
    check(
      "sync_schedule_settings_check_2",
      sql`preferred_weekday BETWEEN 0 AND 6`,
    ),
  ],
);

export const syncWriteStaging = sqliteTable(
  "sync_write_staging",
  {
    runId: text("run_id").notNull(),
    entityType: text("entity_type").notNull(),
    recordKey: text("record_key").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.entityType, table.recordKey] }),
    index("idx_sync_write_staging_created_at").on(table.createdAt),
    check("sync_write_staging_check_1", sql`json_valid(payload)`),
  ],
);

export const scheduledSyncBatches = sqliteTable(
  "scheduled_sync_batches",
  {
    id: text("id").notNull(),
    scheduleKey: text("schedule_key")
      .notNull()
      .default(sql`'default'`),
    notificationClaimedAt: text("notification_claimed_at"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    isBaseline: integer("is_baseline")
      .notNull()
      .default(sql`0`),
    assetsBeforeTwd: integer("assets_before_twd"),
    creditCardDebtBeforeTwd: integer("credit_card_debt_before_twd"),
    missingCurrenciesBefore: text("missing_currencies_before")
      .notNull()
      .default(sql`'[]'`),
    assetsAfterTwd: integer("assets_after_twd"),
    creditCardDebtAfterTwd: integer("credit_card_debt_after_twd"),
    missingCurrenciesAfter: text("missing_currencies_after")
      .notNull()
      .default(sql`'[]'`),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_scheduled_sync_batches_completed").on(sql`completed_at DESC`),
    uniqueIndex("idx_scheduled_sync_batches_open")
      .on(table.scheduleKey)
      .where(sql`notification_claimed_at IS NULL`),
    check("scheduled_sync_batches_check_1", sql`schedule_key = 'default'`),
  ],
);

export const scheduledSyncBatchResults = sqliteTable(
  "scheduled_sync_batch_results",
  {
    batchId: text("batch_id").notNull(),
    jobId: text("job_id").notNull(),
    connectorId: text("connector_id").notNull(),
    status: text("status"),
    completedAt: text("completed_at"),
    newInvoices: integer("new_invoices")
      .notNull()
      .default(sql`0`),
    newBankTransactions: integer("new_bank_transactions")
      .notNull()
      .default(sql`0`),
    newInvestmentTransactions: integer("new_investment_transactions")
      .notNull()
      .default(sql`0`),
    recoveredAt: text("recovered_at"),
  },
  (table) => [
    primaryKey({ columns: [table.batchId, table.jobId] }),
    foreignKey({
      columns: [table.batchId],
      foreignColumns: [scheduledSyncBatches.id],
    }).onDelete("cascade"),
    check(
      "scheduled_sync_batch_results_check_1",
      sql`status IN ('success', 'failed', 'needs_user_action')`,
    ),
  ],
);

export const einvoiceSyncRuns = sqliteTable(
  "einvoice_sync_runs",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id")
      .notNull()
      .default(sql`'einvoice'`),
    trigger: text("trigger").notNull(),
    syncJobId: text("sync_job_id"),
    scheduledBatchId: text("scheduled_batch_id"),
    settingsVersion: text("settings_version"),
    status: text("status").notNull(),
    totalItemCount: integer("total_item_count")
      .notNull()
      .default(sql`0`),
    pendingItemCount: integer("pending_item_count")
      .notNull()
      .default(sql`0`),
    processingItemCount: integer("processing_item_count")
      .notNull()
      .default(sql`0`),
    doneItemCount: integer("done_item_count")
      .notNull()
      .default(sql`0`),
    lineItemCount: integer("line_item_count")
      .notNull()
      .default(sql`0`),
    newInvoiceCount: integer("new_invoice_count")
      .notNull()
      .default(sql`0`),
    sessionRefreshCount: integer("session_refresh_count")
      .notNull()
      .default(sql`0`),
    lastError: text("last_error"),
    chunkLeaseOwner: text("chunk_lease_owner"),
    chunkLeaseExpiresAt: text("chunk_lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    promotedAt: text("promoted_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_einvoice_sync_runs_completed").on(sql`completed_at DESC`),
    uniqueIndex("idx_einvoice_sync_runs_one_active")
      .on(table.connectorId)
      .where(sql`status IN ('queued', 'initializing', 'processing')`),
    foreignKey({
      columns: [table.scheduledBatchId],
      foreignColumns: [scheduledSyncBatches.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [table.syncJobId],
      foreignColumns: [syncJobs.id],
    }).onDelete("set null"),
    check("einvoice_sync_runs_check_1", sql`connector_id = 'einvoice'`),
    check(
      "einvoice_sync_runs_check_2",
      sql`trigger IN ('manual', 'scheduled')`,
    ),
    check(
      "einvoice_sync_runs_check_3",
      sql`status IN (
    'queued', 'initializing', 'processing', 'completed', 'failed', 'needs_user_action'
  )`,
    ),
  ],
);

export const einvoiceSyncRunItems = sqliteTable(
  "einvoice_sync_run_items",
  {
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    invoiceSourceId: text("invoice_source_id").notNull(),
    headerJson: text("header_json").notNull(),
    normalizedInvoiceJson: text("normalized_invoice_json").notNull(),
    detailKey: text("detail_key"),
    detailMetadataJson: text("detail_metadata_json"),
    detailItemsJson: text("detail_items_json"),
    lineItemCount: integer("line_item_count")
      .notNull()
      .default(sql`0`),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count")
      .notNull()
      .default(sql`0`),
    lastError: text("last_error"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_einvoice_sync_run_items_claim").on(
      table.runId,
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    unique().on(table.runId, table.invoiceSourceId),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [einvoiceSyncRuns.id],
    }).onDelete("cascade"),
    check(
      "einvoice_sync_run_items_check_1",
      sql`status IN ('pending', 'processing', 'done')`,
    ),
  ],
);

export const tdccSyncRuns = sqliteTable(
  "tdcc_sync_runs",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id")
      .notNull()
      .default(sql`'tdcc'`),
    trigger: text("trigger").notNull(),
    scope: text("scope")
      .notNull()
      .default(sql`'all'`),
    syncJobId: text("sync_job_id"),
    scheduledBatchId: text("scheduled_batch_id"),
    settingsVersion: text("settings_version"),
    phase: text("phase")
      .notNull()
      .default(sql`'initialize'`),
    status: text("status")
      .notNull()
      .default(sql`'queued'`),
    encryptedConfig: text("encrypted_config"),
    encryptedSession: text("encrypted_session"),
    sessionJson: text("session_json"),
    totalItemCount: integer("total_item_count")
      .notNull()
      .default(sql`0`),
    pendingItemCount: integer("pending_item_count")
      .notNull()
      .default(sql`0`),
    processingItemCount: integer("processing_item_count")
      .notNull()
      .default(sql`0`),
    doneItemCount: integer("done_item_count")
      .notNull()
      .default(sql`0`),
    failedItemCount: integer("failed_item_count")
      .notNull()
      .default(sql`0`),
    sessionRefreshCount: integer("session_refresh_count")
      .notNull()
      .default(sql`0`),
    lastError: text("last_error"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    promotedAt: text("promoted_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_tdcc_sync_runs_completed").on(sql`completed_at DESC`),
    uniqueIndex("idx_tdcc_sync_runs_one_active")
      .on(table.connectorId)
      .where(
        sql`status IN ('queued', 'initializing', 'processing', 'promoting')`,
      ),
    foreignKey({
      columns: [table.scheduledBatchId],
      foreignColumns: [scheduledSyncBatches.id],
    }).onDelete("set null"),
    foreignKey({
      columns: [table.syncJobId],
      foreignColumns: [syncJobs.id],
    }).onDelete("set null"),
    check("tdcc_sync_runs_check_1", sql`connector_id = 'tdcc'`),
    check("tdcc_sync_runs_check_2", sql`trigger IN ('manual', 'scheduled')`),
    check(
      "tdcc_sync_runs_check_3",
      sql`scope IN ('all', 'investments', 'bank', 'trades')`,
    ),
    check(
      "tdcc_sync_runs_check_4",
      sql`phase IN (
      'initialize', 'snapshot', 'positions', 'bank', 'investments',
      'trades', 'promote', 'finalize'
    )`,
    ),
    check(
      "tdcc_sync_runs_check_5",
      sql`status IN (
    'queued', 'initializing', 'processing', 'promoting',
    'completed', 'failed', 'needs_user_action'
  )`,
    ),
    check(
      "tdcc_sync_runs_check_6",
      sql`session_json IS NULL OR json_valid(session_json)`,
    ),
  ],
);

export const tdccSyncRunItems = sqliteTable(
  "tdcc_sync_run_items",
  {
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    taskType: text("task_type").notNull(),
    taskKey: text("task_key")
      .notNull()
      .default(sql`''`),
    accountId: text("account_id"),
    pageCursor: text("page_cursor")
      .notNull()
      .default(sql`''`),
    nextPageCursor: text("next_page_cursor"),
    pageNumber: integer("page_number")
      .notNull()
      .default(sql`0`),
    taskJson: text("task_json")
      .notNull()
      .default(sql`'{}'`),
    payloadJson: text("payload_json"),
    status: text("status")
      .notNull()
      .default(sql`'pending'`),
    attemptCount: integer("attempt_count")
      .notNull()
      .default(sql`0`),
    lastError: text("last_error"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    index("idx_tdcc_sync_run_items_account").on(
      table.runId,
      table.accountId,
      table.taskType,
      table.pageNumber,
    ),
    index("idx_tdcc_sync_run_items_claim").on(
      table.runId,
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
    unique().on(table.runId, table.taskType, table.taskKey, table.pageCursor),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [tdccSyncRuns.id],
    }).onDelete("cascade"),
    check("tdcc_sync_run_items_check_1", sql`json_valid(task_json)`),
    check(
      "tdcc_sync_run_items_check_2",
      sql`payload_json IS NULL OR json_valid(payload_json)`,
    ),
    check(
      "tdcc_sync_run_items_check_3",
      sql`status IN ('pending', 'processing', 'done', 'failed')`,
    ),
  ],
);
