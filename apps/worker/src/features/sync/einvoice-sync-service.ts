import {
  fetchEInvoiceInvoiceDetail,
  initializeEInvoiceSync,
  parseInvoiceConfig,
  EInvoiceV2Client,
  type EInvoiceDetailTask,
  type EInvoiceV2Session,
  type InvoiceConfig,
} from "@taiwan-fin-hub/connectors";
import type { SyncNotificationStatus } from "@taiwan-fin-hub/core";
import { getConnectorSettings, nextSyncRunAt } from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import {
  safelySendScheduledSyncSummary,
  safelySendSyncNotification,
} from "../notifications/service";
import { claimCompletedDefaultScheduleBatch } from "./notification-batch-repository";
import {
  acquireEinvoiceRunChunkLease,
  claimEinvoiceRunItems,
  claimEinvoiceRunSessionRefresh,
  completeEinvoiceRun,
  createOrGetActiveEinvoiceRun,
  getEinvoiceRun,
  initializeEinvoiceRun,
  markEinvoiceRunItemsSucceeded,
  promoteEinvoiceRunRecords,
  releaseEinvoiceRunClaimForRetry,
  releaseEinvoiceRunChunkLease,
  renewEinvoiceRunChunkLease,
  resetEinvoiceRunSession,
  transitionEinvoiceRunStatus,
  type EinvoiceRunRow,
  type EinvoiceRunTrigger,
} from "./einvoice-run-repository";
import { findSyncJob } from "./schedule-repository";
import { recoverLatestScheduledSyncSource } from "./report-repository";
import {
  isUserActionError,
  safeErrorMessage,
  NeedsUserActionError,
  SyncAlreadyRunningError,
  SYNC_LOCK_LEASE_MS,
} from "./service";

export const EINVOICE_DETAIL_CHUNK_SIZE = 35;
const EINVOICE_LEASE_MS = 3 * 60 * 1000;
const EINVOICE_LEASE_RENEW_EVERY_ITEMS = 5;
const EINVOICE_REQUEST_TIMEOUT_MS = 20_000;
const EINVOICE_MAX_SESSION_REFRESHES = 1;
const EINVOICE_JOB_ID = "einvoice:all";

export type EinvoiceChunkResult =
  | { status: "continue" }
  | { status: "completed" }
  | { status: "terminal" }
  | { status: "busy"; retryAfterSeconds: number };

export type StartEinvoiceSyncRunResult = {
  run: EinvoiceRunRow;
  created: boolean;
};

export async function startEinvoiceSyncRun(
  env: Env,
  input: {
    trigger: EinvoiceRunTrigger;
    scheduledBatchId?: string | null;
  },
): Promise<StartEinvoiceSyncRunResult> {
  await loadEinvoiceConfig(env);
  const result = await createOrGetActiveEinvoiceRun(env.DB, {
    trigger: input.trigger,
    syncJobId: EINVOICE_JOB_ID,
    scheduledBatchId: input.scheduledBatchId,
  });
  const { run, created } = result;
  if (
    run.trigger !== input.trigger ||
    (input.scheduledBatchId &&
      run.scheduled_batch_id !== input.scheduledBatchId)
  ) {
    throw new SyncAlreadyRunningError("einvoice");
  }
  if (created) {
    if (!(await holdEinvoiceRunLock(env.DB, run.id, input.trigger))) {
      await completeEinvoiceRun(env.DB, {
        runId: run.id,
        status: "failed",
        error: "Electronic invoice sync lock is already held.",
      });
      throw new SyncAlreadyRunningError("einvoice");
    }
    await updateEinvoiceProgressCursor(env.DB, run, "queued");
  }
  return { run, created };
}

export async function processEinvoiceSyncChunk(
  env: Env,
  runId: string,
  chunkOwner: string = crypto.randomUUID(),
): Promise<EinvoiceChunkResult> {
  let run = await getEinvoiceRun(env.DB, runId);
  if (!run || isTerminal(run)) return { status: "terminal" };
  if (
    !(await acquireEinvoiceRunChunkLease(env.DB, {
      runId,
      owner: chunkOwner,
      leaseMs: EINVOICE_LEASE_MS,
    }))
  ) {
    return {
      status: "busy",
      retryAfterSeconds: chunkLeaseRetryAfterSeconds(run),
    };
  }
  try {
    return await processLeasedEinvoiceSyncChunk(env, run, chunkOwner);
  } finally {
    await releaseEinvoiceRunChunkLease(env.DB, {
      runId,
      owner: chunkOwner,
    }).catch(() => undefined);
  }
}

