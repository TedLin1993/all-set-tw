import {
  createTdccClient,
  EPassbookError,
  ensureTdccSession,
  initializeTdccSnapshot,
  normalizeBankTransactionDetails,
  normalizeTdccSnapshot,
  parseTdccConfig,
  parseTdccTradePageItems,
  type BankTransactionDetail,
  type TdccConfig,
  type TdccCursorState,
  type TdccSnapshotInitialization,
  type TdccStockAccount,
} from "@taiwan-fin-hub/connectors";
import type {
  SyncNewRecordCounts,
  SyncNotificationStatus,
} from "@taiwan-fin-hub/core";
import { getConnectorSettings, nextSyncRunAt } from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { rebuildBankDepositHistory, dateFromIso } from "../net-worth/service";
import {
  safelySendScheduledSyncSummary,
  safelySendSyncNotification,
} from "../notifications/service";
import { claimCompletedDefaultScheduleBatch } from "./notification-batch-repository";
import {
  acquireTdccRunLease,
  claimTdccRunItems,
  createOrGetActiveTdccRun,
  finalizeTdccRun,
  getTdccRun,
  insertNextTdccRunItem,
  markTdccRunItemSucceeded,
  releaseTdccRunItemForRetry,
  releaseTdccRunLease,
  transitionTdccRun,
  updateTdccRunState,
  type TdccRunItemRow,
  type TdccRunRow,
  type TdccRunScope,
  type TdccRunTrigger,
} from "./tdcc-run-repository";
import { findSyncJob } from "./schedule-repository";
import { recoverLatestScheduledSyncSource } from "./report-repository";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  investmentPositionRecord,
  investmentTransactionRecord,
  netWorthHistoryRecord,
} from "./record-mapper";
import {
  linkCanonicalBankAccountsStatement,
  connectorStateStatement,
} from "./repository";
import {
  isUserActionError,
  NeedsUserActionError,
  safeErrorMessage,
  SyncAlreadyRunningError,
  SYNC_LOCK_LEASE_MS,
} from "./service";
import {
  serializePublicConnectorConfig,
  splitConnectorCursorState,
} from "./connector-state";
import { promoteStagedSyncWrite, stageSyncWriteRecords } from "./persistence";

const TDCC_JOB_ID = "tdcc:all";
const TDCC_RUN_LEASE_MS = 3 * 60 * 1000;
const TDCC_MAX_BANK_PAGES = 1_000;
const TDCC_MAX_QUEUE_ITEMS_PER_CHUNK = 1;
const TDCC_SESSION_EXPIRED_CODES = new Set([
  "D0006",
  "D0007",
  "A0001",
  "A0002",
  "T8000",
]);

export type TdccChunkResult =
  | { status: "continue" }
  | { status: "completed" }
  | { status: "terminal" }
  | { status: "busy"; retryAfterSeconds: number };

export type StartTdccSyncRunResult = {
  run: TdccRunRow;
  created: boolean;
};

/** Start a durable TDCC run. Manual starts initialize the bounded snapshot
 * inline so OTP/device errors retain the existing immediate UX. */
