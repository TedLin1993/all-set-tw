import {
  createDrizzle,
  sanitizeDatabaseError,
  scheduledSyncBatches,
  scheduledSyncBatchResults,
} from "@taiwan-fin-hub/db";
import {
  and,
  desc,
  asc,
  eq,
  isNull,
  isNotNull,
  inArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type {
  ConnectorId,
  ScheduledSyncReport,
  ScheduledSyncSourceReport,
  SyncFinancialChangeUnavailableReason,
  SyncNewRecordCounts,
  SyncNotificationStatus,
} from "@taiwan-fin-hub/core";

export type FinancialSnapshot = {
  assetsTwd: number;
  creditCardDebtTwd: number;
  missingCurrencies: string[];
};

type FinancialSnapshotRow = {
  assetsTwd: number;
  creditCardDebtTwd: number;
  missingCurrencies: string | null;
};

type CompletedBatchRow = {
  id: string;
  startedAt: string;
  completedAt: string;
  isBaseline: number;
  assetsBeforeTwd: number | null;
  creditCardDebtBeforeTwd: number | null;
  missingCurrenciesBefore: string;
  assetsAfterTwd: number | null;
  creditCardDebtAfterTwd: number | null;
  missingCurrenciesAfter: string;
};

type CompletedBatchResultRow = {
  connectorId: ConnectorId;
  status: SyncNotificationStatus;
  completedAt: string;
  recoveredAt: string | null;
  newInvoices: number;
  newBankTransactions: number;
  newInvestmentTransactions: number;
};

/**
 * Apply a successful manual sync to the latest completed default schedule
 * report when that report contains the same connector's failed source.
 *
 * The source's scheduled completion time remains unchanged. `recovered_at`
 * records the later manual repair, while the batch's after-snapshot is
 * refreshed against the now-current financial data.
 */
export async function recoverLatestScheduledSyncSource(
  db: D1Database,
  input: {
    connectorId: ConnectorId;
    newRecords: SyncNewRecordCounts;
    batchId?: string | null;
  },
) {
  // A caller that captured no failed report must not accidentally repair a
  // newly-completed batch while its manual sync was running. Omitted input is
  // reserved for asynchronous flows that resolve their target at completion.
  if (input.batchId === null) return false;
  const orm = createDrizzle(db);
  const latestBatch = alias(scheduledSyncBatches, "latest");
  const latestCompletedId = orm
    .select({ id: latestBatch.id })
    .from(latestBatch)
    .where(isNotNull(latestBatch.completedAt))
    .orderBy(desc(latestBatch.completedAt), desc(latestBatch.createdAt))
    .limit(1);
  const latest = await orm
    .select({
      batchId: scheduledSyncBatches.id,
      jobId: scheduledSyncBatchResults.jobId,
    })
    .from(scheduledSyncBatches)
    .innerJoin(
      scheduledSyncBatchResults,
      eq(scheduledSyncBatchResults.batchId, scheduledSyncBatches.id),
    )
    .where(
      and(
        isNotNull(scheduledSyncBatches.completedAt),
        eq(scheduledSyncBatches.id, latestCompletedId),
        inArray(scheduledSyncBatchResults.status, [
          "failed",
          "needs_user_action",
        ]),
        isNull(scheduledSyncBatchResults.recoveredAt),
        eq(scheduledSyncBatchResults.connectorId, input.connectorId),
        input.batchId === undefined
          ? undefined
          : eq(scheduledSyncBatches.id, input.batchId),
      ),
    )
    .orderBy(
      desc(scheduledSyncBatches.completedAt),
      desc(scheduledSyncBatches.createdAt),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  if (!latest) return false;

  // Read the post-recovery snapshot before touching the report rows. The
  // subsequent batch keeps the result transition and snapshot update in one
  // D1 transaction.
  const snapshot = await calculateCurrentFinancialSnapshot(db);
  const recoveredAt = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE scheduled_sync_batch_results
         SET status = 'success',
             recovered_at = ?,
             new_invoices = new_invoices + ?,
             new_bank_transactions = new_bank_transactions + ?,
             new_investment_transactions = new_investment_transactions + ?
         WHERE batch_id = ?
           AND job_id = ?
           AND status IN ('failed', 'needs_user_action')
           AND recovered_at IS NULL`,
      )
      .bind(
        recoveredAt,
        input.newRecords.invoices,
        input.newRecords.bankTransactions,
        input.newRecords.investmentTransactions,
        latest.batchId,
        latest.jobId,
      ),
    db
      .prepare(
        `UPDATE scheduled_sync_batches
         SET assets_after_twd = ?,
             credit_card_debt_after_twd = ?,
             missing_currencies_after = ?
         WHERE id = ?
           AND completed_at IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM scheduled_sync_batch_results
             WHERE batch_id = ? AND job_id = ? AND recovered_at = ?
           )`,
      )
      .bind(
        snapshot.assetsTwd,
        snapshot.creditCardDebtTwd,
        JSON.stringify(snapshot.missingCurrencies),
        latest.batchId,
        latest.batchId,
        latest.jobId,
        recoveredAt,
      ),
  ]);
  return results[0]?.meta.changes === 1;
}

/** Capture the latest failed source before a manual sync starts. */
export async function findLatestRecoverableScheduledBatchId(
  db: D1Database,
  connectorId: ConnectorId,
) {
  const orm = createDrizzle(db);
  const latestBatch = alias(scheduledSyncBatches, "latest");
  const latestCompletedId = orm
    .select({ id: latestBatch.id })
    .from(latestBatch)
    .where(isNotNull(latestBatch.completedAt))
    .orderBy(desc(latestBatch.completedAt), desc(latestBatch.createdAt))
    .limit(1);
  const row = await orm
    .select({ batchId: scheduledSyncBatches.id })
    .from(scheduledSyncBatches)
    .innerJoin(
      scheduledSyncBatchResults,
      eq(scheduledSyncBatchResults.batchId, scheduledSyncBatches.id),
    )
    .where(
      and(
        isNotNull(scheduledSyncBatches.completedAt),
        eq(scheduledSyncBatches.id, latestCompletedId),
        inArray(scheduledSyncBatchResults.status, [
          "failed",
          "needs_user_action",
        ]),
        isNull(scheduledSyncBatchResults.recoveredAt),
        eq(scheduledSyncBatchResults.connectorId, connectorId),
      ),
    )
    .orderBy(
      desc(scheduledSyncBatches.completedAt),
      desc(scheduledSyncBatches.createdAt),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return row?.batchId ?? null;
}

export async function calculateCurrentFinancialSnapshot(
  db: D1Database,
): Promise<FinancialSnapshot> {
  // 跨資產最新值、匯率與缺幣清單的 CTE 聚合保留 SQL；本批轉換一般讀取。
  const row = await db
    .prepare(
      `WITH latest_bank_balances AS (
         SELECT
           account.account_type AS account_type,
           balance.balance AS amount,
           balance.currency AS currency
         FROM bank_accounts account
         JOIN bank_balance_snapshots balance
           ON balance.id = (
             SELECT latest.id
             FROM bank_balance_snapshots latest
             WHERE latest.account_id = account.id
             ORDER BY latest.as_of_at DESC, latest.updated_at DESC
             LIMIT 1
           )
         WHERE account.canonical_account_id IS NULL
       ), latest_investments AS (
         SELECT
           COALESCE(position.market_value, 0) + COALESCE(position.cash_balance, 0) AS amount,
           position.currency AS currency
         FROM investment_positions position
         WHERE position.as_of_date = (
           SELECT MAX(latest.as_of_date)
           FROM investment_positions latest
           WHERE latest.connector_id = position.connector_id
             AND latest.asset_type = position.asset_type
         )
       ), latest_manual_assets AS (
         SELECT
           history.net_worth AS amount,
           asset.currency AS currency
         FROM manual_assets asset
         JOIN net_worth_history history
           ON history.id = (
             SELECT latest.id
             FROM net_worth_history latest
             WHERE latest.source = 'manual'
               AND latest.asset_type = asset.id
             ORDER BY latest.date DESC, latest.snapshotted_at DESC
             LIMIT 1
           )
       ), financial_items AS (
         SELECT
           CASE WHEN account_type = 'credit' THEN 'debt' ELSE 'asset' END AS kind,
           amount,
           currency
         FROM latest_bank_balances
         UNION ALL
         SELECT 'asset', amount, currency FROM latest_investments
         UNION ALL
         SELECT 'asset', amount, currency FROM latest_manual_assets
       ), valued_items AS (
         SELECT
           item.kind,
           item.amount,
           COALESCE(NULLIF(item.currency, ''), 'TWD') AS currency,
           CASE
             WHEN COALESCE(NULLIF(item.currency, ''), 'TWD') != 'TWD'
               AND rate.rate_to_twd IS NULL
               THEN 1
             ELSE 0
           END AS is_missing_rate,
           CASE
             WHEN COALESCE(NULLIF(item.currency, ''), 'TWD') = 'TWD'
               THEN item.amount
             WHEN rate.rate_to_twd IS NOT NULL
               THEN item.amount * rate.rate_to_twd
             ELSE 0
           END AS amount_twd
         FROM financial_items item
         LEFT JOIN exchange_rates rate
           ON rate.currency = COALESCE(NULLIF(item.currency, ''), 'TWD')
       )
       SELECT
         COALESCE(ROUND(SUM(CASE WHEN kind = 'asset' THEN amount_twd ELSE 0 END)), 0) AS assetsTwd,
         COALESCE(ROUND(SUM(CASE WHEN kind = 'debt' THEN ABS(amount_twd) ELSE 0 END)), 0) AS creditCardDebtTwd,
         COALESCE(
           json_group_array(DISTINCT currency) FILTER (
             WHERE (
               (kind = 'debt' AND ABS(amount) > 0)
               OR (kind = 'asset' AND amount > 0)
             )
               AND is_missing_rate = 1
           ),
           '[]'
         ) AS missingCurrencies
       FROM valued_items`,
    )
    .first<FinancialSnapshotRow>();
  return {
    assetsTwd: row?.assetsTwd ?? 0,
    creditCardDebtTwd: row?.creditCardDebtTwd ?? 0,
    missingCurrencies: parseStringArray(row?.missingCurrencies).sort(),
  };
}

export async function hasCompletedFinancialBaseline(db: D1Database) {
  const row = await createDrizzle(db)
    .select({ id: scheduledSyncBatches.id })
    .from(scheduledSyncBatches)
    .where(
      and(
        isNotNull(scheduledSyncBatches.completedAt),
        isNotNull(scheduledSyncBatches.assetsAfterTwd),
        isNotNull(scheduledSyncBatches.creditCardDebtAfterTwd),
        sql`EXISTS (SELECT 1 FROM ${scheduledSyncBatchResults} WHERE ${scheduledSyncBatchResults.batchId} = ${scheduledSyncBatches.id} AND ${scheduledSyncBatchResults.status} = 'success')`,
        sql`NOT EXISTS (SELECT 1 FROM ${scheduledSyncBatchResults} WHERE ${scheduledSyncBatchResults.batchId} = ${scheduledSyncBatches.id} AND ${scheduledSyncBatchResults.status} IN ('failed', 'needs_user_action'))`,
      ),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  return row !== undefined;
}

export async function getLatestScheduledSyncReport(
  db: D1Database,
): Promise<ScheduledSyncReport | null> {
  const batch = await createDrizzle(db)
    .select({
      id: scheduledSyncBatches.id,
      startedAt: scheduledSyncBatches.createdAt,
      completedAt: sql<string>`${scheduledSyncBatches.completedAt}`,
      isBaseline: scheduledSyncBatches.isBaseline,
      assetsBeforeTwd: scheduledSyncBatches.assetsBeforeTwd,
      creditCardDebtBeforeTwd: scheduledSyncBatches.creditCardDebtBeforeTwd,
      missingCurrenciesBefore: scheduledSyncBatches.missingCurrenciesBefore,
      assetsAfterTwd: scheduledSyncBatches.assetsAfterTwd,
      creditCardDebtAfterTwd: scheduledSyncBatches.creditCardDebtAfterTwd,
      missingCurrenciesAfter: scheduledSyncBatches.missingCurrenciesAfter,
    })
    .from(scheduledSyncBatches)
    .where(isNotNull(scheduledSyncBatches.completedAt))
    .orderBy(
      desc(scheduledSyncBatches.completedAt),
      desc(scheduledSyncBatches.createdAt),
    )
    .limit(1)
    .get()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  if (!batch) return null;

  const result = await createDrizzle(db)
    .select({
      connectorId: sql<
        CompletedBatchResultRow["connectorId"]
      >`${scheduledSyncBatchResults.connectorId}`,
      status: sql<
        CompletedBatchResultRow["status"]
      >`${scheduledSyncBatchResults.status}`,
      completedAt: sql<
        CompletedBatchResultRow["completedAt"]
      >`${scheduledSyncBatchResults.completedAt}`,
      recoveredAt: scheduledSyncBatchResults.recoveredAt,
      newInvoices: scheduledSyncBatchResults.newInvoices,
      newBankTransactions: scheduledSyncBatchResults.newBankTransactions,
      newInvestmentTransactions:
        scheduledSyncBatchResults.newInvestmentTransactions,
    })
    .from(scheduledSyncBatchResults)
    .where(
      and(
        eq(scheduledSyncBatchResults.batchId, batch.id),
        isNotNull(scheduledSyncBatchResults.status),
        isNotNull(scheduledSyncBatchResults.completedAt),
      ),
    )
    .orderBy(asc(scheduledSyncBatchResults.jobId))
    .all()
    .catch((error) => {
      throw sanitizeDatabaseError(error);
    });
  const sources = result.map(mapSourceReport);
  const status = summaryStatus(sources);
  const newRecords = sumNewRecords(sources);
  const missingCurrencies = [
    ...new Set([
      ...parseStringArray(batch.missingCurrenciesBefore),
      ...parseStringArray(batch.missingCurrenciesAfter),
    ]),
  ].sort();
  const financialChangeUnavailableReason = unavailableReason(batch);

  return {
    id: batch.id,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    status,
    sources,
    sourceSummary: {
      total: sources.length,
      success: sources.filter((source) => source.status === "success").length,
      failed: sources.filter((source) => source.status === "failed").length,
      needsUserAction: sources.filter(
        (source) => source.status === "needs_user_action",
      ).length,
    },
    newRecords,
    financialChange:
      financialChangeUnavailableReason === null
        ? {
            assets: batch.assetsAfterTwd! - batch.assetsBeforeTwd!,
            creditCardDebt:
              batch.creditCardDebtAfterTwd! - batch.creditCardDebtBeforeTwd!,
            netWorth:
              batch.assetsAfterTwd! -
              batch.creditCardDebtAfterTwd! -
              (batch.assetsBeforeTwd! - batch.creditCardDebtBeforeTwd!),
          }
        : null,
    financialChangeUnavailableReason,
    missingCurrencies,
    recoveredAt: latestRecoveryAt(sources),
  };
}

function mapSourceReport(
  row: CompletedBatchResultRow,
): ScheduledSyncSourceReport {
  return {
    connectorId: row.connectorId,
    status: row.status,
    completedAt: row.completedAt,
    recoveredAt: row.recoveredAt,
    newRecords: {
      invoices: row.newInvoices,
      bankTransactions: row.newBankTransactions,
      investmentTransactions: row.newInvestmentTransactions,
    },
  };
}

function latestRecoveryAt(sources: ScheduledSyncSourceReport[]) {
  return (
    sources
      .map((source) => source.recoveredAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null
  );
}

function sumNewRecords(sources: ScheduledSyncSourceReport[]) {
  return sources.reduce<SyncNewRecordCounts>(
    (total, source) => ({
      invoices: total.invoices + source.newRecords.invoices,
      bankTransactions:
        total.bankTransactions + source.newRecords.bankTransactions,
      investmentTransactions:
        total.investmentTransactions + source.newRecords.investmentTransactions,
    }),
    { invoices: 0, bankTransactions: 0, investmentTransactions: 0 },
  );
}

function summaryStatus(sources: ScheduledSyncSourceReport[]) {
  if (sources.some((source) => source.status === "needs_user_action")) {
    return "needs_user_action" as const;
  }
  if (sources.some((source) => source.status === "failed")) {
    return "failed" as const;
  }
  return "success" as const;
}

function unavailableReason(
  batch: CompletedBatchRow,
): SyncFinancialChangeUnavailableReason | null {
  if (batch.isBaseline) return "baseline";
  if (
    batch.assetsBeforeTwd === null ||
    batch.creditCardDebtBeforeTwd === null ||
    batch.assetsAfterTwd === null ||
    batch.creditCardDebtAfterTwd === null
  ) {
    return "snapshot_unavailable";
  }
  return null;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
