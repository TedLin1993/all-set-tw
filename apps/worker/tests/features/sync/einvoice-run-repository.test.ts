import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireEinvoiceRunChunkLease,
  claimEinvoiceRunItems,
  claimEinvoiceRunSessionRefresh,
  completeEinvoiceRun,
  createOrGetActiveEinvoiceRun,
  getEinvoiceRun,
  initializeEinvoiceRun,
  listCompletedEinvoiceRunItems,
  listPendingEinvoiceRunItems,
  markEinvoiceRunItemSucceeded,
  markEinvoiceRunItemsSucceeded,
  mergeEinvoiceRunItems,
  promoteEinvoiceRunRecords,
  releaseEinvoiceRunChunkLease,
  releaseEinvoiceRunItemForRetry,
  renewEinvoiceRunChunkLease,
  resetEinvoiceRunSession,
  transitionEinvoiceRunStatus,
} from "../../../src/features/sync/einvoice-run-repository";

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
  const batchStatementCounts: number[] = [];
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
      batchStatementCounts.push(statements.length);
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
  return { database, db, batchStatementCounts };
}

function header(sourceId: string) {
  return {
    invoiceSourceId: sourceId,
    invoiceNumber: `AB${sourceId}`,
    amount: 100,
  };
}

function insertEinvoiceSettings(
  database: DatabaseSync,
  input: {
    encryptedConfig?: string;
    cursor?: string;
    updatedAt?: string;
  } = {},
) {
  database
    .prepare(
      `INSERT INTO connector_settings (
         id, connector_id, encrypted_config, sync_cursor, created_at, updated_at
       ) VALUES ('einvoice', 'einvoice', ?, ?, 'created', ?)`,
    )
    .run(
      input.encryptedConfig ?? "encrypted-config",
      input.cursor ?? "cursor-old",
      input.updatedAt ?? "version-1",
    );
}

async function createProcessingEinvoiceRun(
  database: DatabaseSync,
  db: D1Database,
  input: {
    runId: string;
    settingsVersion: string;
    items: Parameters<typeof mergeEinvoiceRunItems>[2];
  },
) {
  const { run } = await createOrGetActiveEinvoiceRun(db, {
    id: input.runId,
    trigger: "manual",
    now: "run-created",
  });
  await mergeEinvoiceRunItems(db, run.id, input.items, "items-merged");
  database
    .prepare(
      `UPDATE einvoice_sync_runs
       SET status = 'processing', settings_version = ?, updated_at = 'processing'
       WHERE id = ?`,
    )
    .run(input.settingsVersion, run.id);
  return run;
}

function promotionState(database: DatabaseSync, runId: string) {
  return {
    run: database
      .prepare("SELECT * FROM einvoice_sync_runs WHERE id = ?")
      .get(runId),
    settings: database
      .prepare(
        "SELECT * FROM connector_settings WHERE connector_id = 'einvoice'",
      )
      .get(),
    invoices: database
      .prepare("SELECT * FROM invoices ORDER BY source_id")
      .all(),
    lineItems: database
      .prepare("SELECT * FROM invoice_line_items ORDER BY source_id")
      .all(),
  };
}