export async function startTdccSyncRun(
  env: Env,
  input: {
    trigger: TdccRunTrigger;
    scope: TdccRunScope;
    overrides?: Record<string, unknown>;
    scheduledBatchId?: string | null;
  },
): Promise<StartTdccSyncRunResult> {
  const settings = await getConnectorSettings(env.DB, "tdcc");
  if (!settings) {
    throw new NeedsUserActionError("請先儲存集保 e 存摺設定，再開始同步。");
  }
  const storedConfig = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseTdccConfig({
    ...storedConfig,
    ...(input.overrides ?? {}),
    requestOtp: input.trigger === "manual",
  });
  requireTdccCredentials(config);
  const encryptedConfig = await encryptJson(config, configEncryptionKey(env));
  const result = await createOrGetActiveTdccRun(env.DB, {
    trigger: input.trigger,
    scope: input.scope,
    syncJobId: TDCC_JOB_ID,
    scheduledBatchId: input.scheduledBatchId,
    settingsVersion: settings.updated_at,
    encryptedConfig,
  });
  const { run, created } = result;
  if (
    run.trigger !== input.trigger ||
    run.scope !== input.scope ||
    (input.scheduledBatchId &&
      run.scheduled_batch_id !== input.scheduledBatchId)
  ) {
    throw new SyncAlreadyRunningError("tdcc");
  }
  if (!created) return result;

  if (!(await holdTdccRunLock(env.DB, run.id, input.trigger, input.scope))) {
    await failTdccSyncRun(
      env,
      run.id,
      new SyncAlreadyRunningError("tdcc"),
      true,
    );
    throw new SyncAlreadyRunningError("tdcc");
  }

  try {
    if (input.trigger === "manual") {
      await initializeTdccRun(env, run, config, settings.sync_cursor);
    }
  } catch (error) {
    await failTdccSyncRun(env, run.id, error);
    throw error;
  }
  return {
    run: (await getTdccRun(env.DB, run.id)) ?? run,
    created: true,
  };
}

export async function processTdccSyncChunk(
  env: Env,
  runId: string,
  chunkOwner: string = crypto.randomUUID(),
): Promise<TdccChunkResult> {
  let run = await getTdccRun(env.DB, runId);
  if (!run || isTerminal(run)) return { status: "terminal" };
  if (
    !(await acquireTdccRunLease(env.DB, {
      runId,
      owner: chunkOwner,
      leaseMs: TDCC_RUN_LEASE_MS,
    }))
  ) {
    return { status: "busy", retryAfterSeconds: 5 };
  }
  try {
    run = (await getTdccRun(env.DB, runId)) ?? run;
    if (!(await holdTdccRunLock(env.DB, run.id, run.trigger, run.scope))) {
      throw new SyncAlreadyRunningError("tdcc");
    }
    if (run.status === "queued" || run.phase === "initialize") {
      const settings = await requireTdccSettings(env);
      const config = await loadRunConfig(env, run);
      await initializeTdccRun(env, run, config, settings.sync_cursor);
      run = (await getTdccRun(env.DB, runId)) ?? run;
    }

    const claimToken = crypto.randomUUID();
    const claimed = await claimTdccRunItems(env.DB, {
      runId,
      claimToken,
      limit: TDCC_MAX_QUEUE_ITEMS_PER_CHUNK,
      leaseMs: TDCC_RUN_LEASE_MS,
    });
    if (claimed.length > 0) {
      try {
        await processTdccRunItem(env, run, claimed[0]!, claimToken);
      } catch (error) {
        await releaseTdccRunItemForRetry(env.DB, {
          runId,
          itemId: claimed[0]!.id,
          claimToken,
          error: safeErrorMessage(error),
        }).catch(() => undefined);
        throw error;
      }
      run = (await getTdccRun(env.DB, runId)) ?? run;
    }

    if (run.pending_item_count > 0 || run.processing_item_count > 0) {
      return { status: "continue" };
    }
    if (run.status !== "promoting" && !run.promoted_at) {
      await promoteTdccRun(env, run);
      run = (await getTdccRun(env.DB, runId)) ?? run;
    }
    const finalized = await finalizeTdccRunOutcome(env, run);
    return finalized ? { status: "completed" } : { status: "terminal" };
  } finally {
    await releaseTdccRunLease(env.DB, {
      runId,
      owner: chunkOwner,
    }).catch(() => undefined);
  }
}

export async function failTdccSyncRun(
  env: Env,
  runId: string,
  error: unknown,
  forceFailed = false,
) {
  const run = await getTdccRun(env.DB, runId);
  if (!run || isTerminal(run)) return false;
  const status: Exclude<SyncNotificationStatus, "success"> =
    !forceFailed && isUserActionError(error) ? "needs_user_action" : "failed";
  const errorMessage = safeErrorMessage(error);
  await finalizeTdccRun(env.DB, {
    runId,
    status,
    error: errorMessage,
  });
  await clearTdccStaging(env, runId);
  await finishTdccJob(env, run, status, errorMessage, emptyNewRecords());
  return true;
}