async function processLeasedEinvoiceSyncChunk(
  env: Env,
  initialRun: EinvoiceRunRow,
  chunkOwner: string,
): Promise<EinvoiceChunkResult> {
  let run = initialRun;
  const runId = run.id;
  const client = new EInvoiceV2Client({
    timeoutMs: EINVOICE_REQUEST_TIMEOUT_MS,
  });
  if (!(await holdEinvoiceRunLock(env.DB, run.id, run.trigger))) {
    throw new Error("Electronic invoice sync lost its connector lock.");
  }

  let settings = await loadEinvoiceSettings(env);
  if (run.settings_version && settings.updatedAt !== run.settings_version) {
    throw new NeedsUserActionError(
      "電子發票設定已在同步期間更新，請重新啟動同步。",
    );
  }
  let config = settings.config;
  if (run.status === "queued" || run.status === "initializing") {
    if (run.status === "queued") {
      const initializing = await transitionEinvoiceRunStatus(env.DB, {
        runId,
        from: "queued",
        to: "initializing",
      });
      if (!initializing) return { status: "terminal" };
    }
    const reusedPersistedSession = sessionFromConfig(config) !== null;
    let initialized: Awaited<ReturnType<typeof initializeEInvoiceSync>>;
    try {
      initialized = await initializeEInvoiceSync(config, { client });
    } catch (error) {
      if (
        reusedPersistedSession &&
        isExpiredEinvoiceSessionError(error) &&
        (await claimEinvoiceRunSessionRefresh(env.DB, {
          runId,
          maxRefreshes: EINVOICE_MAX_SESSION_REFRESHES,
        })) &&
        (await clearPersistedEinvoiceSession(
          env,
          runId,
          run.settings_version ?? settings.updatedAt,
        ))
      ) {
        return { status: "continue" };
      }
      throw error;
    }
    config = parseInvoiceConfig({ ...config, ...initialized.configUpdates });
    const persisted = await persistInitializedEinvoiceRun(
      env,
      runId,
      config,
      settings.updatedAt,
      initialized,
    );
    if (!persisted) {
      throw new NeedsUserActionError(
        "電子發票設定已在同步期間更新，請重新啟動同步。",
      );
    }
    run = (await getEinvoiceRun(env.DB, runId))!;
  }

  const session = sessionFromConfig(config);
  if (!session) {
    await transitionEinvoiceRunStatus(env.DB, {
      runId,
      from: "processing",
      to: "initializing",
    });
    return { status: "continue" };
  }

  const claimToken = crypto.randomUUID();
  const claimed = await claimEinvoiceRunItems(env.DB, {
    runId,
    claimToken,
    limit: EINVOICE_DETAIL_CHUNK_SIZE,
    leaseMs: EINVOICE_LEASE_MS,
  });
  const completedItems: Parameters<
    typeof markEinvoiceRunItemsSucceeded
  >[1]["items"] = [];
  try {
    for (const [index, item] of claimed.entries()) {
      if (index % EINVOICE_LEASE_RENEW_EVERY_ITEMS === 0) {
        const renewed = await renewEinvoiceRunChunkLease(env.DB, {
          runId,
          owner: chunkOwner,
          leaseMs: EINVOICE_LEASE_MS,
        });
        if (!renewed) {
          throw new Error("Electronic invoice detail chunk lease was lost.");
        }
      }
      const task = JSON.parse(item.detail_metadata_json!) as EInvoiceDetailTask;
      const result = await fetchEInvoiceInvoiceDetail(session, task, {
        client,
      });
      const raw = asRecord(result.invoice.raw);
      const normalizedInvoice = {
        ...result.invoice,
        raw: {
          ...raw,
          detail: result.detail,
          detailItems: result.detailItems,
        },
      };
      completedItems.push({
        invoiceSourceId: item.invoice_source_id,
        detailItems: result.invoiceLineItems,
        normalizedInvoice,
      });
    }
    const updated = await markEinvoiceRunItemsSucceeded(env.DB, {
      runId,
      claimToken,
      items: completedItems,
    });
    if (updated !== completedItems.length) {
      throw new Error("Electronic invoice detail chunk lease was lost.");
    }
  } catch (error) {
    await releaseEinvoiceRunClaimForRetry(env.DB, {
      runId,
      claimToken,
      error: safeErrorMessage(error),
    });
    if (
      isExpiredEinvoiceSessionError(error) &&
      (await claimEinvoiceRunSessionRefresh(env.DB, {
        runId,
        maxRefreshes: EINVOICE_MAX_SESSION_REFRESHES,
      }))
    ) {
      if (
        run.settings_version &&
        (await clearPersistedEinvoiceSession(env, runId, run.settings_version))
      ) {
        return { status: "continue" };
      }
      throw new NeedsUserActionError(
        "電子發票設定已在同步期間更新，請重新啟動同步。",
      );
    }
    throw error;
  }

  run = (await getEinvoiceRun(env.DB, runId))!;
  await updateEinvoiceProgressCursor(env.DB, run, "processing");
  if (run.pending_item_count > 0 || run.processing_item_count > 0) {
    return { status: "continue" };
  }

  if (!run.promoted_at) {
    await promoteCompletedEinvoiceRun(env, run);
    run = (await getEinvoiceRun(env.DB, runId))!;
  }
  const finalized = await finalizeEinvoiceRun(env, run, "success");
  return finalized ? { status: "completed" } : { status: "terminal" };
}

