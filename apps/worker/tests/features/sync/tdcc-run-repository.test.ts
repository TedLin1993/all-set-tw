import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireTdccRunLease,
  claimTdccRunItems,
  createOrGetActiveTdccRun,
  finalizeTdccRun,
  getActiveTdccRun,
  getTdccRun,
  insertNextTdccRunItem,
  markTdccRunItemSucceeded,
  releaseTdccRunItemForRetry,
  releaseTdccRunLease,
  renewTdccRunLease,
  transitionTdccRun,
  updateTdccRunItem,
  updateTdccRunState,
  upsertTdccRunItem,
} from "../../../src/features/sync/tdcc-run-repository";

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

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDb() {
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
  databases.push(database);
  const db = {
    prepare(sql: string) {
      return new SqliteStatement(database, sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
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

describe("durable TDCC sync runs", () => {
  it("keeps one active run across partial scopes", async () => {
    const { db } = createDb();
    const first = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
      scope: "bank",
      now: "2026-08-23T00:00:00.000Z",
    });
    const second = await createOrGetActiveTdccRun(db, {
      id: "run-2",
      trigger: "scheduled",
      scope: "all",
      now: "2026-08-23T00:01:00.000Z",
    });

    expect(first).toMatchObject({
      created: true,
      run: { id: "run-1", scope: "bank", sync_job_id: null },
    });
    expect(second).toMatchObject({
      created: false,
      run: { id: "run-1", trigger: "manual" },
    });
    expect(await getActiveTdccRun(db)).toMatchObject({ id: "run-1" });
  });

  it("pins encrypted state and transitions with compare-and-set", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
      settingsVersion: "v1",
      encryptedConfig: "config-v1",
      encryptedSession: "session-v1",
      session: { cookie: "redacted" },
    });
    expect(
      await updateTdccRunState(db, {
        runId: run.id,
        settingsVersion: "v2",
        encryptedSession: "session-v2",
        phase: "bank",
        status: "processing",
        now: "2026-08-23T00:02:00.000Z",
      }),
    ).toBe(true);
    expect(await getTdccRun(db, run.id)).toMatchObject({
      settings_version: "v2",
      encrypted_config: "config-v1",
      encrypted_session: "session-v2",
      phase: "bank",
      status: "processing",
      session_json: null,
    });
    expect(
      await transitionTdccRun(db, {
        runId: run.id,
        from: "queued",
        to: "processing",
      }),
    ).toBe(false);
    expect(
      await transitionTdccRun(db, {
        runId: run.id,
        from: "processing",
        to: "promoting",
        phase: "promote",
      }),
    ).toBe(true);
  });

  it("allows only the current owner to renew or release a run lease", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    const startedAt = new Date("2026-08-23T00:00:00.000Z");
    await expect(
      acquireTdccRunLease(db, {
        runId: run.id,
        owner: "consumer-a",
        leaseMs: 60_000,
        now: startedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      renewTdccRunLease(db, {
        runId: run.id,
        owner: "consumer-b",
        leaseMs: 60_000,
        now: startedAt,
      }),
    ).resolves.toBe(false);
    await expect(
      releaseTdccRunLease(db, { runId: run.id, owner: "consumer-b" }),
    ).resolves.toBe(false);
    await expect(
      acquireTdccRunLease(db, {
        runId: run.id,
        owner: "consumer-b",
        leaseMs: 60_000,
        now: new Date("2026-08-23T00:01:01.000Z"),
      }),
    ).resolves.toBe(true);
    expect(await getTdccRun(db, run.id)).toMatchObject({
      lease_owner: "consumer-b",
      lease_expires_at: "2026-08-23T00:02:01.000Z",
    });
  });

  it("claims pages, preserves retries, and rejects stale completion", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    const item = await upsertTdccRunItem(db, run.id, {
      taskType: "bank_transactions",
      taskKey: "bank-1",
      accountId: "bank-1",
      task: { accountId: "bank-1" },
      pageCursor: "first",
      now: "2026-08-23T00:00:00.000Z",
    });
    const claimed = await claimTdccRunItems(db, {
      runId: run.id,
      claimToken: "claim-a",
      leaseMs: 60_000,
      now: new Date("2026-08-23T00:01:00.000Z"),
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: item.id,
      status: "processing",
      attempt_count: 1,
      lease_token: "claim-a",
    });
    await expect(
      releaseTdccRunItemForRetry(db, {
        runId: run.id,
        itemId: item.id,
        claimToken: "wrong-claim",
        error: "transient",
      }),
    ).resolves.toBe(false);
    await expect(
      releaseTdccRunItemForRetry(db, {
        runId: run.id,
        itemId: item.id,
        claimToken: "claim-a",
        error: "transient",
      }),
    ).resolves.toBe(true);
    const reclaimed = await claimTdccRunItems(db, {
      runId: run.id,
      claimToken: "claim-b",
      leaseMs: 60_000,
      now: new Date("2026-08-23T00:02:00.000Z"),
    });
    expect(reclaimed[0]).toMatchObject({ attempt_count: 2 });
    await expect(
      markTdccRunItemSucceeded(db, {
        runId: run.id,
        itemId: item.id,
        claimToken: "claim-a",
        payload: [{ sourceId: "stale" }],
      }),
    ).resolves.toBe(false);
    await expect(
      markTdccRunItemSucceeded(db, {
        runId: run.id,
        itemId: item.id,
        claimToken: "claim-b",
        payload: [{ sourceId: "bank-tx-1" }],
        nextPageCursor: null,
      }),
    ).resolves.toBe(true);
    expect(await getTdccRun(db, run.id)).toMatchObject({
      total_item_count: 1,
      done_item_count: 1,
      pending_item_count: 0,
    });
  });

  it("upserts the next page and only completes after every item is done", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await insertNextTdccRunItem(db, run.id, {
      taskType: "trades",
      taskKey: "broker-1",
      pageCursor: "cursor-2",
      pageNumber: 2,
      task: { broker: "broker-1" },
    });
    expect(
      await finalizeTdccRun(db, {
        runId: run.id,
        status: "completed",
        now: "2026-08-23T00:03:00.000Z",
      }),
    ).toBe(false);
    const claimed = await claimTdccRunItems(db, {
      runId: run.id,
      claimToken: "claim-a",
      leaseMs: 60_000,
      now: new Date("2026-08-23T00:03:30.000Z"),
    });
    await markTdccRunItemSucceeded(db, {
      runId: run.id,
      itemId: claimed[0]!.id,
      claimToken: "claim-a",
      payload: { rows: [] },
      now: "2026-08-23T00:04:00.000Z",
    });
    expect(
      await finalizeTdccRun(db, {
        runId: run.id,
        status: "completed",
        phase: "promote",
        promotedAt: "2026-08-23T00:04:30.000Z",
        now: "2026-08-23T00:04:30.000Z",
      }),
    ).toBe(true);
    expect(await getTdccRun(db, run.id)).toMatchObject({
      status: "completed",
      phase: "promote",
      promoted_at: "2026-08-23T00:04:30.000Z",
      completed_at: "2026-08-23T00:04:30.000Z",
    });
  });

  it("updates a claimed item through the generic item API", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveTdccRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    const item = await upsertTdccRunItem(db, run.id, {
      taskType: "positions",
      taskKey: "account-1",
    });
    const [claimed] = await claimTdccRunItems(db, {
      runId: run.id,
      claimToken: "claim-a",
      leaseMs: 60_000,
    });
    expect(
      await updateTdccRunItem(db, {
        runId: run.id,
        itemId: item.id,
        claimToken: "claim-a",
        payload: { quantity: 1 },
        status: "done",
        completedAt: "2026-08-23T00:05:00.000Z",
      }),
    ).toBe(true);
    expect(claimed?.id).toBe(item.id);
    expect(await getTdccRun(db, run.id)).toMatchObject({ done_item_count: 1 });
  });
});