export async function cancelQueuedTdccSyncRun(
  env: Env,
  runId: string,
  error: unknown,
) {
  const run = await getTdccRun(env.DB, runId);
  if (
    !run ||
    isTerminal(run) ||
    !["queued", "initializing", "processing", "promoting"].includes(run.status)
  )
    return false;
  return failTdccSyncRun(env, runId, error, true);
}

async function initializeTdccRun(
  env: Env,
  run: TdccRunRow,
  config: TdccConfig,
  persistedCursor: string | null,
) {
  if (run.status !== "queued" && run.phase !== "initialize") return;
  const transitioned = await transitionTdccRun(env.DB, {
    runId: run.id,
    from: "queued",
    to: "initializing",
    phase: "initialize",
  });
  if (!transitioned && run.status === "queued") {
    const current = await getTdccRun(env.DB, run.id);
    if (current?.status !== "initializing") return;
  }

  const initialized = await initializeTdccSnapshot(
    config,
    persistedCursor ?? undefined,
  );
  const now = new Date().toISOString();
  const cursor = JSON.stringify({
    deviceId: initialized.identity.deviceId,
    devType: initialized.identity.devType,
    devModel: initialized.identity.devModel,
    session: initialized.session,
    tradeCursors: initialized.previous?.tradeCursors,
  });
  const records = snapshotRecords(env, run.scope, initialized, now);
  await stageSyncWriteRecords(env.DB, run.id, records);
  await createTdccPageItems(env, run, initialized, config.tradeHistoryMaxPages);
  const session = JSON.parse(cursor) as TdccCursorState;
  const phase = firstPendingPhase(run.scope, initialized);
  await updateTdccRunState(env.DB, {
    runId: run.id,
    encryptedSession: await encryptJson(session, configEncryptionKey(env)),
    phase,
    status: "processing",
  });
}

async function processTdccRunItem(
  env: Env,
  run: TdccRunRow,
  item: TdccRunItemRow,
  claimToken: string,
) {
  const config = await loadRunConfig(env, run);
  const sessionState = await loadRunSession(env, run);
  if (!sessionState?.session?.tokenId) {
    throw new NeedsUserActionError("集保登入狀態已失效，請重新驗證。");
  }
  const cursor = JSON.stringify(sessionState);
  const clientState = createTdccClient(
    { ...config, session: sessionState.session },
    cursor,
  );
  await ensureTdccSession(clientState.client, {
    ...config,
    session: sessionState.session,
  });
  const task = parseTask(item.task_json);
  try {
    if (item.task_type === "bank_page") {
      await processBankPage(
        env,
        run,
        item,
        claimToken,
        clientState,
        task as BankPageTask,
      );
      return;
    }
    if (item.task_type === "trade_page") {
      await processTradePage(
        env,
        run,
        item,
        claimToken,
        clientState,
        task as TradePageTask,
        sessionState,
      );
      return;
    }
  } catch (error) {
    if (
      error instanceof EPassbookError &&
      TDCC_SESSION_EXPIRED_CODES.has(error.code)
    ) {
      throw new NeedsUserActionError("集保登入狀態已失效，請重新驗證。");
    }
    throw error;
  }
  throw new Error(`Unsupported TDCC task type: ${item.task_type}`);
}

async function processBankPage(
  env: Env,
  run: TdccRunRow,
  item: TdccRunItemRow,
  claimToken: string,
  clientState: ReturnType<typeof createTdccClient>,
  task: BankPageTask,
) {
  if (item.page_number >= TDCC_MAX_BANK_PAGES) {
    throw new Error(
      `TDCC bank transaction pagination exceeded ${TDCC_MAX_BANK_PAGES} pages.`,
    );
  }
  const page = await clientState.client.getBankTransactionsPage(
    task.bankId,
    task.accountNo,
    task.currency,
    item.page_cursor,
  );
  const payload = {
    details: page.details,
    pageToken: page.pageToken,
    nextPageToken: page.nextPageToken,
    totalCount: page.totalCount,
    pageRecordCount: page.pageRecordCount,
  };
  if (page.nextPageToken) {
    await assertTdccPageNotSeen(
      env,
      run.id,
      "bank_page",
      item.task_key,
      page.nextPageToken,
    );
    await insertNextTdccRunItem(env.DB, run.id, {
      taskType: "bank_page",
      taskKey: item.task_key,
      accountId: item.account_id,
      pageCursor: page.nextPageToken,
      pageNumber: item.page_number + 1,
      task,
    });
  }
  await markTdccRunItemSucceeded(env.DB, {
    runId: run.id,
    itemId: item.id,
    claimToken,
    payload,
    nextPageCursor: page.nextPageToken ?? null,
  });
  await persistClientSession(env, run.id, clientState);
}