export async function failEinvoiceSyncRun(
  env: Env,
  runId: string,
  error: unknown,
  forceFailed = false,
) {
  const run = await getEinvoiceRun(env.DB, runId);
  if (!run || isTerminal(run)) return false;
  const status: Exclude<SyncNotificationStatus, "success"> =
    !forceFailed && isEinvoiceUserActionError(error)
      ? "needs_user_action"
      : "failed";
  return finalizeEinvoiceRun(env, run, status, safeErrorMessage(error));
}

export async function cancelQueuedEinvoiceSyncRun(
  env: Env,
  runId: string,
  error: unknown,
) {
  const run = await getEinvoiceRun(env.DB, runId);
  if (!run || run.status !== "queued") return false;
  return failEinvoiceSyncRun(env, runId, error, true);
}

async function persistInitializedEinvoiceRun(
  env: Env,
  runId: string,
  config: InvoiceConfig,
  expectedSettingsUpdatedAt: string,
  initialized: Awaited<ReturnType<typeof initializeEInvoiceSync>>,
) {
  const detailIds = new Set(
    initialized.detailTasks.map((task) => task.sourceId),
  );
  const items = initialized.headers.map((header) => ({
    invoiceSourceId: header.sourceId,
    header,
    normalizedInvoice: header.invoice,
    ...(detailIds.has(header.sourceId)
      ? {
          detailKey: `${header.invNum}:${header.detailInvDate}`,
          detailMetadata: header,
        }
      : { detailItems: [] }),
  }));
  const now = new Date().toISOString();
  const run = (await getEinvoiceRun(env.DB, runId))!;
  const result = await initializeEinvoiceRun(env.DB, {
    runId,
    items,
    encryptedConfig: await encryptJson(config, configEncryptionKey(env)),
    expectedSettingsUpdatedAt,
    cursor: progressCursor(
      { ...run, total_item_count: items.length },
      "processing",
    ),
    now,
  });
  return result.settingsUpdated && result.transitioned;
}

async function promoteCompletedEinvoiceRun(env: Env, run: EinvoiceRunRow) {
  if (run.done_item_count !== run.total_item_count) {
    throw new Error("Electronic invoice run is not ready for promotion.");
  }
  const now = new Date().toISOString();
  const settings = await getConnectorSettings(env.DB, "einvoice");
  if (!settings) {
    throw new NeedsUserActionError(
      "Connector settings are required before sync.",
    );
  }
  const completedCursor = JSON.stringify({
    version: 2,
    completedAt: now,
    previousCompletedAt: previousCompletedAt(settings.sync_cursor),
    syncedPeriods: 2,
  });
  const promoted = await promoteEinvoiceRunRecords(env.DB, {
    runId: run.id,
    expectedSettingsUpdatedAt: settings.updated_at,
    cursor: completedCursor,
    now,
  });
  if (!promoted) {
    throw new NeedsUserActionError(
      "電子發票設定已在同步期間更新，請重新啟動同步。",
    );
  }
}

