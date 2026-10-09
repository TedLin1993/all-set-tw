import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  calculateCurrentFinancialSnapshot,
  getLatestScheduledSyncReport,
  hasCompletedFinancialBaseline,
} from "../../../src/features/sync/reports/repository";

describe("scheduled financial snapshot loan debt", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM scheduled_sync_batch_results"),
      db.prepare("DELETE FROM scheduled_sync_batches"),
      db.prepare("DELETE FROM bank_balance_snapshots"),
      db.prepare("DELETE FROM bank_accounts"),
    ]);
  });

  it("separates deposit assets, card debt, and loan debt", async () => {
    const accounts = [
      { id: "deposit", type: "checking", balance: 100_000 },
      { id: "card", type: "credit", balance: -10_000 },
      { id: "loan", type: "loan", balance: -40_000 },
    ];

    for (const account of accounts) {
      await db
        .prepare(
          `INSERT INTO bank_accounts (
             id, connector_id, source_id, account_type, currency,
             created_at, updated_at
           ) VALUES (?, 'cathaybk', ?, ?, 'TWD', '2026-10-07', '2026-10-07')`,
        )
        .bind(account.id, account.id, account.type)
        .run();
      await db
        .prepare(
          `INSERT INTO bank_balance_snapshots (
             id, connector_id, account_id, source_id, balance, currency,
             as_of_at, created_at, updated_at
           ) VALUES (?, 'cathaybk', ?, ?, ?, 'TWD', '2026-10-07T00:00:00.000Z', '2026-10-07', '2026-10-07')`,
        )
        .bind(`${account.id}:snapshot`, account.id, "current", account.balance)
        .run();
    }

    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toEqual({
      assetsTwd: 100_000,
      creditCardDebtTwd: 10_000,
      loanDebtTwd: 40_000,
      missingCurrencies: [],
    });

    await db
      .prepare("UPDATE bank_accounts SET inactive_at = ? WHERE id = 'loan'")
      .bind("2026-10-08T00:00:00.000Z")
      .run();
    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toEqual({
      assetsTwd: 100_000,
      creditCardDebtTwd: 10_000,
      loanDebtTwd: 0,
      missingCurrencies: [],
    });
  });

  it("treats legacy batches with NULL loan snapshots as a completed baseline", async () => {
    const completedAt = "2026-10-07T00:00:00.000Z";
    await db
      .prepare(
        `INSERT INTO scheduled_sync_batches (
           id, schedule_key, notification_claimed_at, created_at, completed_at,
           is_baseline, assets_before_twd, credit_card_debt_before_twd,
           loan_debt_before_twd, assets_after_twd, credit_card_debt_after_twd,
           loan_debt_after_twd
         ) VALUES (?, 'default', ?, ?, ?, 0, 100, 10, NULL, 120, 15, NULL)`,
      )
      .bind("legacy", completedAt, completedAt, completedAt)
      .run();
    await db
      .prepare(
        `INSERT INTO scheduled_sync_batch_results (
           batch_id, job_id, connector_id, status, completed_at
         ) VALUES (?, ?, ?, 'success', ?)`,
      )
      .bind("legacy", "job:legacy", "cathaybk", completedAt)
      .run();

    await expect(hasCompletedFinancialBaseline(db)).resolves.toBe(true);
    await expect(getLatestScheduledSyncReport(db)).resolves.toMatchObject({
      id: "legacy",
      financialChange: {
        assets: 20,
        creditCardDebt: 5,
        loanDebt: 0,
        netWorth: 15,
      },
      financialChangeUnavailableReason: null,
    });

    await db
      .prepare(
        "UPDATE scheduled_sync_batches SET loan_debt_after_twd = 1 WHERE id = ?",
      )
      .bind("legacy")
      .run();
    await expect(getLatestScheduledSyncReport(db)).resolves.toMatchObject({
      financialChange: null,
      financialChangeUnavailableReason: "snapshot_unavailable",
    });
  });
});