async function processTradePage(
  env: Env,
  run: TdccRunRow,
  item: TdccRunItemRow,
  claimToken: string,
  clientState: ReturnType<typeof createTdccClient>,
  task: TradePageTask,
  sessionState: TdccCursorState,
) {
  const page = await clientState.client.getTradeDetailPage({
    brokerNo: task.brokerNo,
    brokerAccount: task.brokerAccount,
    txnSerNo: task.txnSerNo,
    updateType: task.updateType,
  });
  const transactions = parseTdccTradePageItems(page, task);
  const now = new Date().toISOString();
  await stageSyncWriteRecords(
    env.DB,
    run.id,
    transactions.map((transaction) =>
      investmentTransactionRecord("tdcc", transaction, now),
    ),
  );

  const next = tradeTaskAfterPage(task, transactions, page.returnCode);
  const cursorKey = `${task.brokerNo}:${task.brokerAccount}`;
  const tradeCursors = { ...(sessionState.tradeCursors ?? {}) };
  tradeCursors[cursorKey] = {
    newest: next.newest,
    oldest: next.oldest,
    backfillComplete: next.backfillComplete,
  };
  const nextSession = {
    ...sessionState,
    session: clientState.client.exportSession(),
    tradeCursors,
  };
  await updateTdccRunState(env.DB, {
    runId: run.id,
    encryptedSession: await encryptJson(nextSession, configEncryptionKey(env)),
  });

  const maxPages = task.maxPages;
  const canContinue =
    next.nextTxnSerNo &&
    next.nextTxnSerNo !== (task.txnSerNo ?? "") &&
    page.returnCode !== "D0002" &&
    transactions.length > 0 &&
    item.page_number + 1 < maxPages;
  if (canContinue) {
    await assertTdccPageNotSeen(
      env,
      run.id,
      "trade_page",
      item.task_key,
      next.nextTxnSerNo,
    );
    await insertNextTdccRunItem(env.DB, run.id, {
      taskType: "trade_page",
      taskKey: item.task_key,
      accountId: item.account_id,
      pageCursor: next.nextTxnSerNo,
      pageNumber: item.page_number + 1,
      task: {
        ...task,
        txnSerNo: next.nextTxnSerNo,
        newest: next.newest,
        oldest: next.oldest,
        backfillComplete: next.backfillComplete,
      },
    });
  }
  await markTdccRunItemSucceeded(env.DB, {
    runId: run.id,
    itemId: item.id,
    claimToken,
    payload: { returnCode: page.returnCode, itemCount: transactions.length },
    nextPageCursor: canContinue ? next.nextTxnSerNo : null,
  });
}