async function finalizeEinvoiceRun(
  env: Env,
  run: EinvoiceRunRow,
  status: SyncNotificationStatus,
  error: string | null = null,
) {
  const job = await findSyncJob(env.DB, "einvoice", "all");
  if (!job) {
    await completeEinvoiceRun(env.DB, {
      runId: run.id,
      status: status === "success" ? "completed" : status,
      error,
    });
    if (status === "success" && run.trigger === "manual") {
      await recoverLatestScheduledSyncSource(env.DB, {
        connectorId: "einvoice",
        newRecords: {
          invoices: run.new_invoice_count,
          bankTransactions: 0,
          investmentTransactions: 0,
        },
      }).catch((recoveryError) => {
        console.error(
          "[sync] failed to recover latest scheduled report from e-invoice sync",
          recoveryError,
        );
      });
    }
    return true;
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const success = status === "success";
  const nextRunAt =
    success || (status === "failed" && run.trigger === "scheduled")
      ? nextSyncRunAt(
          job.interval_minutes,
          job.preferred_time,
          now,
          job.next_run_at,
          job.preferred_weekday,
        )
      : job.next_run_at;
  const activeGuard = `EXISTS (
    SELECT 1 FROM einvoice_sync_runs
    WHERE id = ? AND status IN ('queued', 'initializing', 'processing')
  )`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE sync_jobs
       SET last_status = ?,
           last_error = ?,
           last_run_at = ?,
           last_success_at = CASE WHEN ? = 'success' THEN ? ELSE last_success_at END,
           next_run_at = ?,
           locked_by = NULL,
           locked_until = NULL,
           lock_trigger = NULL,
           lock_scope = NULL,
           updated_at = ?
       WHERE id = ? AND ${activeGuard}`,
    ).bind(
      status,
      error,
      nowIso,
      status,
      nowIso,
      nextRunAt,
      nowIso,
      job.id,
      run.id,
    ),
  ];
  if (run.scheduled_batch_id) {
    statements.push(
      env.DB.prepare(
        `UPDATE scheduled_sync_batch_results
         SET connector_id = 'einvoice', status = ?, completed_at = ?,
             new_invoices = ?, new_bank_transactions = 0,
             new_investment_transactions = 0
         WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL
           AND ${activeGuard}`,
      ).bind(
        status,
        nowIso,
        success ? run.new_invoice_count : 0,
        run.scheduled_batch_id,
        job.id,
        run.id,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE einvoice_sync_runs
       SET status = ?, last_error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'initializing', 'processing')
         AND (? != 'completed' OR promoted_at IS NOT NULL)`,
    ).bind(
      success ? "completed" : status,
      error,
      nowIso,
      nowIso,
      run.id,
      success ? "completed" : status,
    ),
  );
  const results = await env.DB.batch(statements);
  const finalized = results.at(-1)?.meta.changes === 1;
  if (!finalized) return false;

  if (success && run.trigger === "manual") {
    await recoverLatestScheduledSyncSource(env.DB, {
      connectorId: "einvoice",
      newRecords: {
        invoices: run.new_invoice_count,
        bankTransactions: 0,
        investmentTransactions: 0,
      },
    }).catch((recoveryError) => {
      // Report recovery is best effort and must not change a completed run.
      console.error(
        "[sync] failed to recover latest scheduled report from e-invoice sync",
        recoveryError,
      );
    });
  }

  if (run.scheduled_batch_id) {
    const summary = await claimCompletedDefaultScheduleBatch(
      env.DB,
      run.scheduled_batch_id,
    );
    if (summary) await safelySendScheduledSyncSummary(env, summary);
  } else if (run.trigger === "scheduled") {
    await safelySendSyncNotification(env, { connectorId: "einvoice", status });
  }
  return true;
}

async function loadEinvoiceConfig(env: Env) {
  return (await loadEinvoiceSettings(env)).config;
}

async function loadEinvoiceSettings(env: Env) {
  const settings = await getConnectorSettings(env.DB, "einvoice");
  if (!settings) {
    throw new NeedsUserActionError(
      "Connector settings are required before sync.",
    );
  }
  return {
    config: parseInvoiceConfig(
      await decryptJson<Record<string, unknown>>(
        settings.encrypted_config,
        configEncryptionKey(env),
      ),
    ),
    updatedAt: settings.updated_at,
  };
}

