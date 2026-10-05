import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  acquireSyncJobLock,
  renewSyncJobLock,
  releaseSyncJobLock,
  completeSyncJob,
  failSyncJob,
} from "../../../src/db";
import * as dbApi from "../../../src/db";
import { findSyncJob } from "../../../src/features/sync/scheduling/repository";
import { getSyncJobs } from "../../../src/features/sync/scheduling/service";
import { recoverStalledSyncRuns } from "../../../src/features/sync/scheduling/recovery";
import {
  createSyncExecution,
  guardSyncDatabase,
  SyncLockLostError,
  SyncTimeoutError,
} from "../../../src/features/sync/execution";
import type { Env } from "../../../src/platform/env";
import {
  acquireEinvoiceRunChunkLease,
  renewEinvoiceRunChunkLease,
  releaseEinvoiceRunChunkLease,
  createOrGetActiveEinvoiceRun,
  completeEinvoiceRun,
  claimEinvoiceRunSessionRefresh,
} from "../../../src/sources/einvoice/run-repository";
import {
  acquireTdccRunLease,
  renewTdccRunLease,
  releaseTdccRunLease,
  createOrGetActiveTdccRun,
  updateTdccRunState,
  finalizeTdccRun,
  claimTdccRunSessionRefresh,
} from "../../../src/sources/tdcc/run-repository";
import {
  stageSyncWriteRecords,
  promoteStagedSyncWrite,
} from "../../../src/features/sync/persistence";
import { connectorCursorStatement } from "../../../src/features/sync/connector-repository";
import { failTdccSyncRun } from "../../../src/sources/tdcc/sync";

const now = "2026-09-13T00:00:00.000Z";