async function promoteTdccRun(env: Env, run: TdccRunRow) {
  if (run.pending_item_count > 0 || run.processing_item_count > 0) {
    throw new Error("TDCC run is not ready for promotion.");
  }
  const settings = await requireTdccSettings(env);
  if (run.settings_version && settings.updated_at !== run.settings_version) {
    throw new NeedsUserActionError(
      "集保設定已在同步期間更新，請重新啟動同步。",
    );
  }
  const config = await loadRunConfig(env, run);
  const session = await loadRunSession(env, run);
  if (!session)
    throw new NeedsUserActionError("集保登入狀態已失效，請重新驗證。");
  const now = new Date().toISOString();
  const bankTransactions = await bankTransactionsFromRun(env, run);
  await stageSyncWriteRecords(
    env.DB,
    run.id,
    bankTransactions.map((transaction) =>
      bankTransactionRecord("tdcc", transaction, now),
    ),
  );

  const cursor = JSON.stringify(session);
  const cursorState = splitConnectorCursorState("tdcc", cursor);
  const {
    otp: _otp,
    otpChannel: _otpChannel,
    requestOtp: _requestOtp,
    ...reusableConfig
  } = config;
  const encryptedConfig = await encryptJson(
    {
      ...reusableConfig,
      ...cursorState.secretState,
    },
    configEncryptionKey(env),
  );
  const job = await findSyncJob(env.DB, "tdcc", "all");
  const finalizeStatements: D1PreparedStatement[] = [
    connectorStateStatement(
      env.DB,
      "tdcc",
      encryptedConfig,
      serializePublicConnectorConfig("tdcc", reusableConfig),
      cursorState.safeCursor,
      now,
    ),
  ];
  if (job) {
    const nextRunAt = nextSyncRunAt(
      job.interval_minutes,
      job.preferred_time,
      new Date(now),
      job.next_run_at,
      job.preferred_weekday,
    );
    finalizeStatements.push(
      env.DB.prepare(
        `UPDATE sync_jobs
           SET last_status = 'success', last_error = NULL,
               last_run_at = ?, last_success_at = ?, next_run_at = ?,
               locked_by = NULL, locked_until = NULL,
               lock_trigger = NULL, lock_scope = NULL, updated_at = ?
           WHERE id = ? AND locked_by = ?`,
      ).bind(now, now, nextRunAt, now, job.id, run.id),
    );
  }
  const entityTypes = entityTypesForScope(run.scope);
  const newRecords = await promoteStagedSyncWrite(env.DB, {
    runId: run.id,
    entityTypes,
    afterPromoteStatements: includesBank(run.scope)
      ? [linkCanonicalBankAccountsStatement(env.DB)]
      : [],
    finalizeStatements,
  });
  if (includesBank(run.scope)) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }
  await updateTdccRunState(env.DB, {
    runId: run.id,
    encryptedConfig: null,
    encryptedSession: null,
    phase: "promote",
    status: "promoting",
  });
  await finishTdccJobAfterPromotion(env, run, newRecords);
}

async function finalizeTdccRunOutcome(env: Env, run: TdccRunRow) {
  return finalizeTdccRun(env.DB, {
    runId: run.id,
    status: "completed",
    phase: "promote",
    promotedAt: run.promoted_at ?? new Date().toISOString(),
  });
}

async function finishTdccJobAfterPromotion(
  env: Env,
  run: TdccRunRow,
  newRecords: SyncNewRecordCounts,
) {
  if (run.trigger === "manual" && run.scope === "all") {
    await recoverLatestScheduledSyncSource(env.DB, {
      connectorId: "tdcc",
      newRecords,
    }).catch((error) =>
      console.error("[sync] failed to recover latest TDCC report", error),
    );
  }
  if (run.scheduled_batch_id) {
    const job = await findSyncJob(env.DB, "tdcc", "all");
    if (job) {
      await env.DB.prepare(
        `UPDATE scheduled_sync_batch_results
           SET connector_id = 'tdcc', status = 'success', completed_at = ?,
               new_invoices = 0, new_bank_transactions = ?,
               new_investment_transactions = ?
           WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL`,
      )
        .bind(
          new Date().toISOString(),
          newRecords.bankTransactions,
          newRecords.investmentTransactions,
          run.scheduled_batch_id,
          job.id,
        )
        .run();
    }
    const summary = await claimCompletedDefaultScheduleBatch(
      env.DB,
      run.scheduled_batch_id,
    );
    if (summary) await safelySendScheduledSyncSummary(env, summary);
  } else if (run.trigger === "scheduled") {
    await safelySendSyncNotification(env, {
      connectorId: "tdcc",
      status: "success",
    });
  }
}