async function clearPersistedEinvoiceSession(
  env: Env,
  runId: string,
  expectedSettingsUpdatedAt: string,
) {
  const settings = await getConnectorSettings(env.DB, "einvoice");
  if (!settings) return;
  const config = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  for (const key of [
    "sid",
    "token",
    "iv",
    "svrCode",
    "loginAppId",
    "loginLiat",
    "loginSsMe",
    "ltoken",
    "hkey",
    "serverTimeOffset",
  ]) {
    delete config[key];
  }
  const parsed = parseInvoiceConfig(config);
  const result = await resetEinvoiceRunSession(env.DB, {
    runId,
    encryptedConfig: await encryptJson(parsed, configEncryptionKey(env)),
    expectedSettingsUpdatedAt,
  });
  return result.settingsUpdated && result.transitioned;
}

async function holdEinvoiceRunLock(
  db: D1Database,
  runId: string,
  trigger: EinvoiceRunTrigger,
) {
  const now = new Date();
  const result = await db
    .prepare(
      `UPDATE sync_jobs
       SET locked_by = ?, locked_until = ?, lock_trigger = ?, lock_scope = 'all',
           updated_at = ?
       WHERE id = ?
         AND (locked_until IS NULL OR locked_until < ? OR locked_by = ?)`,
    )
    .bind(
      runId,
      new Date(now.getTime() + SYNC_LOCK_LEASE_MS).toISOString(),
      trigger,
      now.toISOString(),
      EINVOICE_JOB_ID,
      now.toISOString(),
      runId,
    )
    .run();
  return result.meta.changes === 1;
}

async function updateEinvoiceProgressCursor(
  db: D1Database,
  run: EinvoiceRunRow,
  phase: "queued" | "processing",
) {
  const settings = await getConnectorSettings(db, "einvoice");
  if (!settings) return;
  await db
    .prepare(
      `UPDATE connector_settings SET sync_cursor = ?
       WHERE connector_id = 'einvoice'
         AND (? IS NULL OR updated_at = ?)`,
    )
    .bind(
      progressCursor(run, phase),
      run.settings_version,
      run.settings_version,
    )
    .run();
}

function progressCursor(run: EinvoiceRunRow, phase: "queued" | "processing") {
  return JSON.stringify({
    version: 2,
    activeRunId: run.id,
    phase,
    completedItems: run.done_item_count,
    totalItems: run.total_item_count,
  });
}

function sessionFromConfig(config: InvoiceConfig): EInvoiceV2Session | null {
  if (
    !config.sid ||
    !config.token ||
    !config.loginAppId ||
    config.loginLiat == null ||
    !config.loginSsMe
  ) {
    return null;
  }
  return {
    sid: config.sid,
    token: config.token,
    loginAppId: config.loginAppId,
    loginLiat: config.loginLiat,
    loginSsMe: config.loginSsMe,
    ...(config.iv === undefined ? {} : { iv: config.iv }),
    ...(config.svrCode === undefined ? {} : { svrCode: config.svrCode }),
    ...(config.loginClientCode === undefined
      ? {}
      : { clientCode: config.loginClientCode }),
    ...(config.ltoken === undefined ? {} : { ltoken: config.ltoken }),
    ...(config.hkey === undefined ? {} : { hkey: config.hkey }),
    ...(config.mobileBarcode === undefined
      ? {}
      : { carrierCode: config.mobileBarcode }),
    ...(config.serverTimeOffset === undefined
      ? {}
      : { serverTimeOffset: config.serverTimeOffset }),
  };
}

function previousCompletedAt(cursor: string | null | undefined) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(cursor) as {
      completedAt?: unknown;
      syncedAt?: unknown;
    };
    if (typeof parsed.completedAt === "string") return parsed.completedAt;
    return typeof parsed.syncedAt === "string" ? parsed.syncedAt : undefined;
  } catch {
    return undefined;
  }
}

function isTerminal(run: EinvoiceRunRow) {
  return ["completed", "failed", "needs_user_action"].includes(run.status);
}

function chunkLeaseRetryAfterSeconds(run: EinvoiceRunRow) {
  if (!run.chunk_lease_expires_at) return 30;
  const remainingMs =
    new Date(run.chunk_lease_expires_at).getTime() - Date.now();
  if (!Number.isFinite(remainingMs)) return 30;
  return Math.max(1, Math.min(5 * 60, Math.ceil(remainingMs / 1000) + 1));
}

export function isEinvoiceUserActionError(error: unknown) {
  if (isUserActionError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (?:429|5\d\d)\b/.test(message)) return false;
  return /登入失敗|帳號|密碼|credential|unauthori[sz]ed|HTTP 40[13]\b/i.test(
    message,
  );
}

function isExpiredEinvoiceSessionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 40[13]\b/i.test(message);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
