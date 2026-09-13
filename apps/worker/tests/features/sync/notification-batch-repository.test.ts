import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ConnectorId } from "@taiwan-fin-hub/core";
import { findNextDueSyncJob, type SyncJobRow } from "@taiwan-fin-hub/db";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimCompletedDefaultScheduleBatch,
  ensureDefaultScheduleBatch,
  findNextDefaultScheduleBatchJob,
  findOpenDefaultScheduleBatchId,
  recordDefaultScheduleBatchResult,
} from "../../../src/features/sync/notification-batch-repository";
import { getSyncJobs } from "../../../src/features/sync/schedule-service";

const migration0023 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../packages/db/migrations/0023_disable_unconfigured_sync_jobs.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

function withFailingBatch(db: D1Database, failAt: number): D1Database {
  return {
    prepare: db.prepare.bind(db),
    batch: (statements) => {
      const wrapped = statements.map((statement, index) =>
        index === failAt
          ? db.prepare("INSERT INTO __nonexistent_table__ VALUES (1)")
          : statement,
      );
      return db.batch(wrapped);
    },
  } as D1Database;
}

async function enableInheritedJobs(
  db: D1Database,
  nextRunAt = "2026-07-23T22:00:00.000Z",
) {
  await db
    .prepare(
      `UPDATE sync_jobs
       SET enabled = 1,
           schedule_mode = 'inherit',
           next_run_at = ?,
           last_status = NULL,
           locked_until = NULL,
           locked_by = NULL,
           lock_trigger = NULL`,
    )
    .bind(nextRunAt)
    .run();
}

async function configureJobs(db: D1Database, jobs: SyncJobRow<ConnectorId>[]) {
  const now = "2026-07-23T00:00:00.000Z";
  for (const job of jobs) {
    await db
      .prepare(
        `INSERT INTO connector_settings (
           id, connector_id, encrypted_config, created_at, updated_at
         ) VALUES (?, ?, '{}', ?, ?)`,
      )
      .bind(`${job.connector_id}:settings`, job.connector_id, now, now)
      .run();
  }
}

async function listJobs(db: D1Database) {
  const result = await db
    .prepare("SELECT * FROM sync_jobs ORDER BY id")
    .all<SyncJobRow<ConnectorId>>();
  return result.results ?? [];
}

async function createBatch(db: D1Database) {
  const batchId = await ensureDefaultScheduleBatch(db);
  if (!batchId) throw new Error("Expected a default schedule batch.");
  return batchId;
}

async function completeMember(
  db: D1Database,
  batchId: string,
  job: SyncJobRow<ConnectorId>,
  status: "success" | "failed" | "needs_user_action" = "success",
) {
  return recordDefaultScheduleBatchResult(db, {
    batchId,
    jobId: job.id,
    notification: { connectorId: job.connector_id, status },
    newRecords: {
      invoices: job.connector_id === "einvoice" ? 1 : 0,
      bankTransactions: job.connector_id === "esun" ? 2 : 0,
      investmentTransactions: job.connector_id === "tdcc" ? 1 : 0,
    },
  });
}