async function finishTdccJob(
  env: Env,
  run: TdccRunRow,
  status: Exclude<SyncNotificationStatus, "success">,
  error: string,
  newRecords: SyncNewRecordCounts,
) {
  const job = await findSyncJob(env.DB, "tdcc", "all");
  if (job) {
    const now = new Date().toISOString();
    const nextRunAt =
      status === "failed"
        ? nextSyncRunAt(
            job.interval_minutes,
            job.preferred_time,
            new Date(now),
            job.next_run_at,
            job.preferred_weekday,
          )
        : job.next_run_at;
    await env.DB.prepare(
      `UPDATE sync_jobs
         SET last_status = ?, last_error = ?, last_run_at = ?, next_run_at = ?,
             locked_by = NULL, locked_until = NULL,
             lock_trigger = NULL, lock_scope = NULL, updated_at = ?
         WHERE id = ? AND locked_by = ?`,
    )
      .bind(status, error, now, nextRunAt, now, job.id, run.id)
      .run();
    if (run.scheduled_batch_id) {
      await env.DB.prepare(
        `UPDATE scheduled_sync_batch_results
           SET connector_id = 'tdcc', status = ?, completed_at = ?,
               new_invoices = 0, new_bank_transactions = ?,
               new_investment_transactions = ?
           WHERE batch_id = ? AND job_id = ? AND completed_at IS NULL`,
      )
        .bind(
          status,
          now,
          newRecords.bankTransactions,
          newRecords.investmentTransactions,
          run.scheduled_batch_id,
          job.id,
        )
        .run();
    }
  }
  if (run.scheduled_batch_id) {
    const summary = await claimCompletedDefaultScheduleBatch(
      env.DB,
      run.scheduled_batch_id,
    );
    if (summary) await safelySendScheduledSyncSummary(env, summary);
  } else if (run.trigger === "scheduled") {
    await safelySendSyncNotification(env, { connectorId: "tdcc", status });
  }
}

async function requireTdccSettings(env: Env) {
  const settings = await getConnectorSettings(env.DB, "tdcc");
  if (!settings) throw new NeedsUserActionError("請先儲存集保 e 存摺設定。");
  return settings;
}

async function loadRunConfig(env: Env, run: TdccRunRow) {
  if (!run.encrypted_config) {
    throw new NeedsUserActionError("集保同步設定已遺失，請重新啟動同步。");
  }
  return parseTdccConfig(
    await decryptJson<Record<string, unknown>>(
      run.encrypted_config,
      configEncryptionKey(env),
    ),
  );
}

async function loadRunSession(env: Env, run: TdccRunRow) {
  if (run.encrypted_session) {
    return decryptJson<TdccCursorState>(
      run.encrypted_session,
      configEncryptionKey(env),
    );
  }
  if (!run.session_json) return null;
  return JSON.parse(run.session_json) as TdccCursorState;
}

async function persistClientSession(
  env: Env,
  runId: string,
  state: ReturnType<typeof createTdccClient>,
) {
  const sessionState: TdccCursorState = {
    ...state.identity,
    session: state.client.exportSession(),
    tradeCursors: state.previous?.tradeCursors,
  };
  await updateTdccRunState(env.DB, {
    runId,
    encryptedSession: await encryptJson(sessionState, configEncryptionKey(env)),
  });
}

async function bankTransactionsFromRun(env: Env, run: TdccRunRow) {
  const items = await listCompletedItems(env, run.id, "bank_page");
  const transactions = [] as Array<{
    accountId: string;
    sourceId: string;
    postedDate?: string;
    amount: number;
    currency: string;
    description?: string;
    raw: unknown;
  }>;
  const detailsByAccount = new Map<
    string,
    { task: BankPageTask; details: BankTransactionDetail[] }
  >();
  for (const item of items) {
    const payload = parseJson<{ details?: BankTransactionDetail[] }>(
      item.payload_json,
    );
    const task = parseTask(item.task_json) as BankPageTask;
    const accountId = `settlement:${task.bankId}:${task.accountNo}:${task.currency}`;
    const current = detailsByAccount.get(accountId) ?? { task, details: [] };
    current.details.push(...(payload.details ?? []));
    detailsByAccount.set(accountId, current);
  }
  for (const { task, details } of detailsByAccount.values()) {
    const normalized = normalizeBankTransactionDetails(details);
    const accountId = `settlement:${task.bankId}:${task.accountNo}:${task.currency}`;
    for (const transaction of normalized) {
      const amount = Number(transaction.amount);
      transactions.push({
        accountId,
        sourceId: transaction.txnId,
        postedDate: transaction.occurredAt,
        amount: Number.isFinite(amount) ? amount : 0,
        currency: task.currency,
        ...(transaction.memo ? { description: transaction.memo } : {}),
        raw: transaction,
      });
    }
  }
  return transactions;
}

