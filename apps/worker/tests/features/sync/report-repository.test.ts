import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateCurrentFinancialSnapshot,
  findLatestRecoverableScheduledBatchId,
  getLatestScheduledSyncReport,
  hasCompletedFinancialBaseline,
  recoverLatestScheduledSyncSource,
} from "../../../src/features/sync/report-repository";

class SqliteStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.database
      .prepare(this.sql)
      .run(...(this.values as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }

  async first<T>() {
    return (
      (this.database.prepare(this.sql).get(...(this.values as never[])) as T) ??
      null
    );
  }

  async all<T>() {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as never[])) as T[],
    };
  }
}

function createDb(options: { failBatchAt?: number } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationsDirectory = fileURLToPath(
    new URL("../../../../../packages/db/migrations/", import.meta.url),
  );
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${file}`, "utf8"));
  }
  const db = {
    prepare(sql: string) {
      return new SqliteStatement(database, sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const [index, statement] of statements.entries()) {
          if (options.failBatchAt === index) {
            throw new Error("simulated D1 batch failure");
          }
          results.push(await (statement as unknown as SqliteStatement).run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, db };
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("scheduled sync financial reports", () => {
  it("uses the same latest-value and TWD conversion rules as the overview", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO exchange_rates (currency, rate_to_twd, updated_at)
      VALUES ('USD', 32, '2026-08-12');

      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('deposit', 'esun', 'deposit', 'savings', 'USD', '{}', '2026-08-12', '2026-08-12'),
        ('card', 'esun', 'card', 'credit', 'TWD', '{}', '2026-08-12', '2026-08-12');
      INSERT INTO bank_balance_snapshots
        (id, connector_id, account_id, source_id, balance, currency, as_of_at, raw_payload, created_at, updated_at)
      VALUES
        ('deposit-old', 'esun', 'deposit', 'old', 50, 'USD', '2026-08-11', '{}', '2026-08-11', '2026-08-11'),
        ('deposit-new', 'esun', 'deposit', 'new', 100, 'USD', '2026-08-12', '{}', '2026-08-12', '2026-08-12'),
        ('card-new', 'esun', 'card', 'card-new', -1200, 'TWD', '2026-08-12', '{}', '2026-08-12', '2026-08-12');

      INSERT INTO investment_positions
        (id, connector_id, source_id, asset_type, name, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at)
      VALUES
        ('stock-old', 'tdcc', '2330', 'stock', '台積電', 1000, 0, 'TWD', '2026-08-11', '{}', '2026-08-11', '2026-08-11'),
        ('stock-new', 'tdcc', '2330', 'stock', '台積電', 2000, 100, 'TWD', '2026-08-12', '{}', '2026-08-12', '2026-08-12');

      INSERT INTO manual_assets (id, name, category, currency, created_at)
      VALUES ('home', '房屋', 'property', 'TWD', '2026-08-12');
      INSERT INTO net_worth_history
        (id, date, net_worth, asset_type, source, snapshotted_at)
      VALUES ('home-value', '2026-08-12', 5000, 'home', 'manual', '2026-08-12');
    `);

    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toEqual({
      assetsTwd: 10_300,
      creditCardDebtTwd: 1200,
      missingCurrencies: [],
    });
  });

  it("values foreign-currency items at zero when their exchange rate is missing", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('deposit-usd', 'esun', 'deposit-usd', 'savings', 'USD', '{}', '2026-08-12', '2026-08-12'),
        ('card-jpy', 'esun', 'card-jpy', 'credit', 'JPY', '{}', '2026-08-12', '2026-08-12'),
        ('deposit-twd', 'esun', 'deposit-twd', 'savings', 'TWD', '{}', '2026-08-12', '2026-08-12');
      INSERT INTO bank_balance_snapshots
        (id, connector_id, account_id, source_id, balance, currency, as_of_at, raw_payload, created_at, updated_at)
      VALUES
        ('deposit-usd', 'esun', 'deposit-usd', 'deposit-usd', 100, 'USD', '2026-08-12', '{}', '2026-08-12', '2026-08-12'),
        ('card-jpy', 'esun', 'card-jpy', 'card-jpy', -5000, 'JPY', '2026-08-12', '{}', '2026-08-12', '2026-08-12'),
        ('deposit-twd', 'esun', 'deposit-twd', 'deposit-twd', 3000, 'TWD', '2026-08-12', '{}', '2026-08-12', '2026-08-12');
    `);

    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toEqual({
      assetsTwd: 3000,
      creditCardDebtTwd: 0,
      missingCurrencies: ["JPY", "USD"],
    });
  });

  it("warns only for positive assets or nonzero credit-card debt", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('zero-hkd', 'esun', 'zero-hkd', 'savings', 'HKD', '{}', '2026-08-12', '2026-08-12'),
        ('negative-usd', 'esun', 'negative-usd', 'savings', 'USD', '{}', '2026-08-12', '2026-08-12'),
        ('card-jpy', 'esun', 'card-jpy', 'credit', 'JPY', '{}', '2026-08-12', '2026-08-12');
      INSERT INTO bank_balance_snapshots
        (id, connector_id, account_id, source_id, balance, currency, as_of_at, raw_payload, created_at, updated_at)
      VALUES
        ('zero-hkd', 'esun', 'zero-hkd', 'zero-hkd', 0, 'HKD', '2026-08-12', '{}', '2026-08-12', '2026-08-12'),
        ('negative-usd', 'esun', 'negative-usd', 'negative-usd', -100, 'USD', '2026-08-12', '{}', '2026-08-12', '2026-08-12'),
        ('card-jpy', 'esun', 'card-jpy', 'card-jpy', -5000, 'JPY', '2026-08-12', '{}', '2026-08-12', '2026-08-12');
    `);

    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toMatchObject({
      missingCurrencies: ["JPY"],
    });
  });

  it("keeps the financial delta for a partial round and preserves new record counts", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('batch', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 0, 10000, 1200, '[]', 11000, 1000, '[]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at,
         new_invoices, new_bank_transactions, new_investment_transactions)
      VALUES
        ('batch', 'einvoice:all', 'einvoice', 'success', '2026-08-12T22:02:00Z', 3, 0, 0),
        ('batch', 'esun:all', 'esun', 'failed', '2026-08-12T22:05:00Z', 0, 2, 0);
    `);

    await expect(getLatestScheduledSyncReport(db)).resolves.toMatchObject({
      id: "batch",
      status: "failed",
      sourceSummary: { total: 2, success: 1, failed: 1 },
      newRecords: {
        invoices: 3,
        bankTransactions: 2,
        investmentTransactions: 0,
      },
      financialChange: { assets: 1000, creditCardDebt: -200, netWorth: 1200 },
      financialChangeUnavailableReason: null,
    });
  });

  it("returns the complete asset, debt and net-worth deltas", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('batch', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 0, 10000, 1200, '[]', 11000, 1000, '[]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at)
      VALUES ('batch', 'esun:all', 'esun', 'success', '2026-08-12T22:05:00Z');
    `);

    await expect(getLatestScheduledSyncReport(db)).resolves.toMatchObject({
      financialChange: { assets: 1000, creditCardDebt: -200, netWorth: 1200 },
      financialChangeUnavailableReason: null,
    });
    await expect(hasCompletedFinancialBaseline(db)).resolves.toBe(true);
  });

  it("keeps the financial delta when a currency was valued at zero", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('batch', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 0, 10000, 1200, '["USD"]', 11000, 1000, '["USD"]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at)
      VALUES ('batch', 'esun:all', 'esun', 'success', '2026-08-12T22:05:00Z');
    `);

    await expect(getLatestScheduledSyncReport(db)).resolves.toMatchObject({
      financialChange: { assets: 1000, creditCardDebt: -200, netWorth: 1200 },
      financialChangeUnavailableReason: null,
      missingCurrencies: ["USD"],
    });
  });

  it("repairs only a failed source in the latest completed report", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('old', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 0, 100, 0, '[]', 100, 0, '[]'),
        ('latest', 'default', '2026-08-13T22:05:00Z', '2026-08-13T22:00:00Z',
         '2026-08-13T22:05:00Z', 0, 100, 0, '[]', 100, 0, '[]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at,
         new_invoices, new_bank_transactions, new_investment_transactions)
      VALUES
        ('old', 'esun:all', 'esun', 'failed', '2026-08-12T22:05:00Z', 1, 2, 3),
        ('latest', 'esun:all', 'esun', 'failed', '2026-08-13T22:05:00Z', 4, 5, 6);
    `);

    await expect(
      recoverLatestScheduledSyncSource(db, {
        connectorId: "esun",
        newRecords: {
          invoices: 2,
          bankTransactions: 3,
          investmentTransactions: 4,
        },
      }),
    ).resolves.toBe(true);

    expect(
      database
        .prepare(
          `SELECT status, completed_at AS completedAt,
                  recovered_at AS recoveredAt, new_invoices AS invoices,
                  new_bank_transactions AS bankTransactions,
                  new_investment_transactions AS investmentTransactions
           FROM scheduled_sync_batch_results
           WHERE batch_id = 'latest'`,
        )
        .get(),
    ).toMatchObject({
      status: "success",
      completedAt: "2026-08-13T22:05:00Z",
      recoveredAt: expect.any(String),
      invoices: 6,
      bankTransactions: 8,
      investmentTransactions: 10,
    });
    expect(
      database
        .prepare(
          "SELECT status FROM scheduled_sync_batch_results WHERE batch_id = 'old'",
        )
        .get(),
    ).toEqual({ status: "failed" });

    const report = await getLatestScheduledSyncReport(db);
    expect(report).toMatchObject({
      status: "success",
      recoveredAt: expect.any(String),
      financialChange: { assets: -100, creditCardDebt: 0, netWorth: -100 },
    });
    expect(report?.sources[0]).toMatchObject({
      completedAt: "2026-08-13T22:05:00Z",
      recoveredAt: expect.any(String),
    });
    await expect(
      recoverLatestScheduledSyncSource(db, {
        connectorId: "esun",
        newRecords: {
          invoices: 1,
          bankTransactions: 1,
          investmentTransactions: 1,
        },
      }),
    ).resolves.toBe(false);
  });

  it("does not repair an older failed report when the latest report is successful", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('old', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 0, 100, 0, '[]', 100, 0, '[]'),
        ('latest', 'default', '2026-08-13T22:05:00Z', '2026-08-13T22:00:00Z',
         '2026-08-13T22:05:00Z', 0, 100, 0, '[]', 100, 0, '[]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at)
      VALUES
        ('old', 'esun:all', 'esun', 'failed', '2026-08-12T22:05:00Z'),
        ('latest', 'esun:all', 'esun', 'success', '2026-08-13T22:05:00Z');
    `);

    await expect(
      recoverLatestScheduledSyncSource(db, {
        connectorId: "esun",
        newRecords: {
          invoices: 1,
          bankTransactions: 1,
          investmentTransactions: 1,
        },
      }),
    ).resolves.toBe(false);
    expect(
      database
        .prepare(
          "SELECT status, recovered_at AS recoveredAt FROM scheduled_sync_batch_results WHERE batch_id = 'old'",
        )
        .get(),
    ).toEqual({ status: "failed", recoveredAt: null });
    await expect(
      findLatestRecoverableScheduledBatchId(db, "esun"),
    ).resolves.toBeNull();
  });

  it("waits for a complete successful round before establishing the baseline", async () => {
    const { database, db } = createDb();
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_after_twd, credit_card_debt_after_twd,
         missing_currencies_after)
      VALUES
        ('failed', 'default', '2026-08-12T22:05:00Z', '2026-08-12T22:00:00Z',
         '2026-08-12T22:05:00Z', 1, 10000, 1200, '[]'),
        ('missing-rate', 'default', '2026-08-13T22:05:00Z', '2026-08-13T22:00:00Z',
         '2026-08-13T22:05:00Z', 1, 10000, 1200, '["USD"]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at)
      VALUES
        ('failed', 'esun:all', 'esun', 'failed', '2026-08-12T22:05:00Z'),
        ('missing-rate', 'esun:all', 'esun', 'success', '2026-08-13T22:05:00Z');
    `);

    await expect(hasCompletedFinancialBaseline(db)).resolves.toBe(true);
  });

  it("rolls back the source repair when the report snapshot update fails", async () => {
    const { database, db } = createDb({ failBatchAt: 1 });
    databases.push(database);
    database.exec(`
      INSERT INTO scheduled_sync_batches
        (id, schedule_key, notification_claimed_at, created_at, completed_at,
         is_baseline, assets_before_twd, credit_card_debt_before_twd,
         missing_currencies_before, assets_after_twd,
         credit_card_debt_after_twd, missing_currencies_after)
      VALUES
        ('latest', 'default', '2026-08-13T22:05:00Z', '2026-08-13T22:00:00Z',
         '2026-08-13T22:05:00Z', 0, 100, 0, '[]', 100, 0, '[]');
      INSERT INTO scheduled_sync_batch_results
        (batch_id, job_id, connector_id, status, completed_at)
      VALUES ('latest', 'esun:all', 'esun', 'failed', '2026-08-13T22:05:00Z');
    `);

    await expect(
      recoverLatestScheduledSyncSource(db, {
        connectorId: "esun",
        newRecords: {
          invoices: 1,
          bankTransactions: 2,
          investmentTransactions: 3,
        },
      }),
    ).rejects.toThrow("simulated D1 batch failure");
    expect(
      database
        .prepare(
          `SELECT status, recovered_at AS recoveredAt,
                  new_invoices AS invoices
           FROM scheduled_sync_batch_results
           WHERE batch_id = 'latest'`,
        )
        .get(),
    ).toEqual({ status: "failed", recoveredAt: null, invoices: 0 });
  });
});
