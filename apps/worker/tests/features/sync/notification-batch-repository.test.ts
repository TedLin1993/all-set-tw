import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ConnectorId } from "@taiwan-fin-hub/core";
import type { SyncJobRow } from "@taiwan-fin-hub/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimCompletedDefaultScheduleBatch,
  ensureDefaultScheduleBatch,
  findNextDefaultScheduleBatchJob,
  findOpenDefaultScheduleBatchId,
  recordDefaultScheduleBatchResult,
} from "../../../src/features/sync/notification-batch-repository";

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
      success: true,
      meta: {},
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

function enableInheritedJobs(
  database: DatabaseSync,
  nextRunAt = "2026-07-23T22:00:00.000Z",
) {
  database
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
    .run(nextRunAt);
}

function listJobs(database: DatabaseSync) {
  return database
    .prepare("SELECT * FROM sync_jobs ORDER BY id")
    .all() as unknown as SyncJobRow<ConnectorId>[];
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
  });
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("default schedule notification rounds", () => {
  it("creates the round header and fixed membership atomically", async () => {
    const { database, db } = createDb({ failBatchAt: 1 });
    databases.push(database);
    enableInheritedJobs(database);

    await expect(ensureDefaultScheduleBatch(db)).rejects.toThrow(
      "simulated D1 batch failure",
    );
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batches")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batch_results")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("claims one summary only after every member reaches a terminal state", async () => {
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
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
    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toBeNull();
  });

  it("does not select a completed member again while the round is open", async () => {
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const batchId = await createBatch(db);
    const first = await findNextDefaultScheduleBatchJob(db, batchId);
    expect(first).not.toBeNull();
    await completeMember(db, batchId, first!);

    database
      .prepare("UPDATE sync_jobs SET next_run_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", first!.id);
    const next = await findNextDefaultScheduleBatchJob(db, batchId);

    expect(next?.id).not.toBe(first!.id);
    expect(jobs.map((job) => job.id)).toContain(next?.id);
  });

  it("keeps the round membership fixed when another job becomes inherited", async () => {
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const addedLater = jobs.at(-1)!;
    database
      .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = ?")
      .run(addedLater.id);
    const batchId = await createBatch(db);
    const originalCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM scheduled_sync_batch_results WHERE batch_id = ?",
      )
      .get(batchId) as { count: number };

    database
      .prepare("UPDATE sync_jobs SET enabled = 1 WHERE id = ?")
      .run(addedLater.id);
    await expect(ensureDefaultScheduleBatch(db)).resolves.toBe(batchId);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM scheduled_sync_batch_results WHERE batch_id = ?",
        )
        .get(batchId),
    ).toEqual(originalCount);
  });

  it("still runs a pending round member after a manual sync moves its schedule", async () => {
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const pending = jobs[0]!;
    const batchId = await createBatch(db);

    for (const job of jobs.slice(1)) {
      await completeMember(db, batchId, job);
    }
    database
      .prepare(
        `UPDATE sync_jobs
         SET last_status = 'success',
             last_run_at = ?,
             next_run_at = ?
         WHERE id = ?`,
      )
      .run("2026-07-23T22:05:00.000Z", "2026-07-24T22:05:00.000Z", pending.id);

    await expect(
      claimCompletedDefaultScheduleBatch(db, batchId),
    ).resolves.toBeNull();
    await expect(
      findNextDefaultScheduleBatchJob(db, batchId),
    ).resolves.toMatchObject({ id: pending.id });
  });

  it("skips a pending member that now requires user action", async () => {
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const paused = jobs[0]!;
    const batchId = await createBatch(db);
    database
      .prepare(
        "UPDATE sync_jobs SET last_status = 'needs_user_action' WHERE id = ?",
      )
      .run(paused.id);

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
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const skipped = jobs[0]!;
    const batchId = await createBatch(db);
    database
      .prepare("UPDATE sync_jobs SET enabled = 0 WHERE id = ?")
      .run(skipped.id);

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
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const running = jobs[0]!;
    const batchId = await createBatch(db);
    const futureLock = new Date(Date.now() + 60_000).toISOString();
    database
      .prepare(
        `UPDATE sync_jobs
         SET enabled = 0,
             locked_until = ?,
             lock_trigger = 'scheduled'
         WHERE id = ?`,
      )
      .run(futureLock, running.id);
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
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
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
    const { database, db } = createDb();
    databases.push(database);
    enableInheritedJobs(database);
    const jobs = listJobs(database);
    const oldBatchId = await createBatch(db);
    for (const job of jobs) await completeMember(db, oldBatchId, job);
    await expect(
      claimCompletedDefaultScheduleBatch(db, oldBatchId),
    ).resolves.toHaveLength(jobs.length);
    database
      .prepare(
        `UPDATE scheduled_sync_batches
         SET notification_claimed_at = ?
         WHERE id = ?`,
      )
      .run("2020-01-01T00:00:00.000Z", oldBatchId);

    const newBatchId = await createBatch(db);
    expect(newBatchId).not.toBe(oldBatchId);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM scheduled_sync_batches")
        .get(),
    ).toEqual({ count: 1 });
  });
});
