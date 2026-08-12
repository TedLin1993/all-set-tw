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
  newInvoices: number;
  newBankTransactions: number;
  newInvestmentTransactions: number;
};

export async function calculateCurrentFinancialSnapshot(
  db: D1Database,
): Promise<FinancialSnapshot> {
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
  const row = await db
    .prepare(
      `SELECT EXISTS (
         SELECT 1
         FROM scheduled_sync_batches batch
         WHERE batch.completed_at IS NOT NULL
           AND batch.assets_after_twd IS NOT NULL
           AND batch.credit_card_debt_after_twd IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM scheduled_sync_batch_results result
             WHERE result.batch_id = batch.id AND result.status = 'success'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM scheduled_sync_batch_results result
             WHERE result.batch_id = batch.id
               AND result.status IN ('failed', 'needs_user_action')
           )
       ) AS value`,
    )
    .first<{ value: number }>();
  return Boolean(row?.value);
}

export async function getLatestScheduledSyncReport(
  db: D1Database,
): Promise<ScheduledSyncReport | null> {
  const batch = await db
    .prepare(
      `SELECT
         id,
         created_at AS startedAt,
         completed_at AS completedAt,
         is_baseline AS isBaseline,
         assets_before_twd AS assetsBeforeTwd,
         credit_card_debt_before_twd AS creditCardDebtBeforeTwd,
         missing_currencies_before AS missingCurrenciesBefore,
         assets_after_twd AS assetsAfterTwd,
         credit_card_debt_after_twd AS creditCardDebtAfterTwd,
         missing_currencies_after AS missingCurrenciesAfter
       FROM scheduled_sync_batches
       WHERE completed_at IS NOT NULL
       ORDER BY completed_at DESC, created_at DESC
       LIMIT 1`,
    )
    .first<CompletedBatchRow>();
  if (!batch) return null;

  const result = await db
    .prepare(
      `SELECT
         connector_id AS connectorId,
         status,
         completed_at AS completedAt,
         new_invoices AS newInvoices,
         new_bank_transactions AS newBankTransactions,
         new_investment_transactions AS newInvestmentTransactions
       FROM scheduled_sync_batch_results
       WHERE batch_id = ? AND status IS NOT NULL AND completed_at IS NOT NULL
       ORDER BY job_id ASC`,
    )
    .bind(batch.id)
    .all<CompletedBatchResultRow>();
  const sources = result.results.map(mapSourceReport);
  const status = summaryStatus(sources);
  const newRecords = sumNewRecords(sources);
  const missingCurrencies = [
    ...new Set([
      ...parseStringArray(batch.missingCurrenciesBefore),
      ...parseStringArray(batch.missingCurrenciesAfter),
    ]),
  ].sort();
  const financialChangeUnavailableReason = unavailableReason({
    batch,
    status,
  });

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
  };
}

function mapSourceReport(
  row: CompletedBatchResultRow,
): ScheduledSyncSourceReport {
  return {
    connectorId: row.connectorId,
    status: row.status,
    completedAt: row.completedAt,
    newRecords: {
      invoices: row.newInvoices,
      bankTransactions: row.newBankTransactions,
      investmentTransactions: row.newInvestmentTransactions,
    },
  };
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

function unavailableReason(input: {
  batch: CompletedBatchRow;
  status: SyncNotificationStatus;
}): SyncFinancialChangeUnavailableReason | null {
  if (input.status !== "success") return "partial_sync";
  if (input.batch.isBaseline) return "baseline";
  if (
    input.batch.assetsBeforeTwd === null ||
    input.batch.creditCardDebtBeforeTwd === null ||
    input.batch.assetsAfterTwd === null ||
    input.batch.creditCardDebtAfterTwd === null
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