async function listCompletedItems(env: Env, runId: string, taskType: string) {
  return (
    await env.DB.prepare(
      `SELECT * FROM tdcc_sync_run_items
         WHERE run_id = ? AND task_type = ? AND status = 'done'`,
    )
      .bind(runId, taskType)
      .all<TdccRunItemRow>()
  ).results;
}

async function assertTdccPageNotSeen(
  env: Env,
  runId: string,
  taskType: string,
  taskKey: string,
  pageCursor: string,
) {
  const existing = await env.DB.prepare(
    `SELECT status FROM tdcc_sync_run_items
       WHERE run_id = ? AND task_type = ? AND task_key = ? AND page_cursor = ?`,
  )
    .bind(runId, taskType, taskKey, pageCursor)
    .first<{ status: string }>();
  if (existing?.status === "done") {
    throw new Error("TDCC pagination returned a repeated page cursor.");
  }
}

function snapshotRecords(
  _env: Env,
  scope: TdccRunScope,
  initialized: TdccSnapshotInitialization,
  now: string,
) {
  const snapshot = initialized.snapshot ?? normalizeTdccSnapshot(initialized);
  return [
    ...(includesBank(scope)
      ? snapshot.bankAccounts.map((record) =>
          bankAccountRecord("tdcc", record, now),
        )
      : []),
    ...(includesBank(scope)
      ? snapshot.bankBalanceSnapshots.map((record) =>
          bankBalanceSnapshotRecord("tdcc", record, now),
        )
      : []),
    ...(includesInvestments(scope)
      ? snapshot.investmentPositions.map((record) =>
          investmentPositionRecord("tdcc", record, now),
        )
      : []),
    ...(scope !== "trades"
      ? snapshot.netWorthHistory.map((record) =>
          netWorthHistoryRecord("tdcc", record, now),
        )
      : []),
  ];
}

async function createTdccPageItems(
  env: Env,
  run: TdccRunRow,
  initialized: TdccSnapshotInitialization,
  tradeHistoryMaxPages: number,
) {
  const previous = initialized.previous;
  if (includesBank(run.scope)) {
    for (const entry of initialized.bankEntries) {
      const taskKey = `${entry.bankId}:${entry.accountNo}:${entry.currency}`;
      await insertNextTdccRunItem(env.DB, run.id, {
        taskType: "bank_page",
        taskKey,
        accountId: taskKey,
        pageCursor: "",
        pageNumber: 0,
        task: {
          bankId: entry.bankId,
          accountNo: entry.accountNo,
          currency: entry.currency,
        } satisfies BankPageTask,
      });
    }
  }
  if (includesTrades(run.scope)) {
    for (const account of initialized.stockAccounts) {
      const cursorKey = `${account.brokerNo}:${account.brokerAccount}`;
      const saved = previous?.tradeCursors?.[cursorKey] ?? {};
      const updateType: "B" | "F" = saved.backfillComplete ? "F" : "B";
      const txnSerNo =
        updateType === "F" ? (saved.newest ?? "") : (saved.oldest ?? "");
      await insertNextTdccRunItem(env.DB, run.id, {
        taskType: "trade_page",
        taskKey: cursorKey,
        accountId: cursorKey,
        pageCursor: txnSerNo,
        pageNumber: 0,
        task: {
          brokerNo: account.brokerNo,
          brokerAccount: account.brokerAccount,
          brokerName: account.brokerName,
          updateType,
          txnSerNo,
          newest: saved.newest,
          oldest: saved.oldest,
          backfillComplete: saved.backfillComplete,
          maxPages: tradeHistoryMaxPages,
        } satisfies TradePageTask,
      });
    }
  }
}