describe("durable e-invoice sync runs", () => {
  it("keeps one active connector run and reports whether this caller created it", async () => {
    const { db } = createDb();
    const first = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
      now: "2026-08-12T00:00:00.000Z",
    });
    const second = await createOrGetActiveEinvoiceRun(db, {
      id: "run-2",
      trigger: "scheduled",
      syncJobId: "einvoice:all",
      now: "2026-08-12T00:01:00.000Z",
    });

    expect(first).toMatchObject({ created: true, run: { id: "run-1" } });
    expect(second).toMatchObject({ created: false, run: { id: "run-1" } });
    expect(second.run).toMatchObject({
      trigger: "manual",
      sync_job_id: null,
      scheduled_batch_id: null,
    });
  });

  it("does not let a scheduled caller attach a manual run to its default batch", async () => {
    const { database, db } = createDb();
    database
      .prepare(
        "INSERT INTO scheduled_sync_batches (id, schedule_key, created_at) VALUES ('batch-1', 'default', 'now')",
      )
      .run();
    const manual = await createOrGetActiveEinvoiceRun(db, {
      id: "manual-run",
      trigger: "manual",
      syncJobId: "einvoice:all",
    });
    const scheduled = await createOrGetActiveEinvoiceRun(db, {
      id: "scheduled-run",
      trigger: "scheduled",
      syncJobId: "einvoice:all",
      scheduledBatchId: "batch-1",
    });

    expect(scheduled).toMatchObject({
      created: false,
      run: { id: manual.run.id },
    });
    expect(
      (await getEinvoiceRun(db, manual.run.id))?.scheduled_batch_id,
    ).toBeNull();
  });

  it("allows only one Queue consumer to hold a chunk lease until it expires", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    const startedAt = new Date("2026-08-12T00:00:00.000Z");

    await expect(
      acquireEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-a",
        leaseMs: 60_000,
        now: startedAt,
      }),
    ).resolves.toBe(true);
    await expect(
      acquireEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-b",
        leaseMs: 60_000,
        now: new Date("2026-08-12T00:00:30.000Z"),
      }),
    ).resolves.toBe(false);
    await expect(
      releaseEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-b",
      }),
    ).resolves.toBe(false);
    await expect(
      acquireEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-b",
        leaseMs: 60_000,
        now: new Date("2026-08-12T00:01:01.000Z"),
      }),
    ).resolves.toBe(true);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      chunk_lease_owner: "consumer-b",
      chunk_lease_expires_at: "2026-08-12T00:02:01.000Z",
    });
    await expect(
      releaseEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-b",
        now: "2026-08-12T00:01:02.000Z",
      }),
    ).resolves.toBe(true);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      chunk_lease_owner: null,
      chunk_lease_expires_at: null,
    });
  });

  it("renews the run lease only for the current owner", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      Array.from({ length: 2 }, (_, index) => ({
        invoiceSourceId: `invoice-${index}`,
        header: header(`${index}`),
        normalizedInvoice: { sourceId: `${index}` },
        detailKey: `key-${index}`,
      })),
    );
    await acquireEinvoiceRunChunkLease(db, {
      runId: run.id,
      owner: "consumer-a",
      leaseMs: 60_000,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });
    await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "claim-a",
      leaseMs: 60_000,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });

    await expect(
      renewEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-a",
        leaseMs: 90_000,
        now: new Date("2026-08-12T00:00:30.000Z"),
      }),
    ).resolves.toBe(true);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      chunk_lease_owner: "consumer-a",
      chunk_lease_expires_at: "2026-08-12T00:02:00.000Z",
    });
    expect(await listPendingEinvoiceRunItems(db, run.id)).toMatchObject([
      {
        status: "processing",
        lease_token: "claim-a",
        lease_expires_at: "2026-08-12T00:01:00.000Z",
      },
      {
        status: "processing",
        lease_token: "claim-a",
        lease_expires_at: "2026-08-12T00:01:00.000Z",
      },
    ]);

    await expect(
      renewEinvoiceRunChunkLease(db, {
        runId: run.id,
        owner: "consumer-b",
        leaseMs: 180_000,
        now: new Date("2026-08-12T00:00:45.000Z"),
      }),
    ).resolves.toBe(false);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      chunk_lease_owner: "consumer-a",
      chunk_lease_expires_at: "2026-08-12T00:02:00.000Z",
    });
    expect(
      (await listPendingEinvoiceRunItems(db, run.id)).map(
        (item) => item.lease_expires_at,
      ),
    ).toEqual(["2026-08-12T00:01:00.000Z", "2026-08-12T00:01:00.000Z"]);
  });

  it("durably merges headers and marks invoices without a detail key done", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      [
        {
          invoiceSourceId: "header-only",
          header: header("header-only"),
          normalizedInvoice: { sourceId: "header-only", amount: 100 },
        },
        {
          invoiceSourceId: "needs-detail",
          header: header("needs-detail"),
          normalizedInvoice: { sourceId: "needs-detail", amount: 200 },
          detailKey: "provider-key",
          detailMetadata: { period: "202608" },
        },
      ],
      "2026-08-12T00:00:00.000Z",
    );

    expect(await listCompletedEinvoiceRunItems(db, run.id)).toMatchObject([
      {
        invoice_source_id: "header-only",
        status: "done",
        detail_items_json: null,
      },
    ]);
    expect(await listPendingEinvoiceRunItems(db, run.id)).toMatchObject([
      {
        invoice_source_id: "needs-detail",
        status: "pending",
        detail_key: "provider-key",
      },
    ]);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      total_item_count: 2,
      pending_item_count: 1,
      done_item_count: 1,
    });
  });

  it("claims a bounded batch, retries safely, and prevents stale completion", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      Array.from({ length: 36 }, (_, index) => ({
        invoiceSourceId: `invoice-${index}`,
        header: header(`${index}`),
        normalizedInvoice: { sourceId: `${index}` },
        detailKey: `key-${index}`,
      })),
    );

    const firstClaim = await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "first",
      leaseMs: 1_000,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });
    expect(firstClaim).toHaveLength(35);
    expect(
      await completeEinvoiceRun(db, { runId: run.id, status: "completed" }),
    ).toBe(false);

    const target = firstClaim[0]!;
    expect(
      await releaseEinvoiceRunItemForRetry(db, {
        runId: run.id,
        invoiceSourceId: target.invoice_source_id,
        claimToken: "first",
        error: "temporary provider error",
      }),
    ).toBe(true);
    const retryClaim = await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "retry",
      limit: 1,
      leaseMs: 1_000,
    });
    expect(retryClaim.map((item) => item.invoice_source_id)).toEqual([
      target.invoice_source_id,
    ]);
    expect(
      await markEinvoiceRunItemSucceeded(db, {
        runId: run.id,
        invoiceSourceId: target.invoice_source_id,
        claimToken: "first",
        detailItems: [],
      }),
    ).toBe(false);
    expect(
      await markEinvoiceRunItemSucceeded(db, {
        runId: run.id,
        invoiceSourceId: target.invoice_source_id,
        claimToken: "retry",
        detailItems: [{ sourceId: "line-1" }, { sourceId: "line-2" }],
      }),
    ).toBe(true);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      line_item_count: 2,
    });
  });

  it("completes a claimed 35-item chunk with one set-based update and refreshes counts", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      Array.from({ length: 35 }, (_, index) => ({
        invoiceSourceId: `invoice-${index}`,
        header: header(`${index}`),
        normalizedInvoice: { sourceId: `${index}`, version: "header" },
        detailKey: `key-${index}`,
      })),
    );
    const claimed = await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "chunk-1",
      limit: 35,
      leaseMs: 60_000,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });

    expect(claimed).toHaveLength(35);
    expect(
      await markEinvoiceRunItemsSucceeded(db, {
        runId: run.id,
        claimToken: "chunk-1",
        items: claimed.map((item, index) => ({
          invoiceSourceId: item.invoice_source_id,
          detailItems: [
            { sourceId: `line-${index}-1` },
            { sourceId: `line-${index}-2` },
          ],
          normalizedInvoice: {
            sourceId: item.invoice_source_id,
            version: "detail",
          },
        })),
        now: "2026-08-12T00:00:10.000Z",
      }),
    ).toBe(35);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      total_item_count: 35,
      pending_item_count: 0,
      processing_item_count: 0,
      done_item_count: 35,
      line_item_count: 70,
    });
    expect(await listCompletedEinvoiceRunItems(db, run.id)).toHaveLength(35);
  });

  it("does not let an expired claim batch-complete items reclaimed by another consumer", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      Array.from({ length: 35 }, (_, index) => ({
        invoiceSourceId: `invoice-${index}`,
        header: header(`${index}`),
        normalizedInvoice: { sourceId: `${index}` },
        detailKey: `key-${index}`,
      })),
    );
    const staleClaim = await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "stale",
      leaseMs: 1_000,
      now: new Date("2026-08-12T00:00:00.000Z"),
    });
    const replacementClaim = await claimEinvoiceRunItems(db, {
      runId: run.id,
      claimToken: "replacement",
      leaseMs: 60_000,
      now: new Date("2026-08-12T00:00:02.000Z"),
    });

    expect(replacementClaim).toHaveLength(35);
    expect(
      await markEinvoiceRunItemsSucceeded(db, {
        runId: run.id,
        claimToken: "stale",
        items: staleClaim.map((item) => ({
          invoiceSourceId: item.invoice_source_id,
          detailItems: [],
          normalizedInvoice: { sourceId: item.invoice_source_id },
        })),
      }),
    ).toBe(0);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      pending_item_count: 0,
      processing_item_count: 35,
      done_item_count: 0,
    });
  });

  it("preserves completed normalized invoices and detail items when headers are merged again", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await mergeEinvoiceRunItems(db, run.id, [
      {
        invoiceSourceId: "invoice-1",
        header: { version: "first" },
        normalizedInvoice: { version: "first" },
        detailKey: "first-key",
        detailMetadata: { version: "first" },
        detailItems: [{ sourceId: "first-line" }],
      },
    ]);
    await mergeEinvoiceRunItems(db, run.id, [
      {
        invoiceSourceId: "invoice-1",
        header: { version: "second" },
        normalizedInvoice: { version: "second" },
        detailKey: "second-key",
        detailMetadata: { version: "second" },
        detailItems: [{ sourceId: "second-line" }],
      },
    ]);

    const [item] = await listCompletedEinvoiceRunItems(db, run.id);
    expect(item).toMatchObject({
      header_json: JSON.stringify({ version: "second" }),
      normalized_invoice_json: JSON.stringify({ version: "first" }),
      detail_items_json: JSON.stringify([{ sourceId: "first-line" }]),
      line_item_count: 1,
      status: "done",
    });
  });

  it("initializes atomically only while the connector settings version still matches", async () => {
    const { database, db } = createDb();
    database
      .prepare(
        `INSERT INTO connector_settings (
           id, connector_id, encrypted_config, created_at, updated_at
         ) VALUES ('einvoice', 'einvoice', 'old-config', 'created', 'version-1')`,
      )
      .run();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await transitionEinvoiceRunStatus(db, {
      runId: run.id,
      from: "queued",
      to: "initializing",
    });

    await expect(
      initializeEinvoiceRun(db, {
        runId: run.id,
        items: [
          {
            invoiceSourceId: "invoice-1",
            header: header("1"),
            normalizedInvoice: { sourceId: "1" },
          },
        ],
        encryptedConfig: "new-config",
        expectedSettingsUpdatedAt: "version-1",
        cursor: "cursor-1",
        now: "2026-08-12T00:00:00.000Z",
      }),
    ).resolves.toEqual({ settingsUpdated: true, transitioned: true });
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      status: "processing",
      settings_version: "2026-08-12T00:00:00.000Z",
      total_item_count: 1,
      done_item_count: 1,
    });
    expect(
      database
        .prepare(
          "SELECT encrypted_config, sync_cursor, updated_at FROM connector_settings WHERE connector_id = 'einvoice'",
        )
        .get(),
    ).toEqual({
      encrypted_config: "new-config",
      sync_cursor: "cursor-1",
      updated_at: "2026-08-12T00:00:00.000Z",
    });

    await completeEinvoiceRun(db, {
      runId: run.id,
      status: "completed",
    });

    const secondRun = await createOrGetActiveEinvoiceRun(db, {
      id: "run-2",
      trigger: "manual",
    });
    await transitionEinvoiceRunStatus(db, {
      runId: secondRun.run.id,
      from: "queued",
      to: "initializing",
    });
    database
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'user-saved', updated_at = 'version-3' WHERE connector_id = 'einvoice'",
      )
      .run();

    await expect(
      initializeEinvoiceRun(db, {
        runId: secondRun.run.id,
        items: [
          {
            invoiceSourceId: "invoice-2",
            header: header("2"),
            normalizedInvoice: { sourceId: "2" },
          },
        ],
        encryptedConfig: "stale-login-config",
        expectedSettingsUpdatedAt: "2026-08-12T00:00:00.000Z",
        cursor: "stale-cursor",
        now: "2026-08-12T00:01:00.000Z",
      }),
    ).resolves.toEqual({ settingsUpdated: false, transitioned: false });
    expect(await getEinvoiceRun(db, secondRun.run.id)).toMatchObject({
      status: "initializing",
      total_item_count: 0,
    });
    expect(
      database
        .prepare(
          "SELECT encrypted_config, sync_cursor, updated_at FROM connector_settings WHERE connector_id = 'einvoice'",
        )
        .get(),
    ).toEqual({
      encrypted_config: "user-saved",
      sync_cursor: "cursor-1",
      updated_at: "version-3",
    });
  });

  it("bounds automatic session refresh claims for an active run", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });

    await expect(
      claimEinvoiceRunSessionRefresh(db, {
        runId: run.id,
        maxRefreshes: 2,
      }),
    ).resolves.toBe(true);
    await expect(
      claimEinvoiceRunSessionRefresh(db, {
        runId: run.id,
        maxRefreshes: 2,
      }),
    ).resolves.toBe(true);
    await expect(
      claimEinvoiceRunSessionRefresh(db, {
        runId: run.id,
        maxRefreshes: 2,
      }),
    ).resolves.toBe(false);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      session_refresh_count: 2,
    });
  });

  it("resets a pinned session atomically and rejects a concurrent settings save", async () => {
    const { database, db } = createDb();
    database
      .prepare(
        `INSERT INTO connector_settings (
           id, connector_id, encrypted_config, sync_cursor, created_at, updated_at
         ) VALUES (
           'einvoice', 'einvoice', 'session-1', 'cursor-1', 'created', 'version-1'
         )`,
      )
      .run();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    database
      .prepare(
        `UPDATE einvoice_sync_runs
         SET status = 'processing', settings_version = 'version-1'
         WHERE id = ?`,
      )
      .run(run.id);

    await expect(
      resetEinvoiceRunSession(db, {
        runId: run.id,
        encryptedConfig: "session-reset",
        expectedSettingsUpdatedAt: "version-1",
        now: "version-2",
      }),
    ).resolves.toEqual({ settingsUpdated: true, transitioned: true });
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      status: "initializing",
      settings_version: "version-2",
      updated_at: "version-2",
    });
    expect(
      database
        .prepare(
          `SELECT encrypted_config, sync_cursor, updated_at
           FROM connector_settings WHERE connector_id = 'einvoice'`,
        )
        .get(),
    ).toEqual({
      encrypted_config: "session-reset",
      sync_cursor: "cursor-1",
      updated_at: "version-2",
    });

    database
      .prepare(
        `UPDATE einvoice_sync_runs
         SET status = 'processing'
         WHERE id = ?`,
      )
      .run(run.id);
    database
      .prepare(
        `UPDATE connector_settings
         SET encrypted_config = 'user-saved', updated_at = 'version-3'
         WHERE connector_id = 'einvoice'`,
      )
      .run();
    await expect(
      resetEinvoiceRunSession(db, {
        runId: run.id,
        encryptedConfig: "stale-reset",
        expectedSettingsUpdatedAt: "version-2",
        now: "version-4",
      }),
    ).resolves.toEqual({ settingsUpdated: false, transitioned: false });
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      status: "processing",
      settings_version: "version-2",
      updated_at: "version-2",
    });
    expect(
      database
        .prepare(
          `SELECT encrypted_config, sync_cursor, updated_at
           FROM connector_settings WHERE connector_id = 'einvoice'`,
        )
        .get(),
    ).toEqual({
      encrypted_config: "user-saved",
      sync_cursor: "cursor-1",
      updated_at: "version-3",
    });
  });

  it("resets a persisted session during the first header initialization", async () => {
    const { database, db } = createDb();
    database
      .prepare(
        `INSERT INTO connector_settings (
           id, connector_id, encrypted_config, created_at, updated_at
         ) VALUES ('einvoice', 'einvoice', 'session-config', 'created', 'version-1')`,
      )
      .run();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    await transitionEinvoiceRunStatus(db, {
      runId: run.id,
      from: "queued",
      to: "initializing",
    });

    await expect(
      resetEinvoiceRunSession(db, {
        runId: run.id,
        encryptedConfig: "credentials-only",
        expectedSettingsUpdatedAt: "version-1",
        now: "version-2",
      }),
    ).resolves.toEqual({ settingsUpdated: true, transitioned: true });
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      status: "initializing",
      settings_version: "version-2",
    });
    expect(
      database
        .prepare(
          `SELECT encrypted_config, updated_at
           FROM connector_settings WHERE connector_id = 'einvoice'`,
        )
        .get(),
    ).toEqual({
      encrypted_config: "credentials-only",
      updated_at: "version-2",
    });
  });

  it("promotes completed invoices and lines with stable records and makes replay a no-op", async () => {
    const { database, db } = createDb();
    insertEinvoiceSettings(database);
    database
      .prepare(
        `INSERT INTO invoices (
           id, connector_id, source_id, invoice_number, invoice_date,
           seller_name, amount, raw_payload, created_at, updated_at
         ) VALUES (
           'einvoice:invoice-existing', 'einvoice', 'invoice-existing',
           'OLD', '2026-01-01', 'old seller', 1, '{}', 'old', 'old'
         )`,
      )
      .run();
    const run = await createProcessingEinvoiceRun(database, db, {
      runId: "run-1",
      settingsVersion: "version-1",
      items: [
        {
          invoiceSourceId: "invoice-existing",
          header: header("existing"),
          normalizedInvoice: {
            sourceId: "invoice-existing",
            invoiceNumber: "AB-EXISTING",
            invoiceDate: "2026-08-01",
            sellerName: "existing seller",
            amount: 80,
            raw: { provider: "updated-existing" },
          },
          detailItems: [],
        },
        {
          invoiceSourceId: "invoice-new",
          header: header("new"),
          normalizedInvoice: {
            sourceId: "invoice-new",
            invoiceNumber: "AB-NEW",
            invoiceDate: "2026-08-02",
            sellerName: "new seller",
            amount: 120,
            raw: { provider: "invoice-raw", nested: { value: 1 } },
          },
          detailItems: [
            {
              invoiceSourceId: "invoice-new",
              sourceId: "line-1",
              lineNumber: 1,
              description: "line one",
              quantity: 2,
              unitPrice: 60,
              amount: 120,
              raw: "line-raw",
            },
          ],
        },
      ],
    });

    await expect(
      promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: "version-1",
        cursor: "cursor-new",
        now: "2026-08-12T01:00:00.000Z",
      }),
    ).resolves.toBe(true);
    expect(
      database
        .prepare(
          `SELECT id, source_id, invoice_number, invoice_date, seller_name,
                  amount, raw_payload, created_at, updated_at
           FROM invoices ORDER BY source_id`,
        )
        .all(),
    ).toEqual([
      {
        id: "einvoice:invoice-existing",
        source_id: "invoice-existing",
        invoice_number: "AB-EXISTING",
        invoice_date: "2026-08-01",
        seller_name: "existing seller",
        amount: 80,
        raw_payload: JSON.stringify({ provider: "updated-existing" }),
        created_at: "old",
        updated_at: "2026-08-12T01:00:00.000Z",
      },
      {
        id: "einvoice:invoice-new",
        source_id: "invoice-new",
        invoice_number: "AB-NEW",
        invoice_date: "2026-08-02",
        seller_name: "new seller",
        amount: 120,
        raw_payload: JSON.stringify({
          provider: "invoice-raw",
          nested: { value: 1 },
        }),
        created_at: "2026-08-12T01:00:00.000Z",
        updated_at: "2026-08-12T01:00:00.000Z",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT id, invoice_id, invoice_source_id, source_id, line_number,
                  description, quantity, unit_price, amount, raw_payload
           FROM invoice_line_items`,
        )
        .get(),
    ).toEqual({
      id: "einvoice:invoice-new:item:line-1",
      invoice_id: "einvoice:invoice-new",
      invoice_source_id: "invoice-new",
      source_id: "line-1",
      line_number: 1,
      description: "line one",
      quantity: 2,
      unit_price: 60,
      amount: 120,
      raw_payload: JSON.stringify("line-raw"),
    });
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      new_invoice_count: 1,
      promoted_at: "2026-08-12T01:00:00.000Z",
      settings_version: "2026-08-12T01:00:00.000Z",
    });
    expect(
      database
        .prepare(
          `SELECT sync_cursor, updated_at FROM connector_settings
           WHERE connector_id = 'einvoice'`,
        )
        .get(),
    ).toEqual({
      sync_cursor: "cursor-new",
      updated_at: "2026-08-12T01:00:00.000Z",
    });

    const promotedState = promotionState(database, run.id);
    await expect(
      promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: "2026-08-12T01:00:00.000Z",
        cursor: "cursor-replay",
        now: "2026-08-12T02:00:00.000Z",
      }),
    ).resolves.toBe(false);
    expect(promotionState(database, run.id)).toEqual(promotedState);
  });

  it("does not promote anything with stale settings or unfinished detail work", async () => {
    const stale = createDb();
    insertEinvoiceSettings(stale.database, { updatedAt: "user-version" });
    const staleRun = await createProcessingEinvoiceRun(
      stale.database,
      stale.db,
      {
        runId: "stale-run",
        settingsVersion: "run-version",
        items: [
          {
            invoiceSourceId: "invoice-stale",
            header: header("stale"),
            normalizedInvoice: {
              invoiceNumber: "AB-STALE",
              invoiceDate: "2026-08-01",
              amount: 1,
            },
            detailItems: [],
          },
        ],
      },
    );
    const staleState = promotionState(stale.database, staleRun.id);
    await expect(
      promoteEinvoiceRunRecords(stale.db, {
        runId: staleRun.id,
        expectedSettingsUpdatedAt: "run-version",
        cursor: "stale-cursor",
        now: "promotion-time",
      }),
    ).resolves.toBe(false);
    expect(promotionState(stale.database, staleRun.id)).toEqual(staleState);

    const unfinished = createDb();
    insertEinvoiceSettings(unfinished.database, { updatedAt: "version-1" });
    const unfinishedRun = await createProcessingEinvoiceRun(
      unfinished.database,
      unfinished.db,
      {
        runId: "unfinished-run",
        settingsVersion: "version-1",
        items: [
          {
            invoiceSourceId: "invoice-done",
            header: header("done"),
            normalizedInvoice: {
              invoiceNumber: "AB-DONE",
              invoiceDate: "2026-08-01",
              amount: 1,
            },
            detailItems: [],
          },
          {
            invoiceSourceId: "invoice-pending",
            header: header("pending"),
            normalizedInvoice: {
              invoiceNumber: "AB-PENDING",
              invoiceDate: "2026-08-02",
              amount: 2,
            },
            detailKey: "needs-detail",
          },
        ],
      },
    );
    const unfinishedState = promotionState(
      unfinished.database,
      unfinishedRun.id,
    );
    await expect(
      promoteEinvoiceRunRecords(unfinished.db, {
        runId: unfinishedRun.id,
        expectedSettingsUpdatedAt: "version-1",
        cursor: "unfinished-cursor",
        now: "promotion-time",
      }),
    ).resolves.toBe(false);
    expect(promotionState(unfinished.database, unfinishedRun.id)).toEqual(
      unfinishedState,
    );
  });

  it("promotes a large run in one fixed five-statement batch", async () => {
    const { database, db, batchStatementCounts } = createDb();
    insertEinvoiceSettings(database);
    const run = await createProcessingEinvoiceRun(database, db, {
      runId: "large-run",
      settingsVersion: "version-1",
      items: Array.from({ length: 120 }, (_, index) => ({
        invoiceSourceId: `invoice-${index}`,
        header: header(`${index}`),
        normalizedInvoice: {
          invoiceNumber: `AB-${index}`,
          invoiceDate: "2026-08-01",
          sellerName: `seller-${index}`,
          amount: index,
          raw: { invoice: index },
        },
        detailItems: [
          {
            sourceId: `line-${index}`,
            lineNumber: 1,
            description: `line-${index}`,
            quantity: 1,
            unitPrice: index,
            amount: index,
            raw: { line: index },
          },
        ],
      })),
    });
    batchStatementCounts.length = 0;

    await expect(
      promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: "version-1",
        cursor: "large-cursor",
        now: "2026-08-12T03:00:00.000Z",
      }),
    ).resolves.toBe(true);
    expect(batchStatementCounts).toEqual([5]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM invoices").get(),
    ).toEqual({ count: 120 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM invoice_line_items")
        .get(),
    ).toEqual({ count: 120 });
  });

  it("uses status compare-and-set for active and terminal transitions", async () => {
    const { db } = createDb();
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id: "run-1",
      trigger: "manual",
    });
    expect(
      await transitionEinvoiceRunStatus(db, {
        runId: run.id,
        from: "queued",
        to: "initializing",
      }),
    ).toBe(true);
    expect(
      await transitionEinvoiceRunStatus(db, {
        runId: run.id,
        from: "queued",
        to: "processing",
      }),
    ).toBe(false);
    expect(
      await completeEinvoiceRun(db, {
        runId: run.id,
        status: "failed",
        error: "boom",
      }),
    ).toBe(true);
    expect(
      await completeEinvoiceRun(db, { runId: run.id, status: "failed" }),
    ).toBe(false);
  });

  it("removes an obsolete fetchDetails-only public config during migration", () => {
    const { database } = createDb();
    database
      .prepare(
        `INSERT INTO connector_settings
           (id, connector_id, encrypted_config, public_config, created_at, updated_at)
         VALUES ('einvoice', 'einvoice', '{}', '{"fetchDetails":true}', 'old', 'old')`,
      )
      .run();
    // The migration is idempotent in production but has already run in this fixture;
    // execute just its cleanup statement to model an upgraded populated database.
    const migrationPath = fileURLToPath(
      new URL(
        "../../../../../packages/db/migrations/0028_einvoice_durable_runs.sql",
        import.meta.url,
      ),
    );
    const cleanup = readFileSync(migrationPath, "utf8").match(
      /UPDATE connector_settings[\s\S]*?;\s*$/,
    )![0];
    database.exec(cleanup);
    expect(
      database
        .prepare(
          "SELECT public_config FROM connector_settings WHERE connector_id = 'einvoice'",
        )
        .get(),
    ).toEqual({ public_config: null });
  });
});