describe("同步鎖與原子寫入（隔離 D1）", () => {
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
      db.prepare("DROP TRIGGER IF EXISTS fail_run_update"),
      ...[
        "einvoice_sync_run_items",
        "einvoice_sync_runs",
        "tdcc_sync_run_items",
        "tdcc_sync_runs",
        "sync_write_staging",
        "invoices",
        "connector_settings",
        "sync_jobs",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    ]);
  });

  it("connector lock 競爭只有一方取得，舊 owner 不能續租或釋放", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at) VALUES ('tdcc:all', 'tdcc', 'all', 1440, ?, ?, ?)`,
      )
      .bind(now, now, now)
      .run();
    const input = {
      lockRowId: "tdcc:all",
      scope: "all",
      trigger: "manual" as const,
      leaseMs: 60_000,
    };
    const results = await Promise.all(
      ["a", "b"].map((runId) => acquireSyncJobLock(db, { ...input, runId })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const owner = results[0] ? "a" : "b";
    const stale = owner === "a" ? "b" : "a";
    expect(await renewSyncJobLock(db, { ...input, runId: stale })).toBe(false);
    await releaseSyncJobLock(db, input.lockRowId, stale);
    expect(await acquireSyncJobLock(db, { ...input, runId: stale })).toBe(
      false,
    );
    expect(await renewSyncJobLock(db, { ...input, runId: owner })).toBe(true);
    await releaseSyncJobLock(db, input.lockRowId, owner);
    expect(await acquireSyncJobLock(db, { ...input, runId: stale })).toBe(true);
    expect(
      await acquireSyncJobLock(db, {
        ...input,
        lockRowId: "missing",
        runId: owner,
      }),
    ).toBe(false);
  });

  it("鎖被接管後，舊同步不能寫入金融資料、cursor 或新工作的結果", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at) VALUES ('einvoice:all', 'einvoice', 'all', 1440, ?, ?, ?)`,
      )
      .bind(now, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('einvoice', 'einvoice', 'config', 'old-cursor', ?, ?)`,
      )
      .bind(now, now)
      .run();
    const input = {
      lockRowId: "einvoice:all",
      scope: "all",
      trigger: "manual" as const,
      leaseMs: 60_000,
    };
    await acquireSyncJobLock(db, { ...input, runId: "old" });
    const guarded = guardSyncDatabase(
      db,
      { lockRowId: input.lockRowId, runId: "old" },
      new AbortController().signal,
    );
    const record = {
      entityType: "invoice" as const,
      recordKey: "stale",
      payload: {
        id: "stale",
        connector_id: "einvoice",
        source_id: "stale",
        invoice_date: "2026-10-05",
        amount: 120,
        created_at: now,
        updated_at: now,
      },
    };
    await stageSyncWriteRecords(guarded, "stale-write", [record]);
    expect(
      await promoteStagedSyncWrite(guarded, {
        runId: "stale-write",
        entityTypes: ["invoice"],
        finalizeStatements: [
          connectorCursorStatement(guarded, "einvoice", "current-cursor", now),
        ],
      }),
    ).toEqual({ invoices: 1, bankTransactions: 0, investmentTransactions: 0 });
    await stageSyncWriteRecords(guarded, "stale-write", [
      { ...record, payload: { ...record.payload, amount: 999 } },
    ]);
    await db
      .prepare("UPDATE sync_jobs SET locked_until = ? WHERE id = ?")
      .bind(now, input.lockRowId)
      .run();
    expect(await renewSyncJobLock(db, { ...input, runId: "old" })).toBe(false);
    expect(await acquireSyncJobLock(db, { ...input, runId: "new" })).toBe(true);
    await expect(
      promoteStagedSyncWrite(guarded, {
        runId: "stale-write",
        entityTypes: ["invoice"],
        finalizeStatements: [
          connectorCursorStatement(guarded, "einvoice", "stale-cursor", now),
        ],
      }),
    ).rejects.toBeInstanceOf(SyncLockLostError);
    const job = (await findSyncJob(db, "einvoice", "all"))!;
    expect(await completeSyncJob(db, job, "old")).toBe(false);
    expect(
      await failSyncJob(
        db,
        job,
        { status: "failed", errorMessage: "old error" },
        "old",
      ),
    ).toBe(false);
    expect(
      await db.prepare("SELECT COUNT(*) AS count FROM invoices").first("count"),
    ).toBe(1);
    expect(
      await db.prepare("SELECT amount FROM invoices").first("amount"),
    ).toBe(120);
    expect(
      await db
        .prepare("SELECT sync_cursor FROM connector_settings")
        .first("sync_cursor"),
    ).toBe("current-cursor");
    expect(
      await db.prepare("SELECT locked_by, last_status FROM sync_jobs").first(),
    ).toEqual({ locked_by: "new", last_status: null });
  });

  it("失去續租或達到執行期限會停止等待，並拒絕遲到寫入", async () => {
    const db = harness.binding;
    const controller = new AbortController();
    const guarded = guardSyncDatabase(
      db,
      { lockRowId: "einvoice:all", runId: "run" },
      controller.signal,
    );
    controller.abort(new SyncTimeoutError());
    await expect(
      guarded.prepare("DELETE FROM connector_settings").run(),
    ).rejects.toBeInstanceOf(SyncTimeoutError);
    const env = { DB: db } as Env;
    const expired = createSyncExecution(
      env,
      { lockRowId: "einvoice:all", runId: "run" },
      { deadline: Date.now() - 1 },
    );
    const task = vi.fn();
    try {
      await expect(expired.run(task)).rejects.toBeInstanceOf(SyncTimeoutError);
      expect(task).not.toHaveBeenCalled();
    } finally {
      expired.stop();
    }
    vi.useFakeTimers();
    const renew = vi.spyOn(dbApi, "renewSyncJobLock").mockResolvedValue(false);
    const execution = createSyncExecution(env, {
      lockRowId: "einvoice:all",
      runId: "run",
    });
    try {
      const rejected = expect(
        execution.run(() => new Promise<never>(() => {})),
      ).rejects.toThrow("同步鎖已失效");
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await rejected;
    } finally {
      execution.stop();
      renew.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["einvoice", "tdcc"] as const)(
    "%s chunk 被另一個 invocation 接管後，舊 chunk 無法寫入",
    async (connectorId) => {
      const db = harness.binding;
      const lockRowId = `${connectorId}:all`;
      await db
        .prepare(
          `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at)
      VALUES (?, ?, 'all', 1440, ?, ?, ?)`,
        )
        .bind(lockRowId, connectorId, now, now, now)
        .run();
      await db
        .prepare(
          `INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at)
      VALUES (?, ?, 'config', 'old-cursor', ?, ?)`,
        )
        .bind(connectorId, connectorId, now, now)
        .run();
      const create =
        connectorId === "einvoice"
          ? createOrGetActiveEinvoiceRun
          : createOrGetActiveTdccRun;
      const acquire =
        connectorId === "einvoice"
          ? acquireEinvoiceRunChunkLease
          : acquireTdccRunLease;
      await create(db, { id: "run", trigger: "manual" });
      await acquireSyncJobLock(db, {
        lockRowId,
        runId: "run",
        scope: "all",
        trigger: "manual",
        leaseMs: 60_000,
      });
      await acquire(db, { runId: "run", owner: "old", leaseMs: 60_000 });
      const guarded = guardSyncDatabase(
        db,
        { lockRowId, runId: "run" },
        new AbortController().signal,
        { connectorId, owner: "old" },
      );
      await db
        .prepare(
          `UPDATE ${connectorId}_sync_runs SET ${connectorId === "einvoice" ? "chunk_lease_expires_at" : "lease_expires_at"} = ?`,
        )
        .bind(now)
        .run();
      expect(
        await acquire(db, { runId: "run", owner: "new", leaseMs: 60_000 }),
      ).toBe(true);
      await expect(
        guarded.batch([
          connectorCursorStatement(guarded, connectorId, "late-cursor", now),
          guarded
            .prepare(
              "UPDATE sync_jobs SET last_status = 'success' WHERE id = ?",
            )
            .bind(lockRowId),
        ]),
      ).rejects.toBeInstanceOf(SyncLockLostError);
      expect(
        await db
          .prepare("SELECT sync_cursor FROM connector_settings")
          .first("sync_cursor"),
      ).toBe("old-cursor");
      expect(
        await db
          .prepare("SELECT locked_by, last_status FROM sync_jobs")
          .first(),
      ).toEqual({ locked_by: "run", last_status: null });
    },
  );

  it("Cron 補送停滯 run、略過有效租約，逾時結案後可以建立新 run", async () => {
    const db = harness.binding;
    const current = Date.now();
    const stale = new Date(current - 4 * 60_000).toISOString();
    for (const connectorId of ["einvoice", "tdcc"] as const)
      await db
        .prepare(
          `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at) VALUES (?, ?, 'all', 1440, ?, ?, ?)`,
        )
        .bind(`${connectorId}:all`, connectorId, stale, stale, stale)
        .run();
    await createOrGetActiveEinvoiceRun(db, {
      id: "invoice-run",
      trigger: "manual",
      now: stale,
    });
    await createOrGetActiveTdccRun(db, {
      id: "tdcc-run",
      trigger: "manual",
      scope: "bank",
      now: stale,
    });
    await acquireTdccRunLease(db, {
      runId: "tdcc-run",
      owner: "live",
      leaseMs: 60_000,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const env = { DB: db, SYNC_QUEUE: { send } } as unknown as Env;
    let jobs = await getSyncJobs(db);
    expect(jobs.find((job) => job.connectorId === "einvoice")).toMatchObject({
      running: true,
      runId: "invoice-run",
      phase: "stalled",
      retryAfterSeconds: 0,
    });
    expect(jobs.find((job) => job.connectorId === "tdcc")).toMatchObject({
      running: true,
      runId: "tdcc-run",
      phase: "queued",
      lockScope: "bank",
      lockTrigger: "manual",
    });
    await recoverStalledSyncRuns(env);
    expect(send).toHaveBeenCalledExactlyOnceWith({
      type: "run-einvoice-chunk",
      runId: "invoice-run",
    });
    await db
      .prepare(
        "UPDATE einvoice_sync_runs SET created_at = ?, updated_at = ? WHERE id = ?",
      )
      .bind(new Date(current - 11 * 60_000).toISOString(), stale, "invoice-run")
      .run();
    await recoverStalledSyncRuns(env);
    jobs = await getSyncJobs(db);
    expect(jobs.find((job) => job.connectorId === "einvoice")).toMatchObject({
      running: false,
      lastStatus: "failed",
      lockedBy: null,
    });
    expect(
      (
        await createOrGetActiveEinvoiceRun(db, {
          id: "retry",
          trigger: "manual",
        })
      ).created,
    ).toBe(true);
  });

  it("集保失敗結案、結果與 staging 清理一起提交，失敗時全部回滾", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO sync_jobs (id, connector_id, scope, interval_minutes, next_run_at, created_at, updated_at)
      VALUES ('tdcc:all', 'tdcc', 'all', 1440, ?, ?, ?)`,
      )
      .bind(now, now, now)
      .run();
    await createOrGetActiveTdccRun(db, { id: "run", trigger: "manual" });
    await stageSyncWriteRecords(db, "run", [
      { entityType: "invoice", recordKey: "staged", payload: { id: "staged" } },
    ]);
    await db
      .prepare(
        `CREATE TRIGGER fail_run_update BEFORE UPDATE ON tdcc_sync_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic finalization failure'); END`,
      )
      .run();
    const env = { DB: db } as Env;
    await expect(
      failTdccSyncRun(env, "run", new Error("failed"), true),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT status FROM tdcc_sync_runs").first("status"),
    ).toBe("queued");
    expect(
      await db.prepare("SELECT locked_by, last_status FROM sync_jobs").first(),
    ).toEqual({ locked_by: "run", last_status: null });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM sync_write_staging")
        .first("count"),
    ).toBe(1);
    await db.prepare("DROP TRIGGER fail_run_update").run();
    expect(await failTdccSyncRun(env, "run", new Error("failed"), true)).toBe(
      true,
    );
    expect(
      await db.prepare("SELECT status FROM tdcc_sync_runs").first("status"),
    ).toBe("failed");
    expect(
      await db.prepare("SELECT locked_by, last_status FROM sync_jobs").first(),
    ).toEqual({ locked_by: null, last_status: "failed" });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM sync_write_staging")
        .first("count"),
    ).toBe(0);
  });

  for (const run of [
    {
      name: "einvoice",
      create: createOrGetActiveEinvoiceRun,
      acquire: acquireEinvoiceRunChunkLease,
      renew: renewEinvoiceRunChunkLease,
      release: releaseEinvoiceRunChunkLease,
      complete: completeEinvoiceRun,
      refresh: claimEinvoiceRunSessionRefresh,
    },
    {
      name: "tdcc",
      create: createOrGetActiveTdccRun,
      acquire: acquireTdccRunLease,
      renew: renewTdccRunLease,
      release: releaseTdccRunLease,
      complete: finalizeTdccRun,
      refresh: claimTdccRunSessionRefresh,
    },
  ]) {
    it(`${run.name} 保留 active run conflict、lease 到期邊界與 terminal guard`, async () => {
      const db = harness.binding;
      const created = await run.create(db, {
        id: run.name,
        trigger: "manual",
        now,
      });
      expect(created.created).toBe(true);
      const conflict = await run.create(db, {
        id: "other",
        trigger: "scheduled",
        now,
      });
      expect(conflict.created).toBe(false);
      expect(conflict.run.id).toBe(run.name);
      expect(conflict.run.trigger).toBe("manual");
      const refreshes = await Promise.all(
        [1, 2].map(() => run.refresh(db, { runId: run.name, now })),
      );
      expect(refreshes.filter(Boolean)).toHaveLength(1);
      const input = { runId: run.name, leaseMs: 1000, now: new Date(now) };
      const results = await Promise.all(
        ["a", "b"].map((owner) => run.acquire(db, { ...input, owner })),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const owner = results[0] ? "a" : "b";
      const stale = owner === "a" ? "b" : "a";
      expect(await run.renew(db, { ...input, owner: stale })).toBe(false);
      expect(
        await run.release(db, { runId: run.name, owner: stale, now }),
      ).toBe(false);
      expect(await run.renew(db, { ...input, owner })).toBe(true);
      expect(
        await run.acquire(db, {
          ...input,
          owner: stale,
          now: new Date(Date.parse(now) + 1000),
        }),
      ).toBe(false);
      expect(
        await run.acquire(db, {
          ...input,
          owner: stale,
          now: new Date(Date.parse(now) + 1001),
        }),
      ).toBe(true);
      expect(await run.release(db, { runId: run.name, owner, now })).toBe(
        false,
      );
      expect(
        await run.complete(db, { runId: run.name, status: "completed", now }),
      ).toBe(true);
      expect(
        await run.acquire(db, {
          ...input,
          owner,
          now: new Date(Date.parse(now) + 5000),
        }),
      ).toBe(false);
      expect(await run.renew(db, { ...input, owner: stale })).toBe(false);
      expect(
        await run.complete(db, { runId: run.name, status: "failed", now }),
      ).toBe(false);
    });
  }

  it("Drizzle 更新失敗不洩漏 session 參數或底層 cause", async () => {
    const db = harness.binding;
    await createOrGetActiveTdccRun(db, { id: "tdcc", trigger: "manual", now });
    await db
      .prepare(
        `CREATE TRIGGER fail_run_update BEFORE UPDATE ON tdcc_sync_runs BEGIN SELECT RAISE(ABORT, 'synthetic-secret'); END`,
      )
      .run();
    const error = await updateTdccRunState(db, {
      runId: "tdcc",
      encryptedSession: "synthetic-secret",
      now,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Database query failed.");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("synthetic-secret");
  });

  it("promotion 中途失敗回滾前置寫入，重試保留 count offset、cursor、finalize 與 cleanup", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('tdcc', 'tdcc', 'synthetic', 'old', ?, ?)`,
      )
      .bind(now, now)
      .run();
    await stageSyncWriteRecords(db, "staged", [
      {
        entityType: "invoice",
        recordKey: "invoice",
        payload: {
          id: "invoice",
          connector_id: "einvoice",
          source_id: "source",
          invoice_number: "AB12345678",
          invoice_date: "2026-09-13",
          seller_name: "Synthetic",
          amount: 100,
          raw_payload: "{}",
          created_at: now,
          updated_at: now,
        },
      },
    ]);
    const before = db.prepare(
      "UPDATE connector_settings SET public_config = '{}' WHERE connector_id = 'tdcc'",
    );
    const cursor = connectorCursorStatement(db, "tdcc", "new", now);
    await expect(
      promoteStagedSyncWrite(db, {
        runId: "staged",
        entityTypes: ["invoice"],
        beforePromoteStatements: [before],
        afterPromoteStatements: [
          db.prepare(
            "INSERT INTO connector_settings SELECT * FROM connector_settings WHERE connector_id = 'tdcc'",
          ),
        ],
        finalizeStatements: [cursor],
      }),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM invoices").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM sync_write_staging")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT public_config, sync_cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .first(),
    ).toEqual({ public_config: null, sync_cursor: "old" });
    const counts = await promoteStagedSyncWrite(db, {
      runId: "staged",
      entityTypes: ["invoice"],
      beforePromoteStatements: [before],
      finalizeStatements: [cursor],
    });
    expect(counts).toMatchObject({
      invoices: 1,
      bankTransactions: 0,
      investmentTransactions: 0,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM sync_write_staging")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT public_config, sync_cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .first(),
    ).toEqual({ public_config: "{}", sync_cursor: "new" });
  });
});