function tradeTaskAfterPage(
  task: TradePageTask,
  transactions: ReturnType<typeof parseTdccTradePageItems>,
  returnCode: string,
) {
  let newest = task.newest;
  let oldest = task.oldest;
  let backfillComplete = task.backfillComplete ?? false;
  if (transactions.length > 0) {
    newest = newest ?? transactions[0]?.sourceId;
    oldest = transactions.at(-1)?.sourceId ?? oldest;
  } else if (task.updateType === "B" || returnCode === "D0002") {
    backfillComplete = task.updateType === "B" ? true : backfillComplete;
  }
  return {
    newest,
    oldest,
    backfillComplete,
    nextTxnSerNo: task.updateType === "F" ? (newest ?? "") : (oldest ?? ""),
  };
}

function firstPendingPhase(
  scope: TdccRunScope,
  initialized: TdccSnapshotInitialization,
) {
  if (includesBank(scope) && initialized.bankEntries.length > 0)
    return "bank" as const;
  if (includesTrades(scope) && initialized.stockAccounts.length > 0)
    return "trades" as const;
  return "promote" as const;
}

function entityTypesForScope(scope: TdccRunScope) {
  return [
    ...(includesBank(scope)
      ? (["bank_account", "bank_balance_snapshot", "bank_transaction"] as const)
      : []),
    ...(includesInvestments(scope) ? (["investment_position"] as const) : []),
    ...(includesTrades(scope) ? (["investment_transaction"] as const) : []),
    ...(scope !== "trades" ? (["net_worth_history"] as const) : []),
  ];
}

function includesBank(scope: TdccRunScope) {
  return scope === "all" || scope === "bank";
}

function includesInvestments(scope: TdccRunScope) {
  return scope === "all" || scope === "investments";
}

function includesTrades(scope: TdccRunScope) {
  return scope === "all" || scope === "trades";
}

function parseTask(value: string) {
  return JSON.parse(value) as BankPageTask | TradePageTask;
}

function parseJson<T>(value: string | null): T {
  return value ? (JSON.parse(value) as T) : ({} as T);
}

function emptyNewRecords(): SyncNewRecordCounts {
  return { invoices: 0, bankTransactions: 0, investmentTransactions: 0 };
}

async function clearTdccStaging(env: Env, runId: string) {
  await env.DB.prepare("DELETE FROM sync_write_staging WHERE run_id = ?")
    .bind(runId)
    .run()
    .catch(() => undefined);
}

async function holdTdccRunLock(
  db: D1Database,
  runId: string,
  trigger: TdccRunTrigger,
  scope: TdccRunScope,
) {
  const now = new Date();
  const result = await db
    .prepare(
      `UPDATE sync_jobs
       SET locked_by = ?, locked_until = ?, lock_trigger = ?, lock_scope = ?,
           updated_at = ?
       WHERE id = ?
         AND (locked_until IS NULL OR locked_until < ? OR locked_by = ?)`,
    )
    .bind(
      runId,
      new Date(now.getTime() + SYNC_LOCK_LEASE_MS).toISOString(),
      trigger,
      scope,
      now.toISOString(),
      TDCC_JOB_ID,
      now.toISOString(),
      runId,
    )
    .run();
  return result.meta.changes === 1;
}

function requireTdccCredentials(config: {
  userId?: string;
  password?: string;
}) {
  if (!config.userId || !config.password) {
    throw new NeedsUserActionError(
      "請重新輸入身分證字號與集保 App 密碼，再開始連線。",
    );
  }
}

function isTerminal(run: TdccRunRow) {
  return ["completed", "failed", "needs_user_action"].includes(run.status);
}

type BankPageTask = {
  bankId: string;
  accountNo: string;
  currency: string;
};

type TradePageTask = TdccStockAccount & {
  updateType: "B" | "F";
  txnSerNo?: string;
  newest?: string;
  oldest?: string;
  backfillComplete?: boolean;
  maxPages: number;
};