describe("default schedule notification rounds", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;

  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    const db = harness.binding;
    await db.batch([
      db.prepare("DELETE FROM scheduled_sync_batch_results"),
      db.prepare("DELETE FROM scheduled_sync_batches"),
      db.prepare("DELETE FROM connector_settings"),
      db.prepare("DELETE FROM einvoice_sync_runs"),
      db.prepare(
        `UPDATE sync_jobs
         SET enabled = 0,
             schedule_mode = 'inherit',
             interval_minutes = 1440,
             preferred_time = '06:00',
             preferred_weekday = 1,
             next_run_at = '2099-01-01T00:00:00.000Z',
             last_status = NULL,
             last_error = NULL,
             last_run_at = NULL,
             last_success_at = NULL,
             locked_until = NULL,
             locked_by = NULL,
             lock_trigger = NULL,
             lock_scope = NULL`,
      ),
      db.prepare(
        `UPDATE sync_schedule_settings
         SET interval_minutes = 1440,
             preferred_time = '06:00',
             preferred_weekday = 1
         WHERE id = 'default'`,
      ),
    ]);
  });

  it("leaves every fresh-install connector unconfigured, disabled, and on the default schedule", async () => {
    const db = harness.binding;

    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sync_jobs
           WHERE enabled != 0
              OR last_status IS NOT NULL
              OR last_error IS NOT NULL`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sync_jobs
           WHERE schedule_mode != 'inherit'
              OR preferred_time != '06:00'
              OR preferred_weekday != 1
              OR interval_minutes != 1440`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect((await getSyncJobs(db)).every((job) => !job.configured)).toBe(true);
  });

  it("restores unconfigured jobs to an existing user's default schedule", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `UPDATE sync_jobs
         SET enabled = 1,
             last_status = 'failed',
             last_error = 'legacy failure'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE sync_schedule_settings
         SET interval_minutes = 10080, preferred_time = '20:30', preferred_weekday = 5
         WHERE id = 'default'`,
      )
      .run();
    await db.prepare(migration0023).run();

    expect(
      await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sync_jobs
           WHERE schedule_mode != 'inherit'
              OR interval_minutes != 10080
              OR preferred_time != '20:30'
              OR preferred_weekday != 5`,
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("does not select an enabled unconfigured job for a due run or default batch", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `UPDATE sync_jobs
         SET enabled = 1, next_run_at = '2020-01-01T00:00:00.000Z'
         WHERE id = 'esun:all'`,
      )
      .run();

    await expect(
      findNextDueSyncJob(db, new Date("2026-08-01T00:00:00.000Z")),
    ).resolves.toBeNull();
    await expect(ensureDefaultScheduleBatch(db)).resolves.toBeNull();

    const esunJob = (await db
      .prepare("SELECT * FROM sync_jobs WHERE id = 'esun:all'")
      .first()) as SyncJobRow<ConnectorId>;
    await configureJobs(db, [esunJob]);
    const jobs = await getSyncJobs(db);
    expect(jobs.find((job) => job.id === "esun:all")?.configured).toBe(true);
    await expect(
      findNextDueSyncJob(db, new Date("2026-08-01T00:00:00.000Z")),
    ).resolves.toMatchObject({ id: "esun:all" });
  });

  it("creates the round header and fixed membership atomically", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));

    await expect(
      ensureDefaultScheduleBatch(withFailingBatch(db, 1)),
    ).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batches")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batch_results")
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("claims one summary only after every member reaches a terminal state", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const batchId = await createBatch(db);

    for (const [index, job] of jobs.entries()) {
      await expect(
        completeMember(db, batchId, job, index === 0 ? "failed" : "success"),
      ).resolves.toBe(true);
      if (index < jobs.length - 1) {
        await expect(
          claimCompletedDefaultScheduleBatch(db, batchId),
        ).resolves.toBeNull();
      }
    }

    const summary = await claimCompletedDefaultScheduleBatch(db, batchId);
    expect(summary).toHaveLength(jobs.length);
    expect(summary).toContainEqual({
      connectorId: jobs[0]!.connector_id,
      status: "failed",
    });
    expect(
      await db
        .prepare(
          `SELECT completed_at AS completedAt,
                  assets_after_twd AS assetsAfterTwd,
                  credit_card_debt_after_twd AS creditCardDebtAfterTwd
           FROM scheduled_sync_batches WHERE id = ?`,
        )
        .bind(batchId)
        .first(),
    ).toMatchObject({
      completedAt: expect.any(String),
      assetsAfterTwd: 0,
      creditCardDebtAfterTwd: 0,
    });
    expect(
      await db
        .prepare(
          `SELECT
             SUM(new_invoices) AS newInvoices,
             SUM(new_bank_transactions) AS newBankTransactions,
             SUM(new_investment_transactions) AS newInvestmentTransactions
           FROM scheduled_sync_batch_results WHERE batch_id = ?`,
        )
        .bind(batchId)
        .first(),
    ).toEqual({
      newInvoices: 1,
      newBankTransactions: 2,
      newInvestmentTransactions: 1,
    });
    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toBeNull();
  });

  it("does not select a completed member again while the round is open", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const batchId = await createBatch(db);
    const first = await findNextDefaultScheduleBatchJob(db, batchId);
    expect(first).not.toBeNull();
    await completeMember(db, batchId, first!);

    await db
      .prepare("UPDATE sync_jobs SET next_run_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", first!.id)
      .run();
    const next = await findNextDefaultScheduleBatchJob(db, batchId);

    expect(next?.id).not.toBe(first!.id);
    expect(jobs.map((job) => job.id)).toContain(next?.id);
  });

  it("keeps the round membership fixed when another job becomes inherited", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const addedLater = jobs.at(-1)!;
    await db
      .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = ?")
      .bind(addedLater.id)
      .run();
    const batchId = await createBatch(db);
    const originalCount = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM scheduled_sync_batch_results WHERE batch_id = ?",
      )
      .bind(batchId)
      .first<{ count: number }>();

    await db
      .prepare("UPDATE sync_jobs SET enabled = 1 WHERE id = ?")
      .bind(addedLater.id)
      .run();
    await expect(ensureDefaultScheduleBatch(db)).resolves.toBe(batchId);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM scheduled_sync_batch_results WHERE batch_id = ?",
        )
        .bind(batchId)
        .first<{ count: number }>(),
    ).toEqual(originalCount);
  });

  it("still runs a pending round member after a manual sync moves its schedule", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const pending = jobs[0]!;
    const batchId = await createBatch(db);

    for (const job of jobs.slice(1)) {
      await completeMember(db, batchId, job);
    }
    await db
      .prepare(
        `UPDATE sync_jobs
         SET last_status = 'success',
             last_run_at = ?,
             next_run_at = ?
         WHERE id = ?`,
      )
      .bind("2026-07-23T22:05:00.000Z", "2026-07-24T22:05:00.000Z", pending.id)
      .run();

    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toBeNull();
    await expect(
      findNextDefaultScheduleBatchJob(db, batchId),
    ).resolves.toMatchObject({ id: pending.id });
  });

  it("skips a pending member that now requires user action", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const paused = jobs[0]!;
    const batchId = await createBatch(db);
    await db
      .prepare(
        "UPDATE sync_jobs SET last_status = 'needs_user_action' WHERE id = ?",
      )
      .bind(paused.id)
      .run();

    for (const job of jobs.slice(1)) {
      await completeMember(db, batchId, job);
    }

    const summary = await claimCompletedDefaultScheduleBatch(db, batchId);
    expect(summary).toHaveLength(jobs.length - 1);
    await expect(
      findNextDefaultScheduleBatchJob(db, batchId),
    ).resolves.toBeNull();
  });

  it("skips a member disabled before its turn", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const skipped = jobs[0]!;
    const batchId = await createBatch(db);
    await db
      .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = ?")
      .bind(skipped.id)
      .run();

    for (const job of jobs.slice(1)) {
      await completeMember(db, batchId, job);
    }

    const summary = await claimCompletedDefaultScheduleBatch(db, batchId);
    expect(summary).toHaveLength(jobs.length - 1);
    expect(summary).not.toContainEqual({
      connectorId: skipped.connector_id,
      status: "success",
    });
  });

  it("does not skip a disabled member while its scheduled run is active", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const running = jobs[0]!;
    const batchId = await createBatch(db);
    const futureLock = new Date(Date.now() + 60_000).toISOString();
    await db
      .prepare(
        `UPDATE sync_jobs
         SET enabled = 0,
             locked_until = ?,
             lock_trigger = 'scheduled'
         WHERE id = ?`,
      )
      .bind(futureLock, running.id)
      .run();
    for (const job of jobs.slice(1)) {
      await completeMember(db, batchId, job);
    }

    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toBeNull();
    await expect(completeMember(db, batchId, running)).resolves.toBe(true);
    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toContainEqual({
      connectorId: running.connector_id,
      status: "success",
    });
  });

  it("starts the next round only after the current round is claimed", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const firstBatchId = await createBatch(db);
    await expect(ensureDefaultScheduleBatch(db)).resolves.toBe(firstBatchId);

    for (const job of jobs) await completeMember(db, firstBatchId, job);
    await expect(
      claimCompletedDefaultScheduleBatch(db, firstBatchId),
    ).resolves.toHaveLength(jobs.length);
    await expect(findOpenDefaultScheduleBatchId(db)).resolves.toBeNull();

    const secondBatchId = await createBatch(db);
    expect(secondBatchId).not.toBe(firstBatchId);
  });

  it("prunes claimed rounds older than the retention window", async () => {
    const db = harness.binding;
    await enableInheritedJobs(db);
    await configureJobs(db, await listJobs(db));
    const jobs = await listJobs(db);
    const oldBatchId = await createBatch(db);
    for (const job of jobs) await completeMember(db, oldBatchId, job);
    await expect(
      claimCompletedDefaultScheduleBatch(db, oldBatchId),
    ).resolves.toHaveLength(jobs.length);
    await db
      .prepare(
        `UPDATE scheduled_sync_batches
         SET notification_claimed_at = ?
         WHERE id = ?`,
      )
      .bind("2020-01-01T00:00:00.000Z", oldBatchId)
      .run();

    const newBatchId = await createBatch(db);
    expect(newBatchId).not.toBe(oldBatchId);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batches")
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
