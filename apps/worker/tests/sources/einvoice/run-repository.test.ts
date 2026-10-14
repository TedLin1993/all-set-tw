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
  createOrGetActiveEinvoiceRun,
  getEinvoiceRun,
  mergeEinvoiceRunItems,
  promoteEinvoiceRunRecords,
} from "../../../src/sources/einvoice/run-repository";
import {
  processEinvoiceSyncChunk,
  startEinvoiceSyncRun,
} from "../../../src/sources/einvoice/sync";
import { syncRoutes } from "../../../src/features/sync/route";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";

const version = "2026-09-01T00:00:00Z";
const promotedAt = "2026-09-02T00:00:00Z";

describe("發票分段同步的正式資料（隔離 D1）", () => {
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
      db.prepare("DROP TRIGGER IF EXISTS fail_initial_cursor"),
      ...[
        "invoice_line_items",
        "invoices",
        "einvoice_sync_run_items",
        "einvoice_sync_runs",
        "connector_settings",
        "sync_jobs",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db
        .prepare(
          "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('einvoice', 'einvoice', 'synthetic-encrypted', 'old', ?, ?)",
        )
        .bind(version, version),
      db
        .prepare(
          `INSERT INTO sync_jobs (id, connector_id, scope, enabled, interval_minutes, next_run_at, created_at, updated_at)
        VALUES ('einvoice:all', 'einvoice', 'all', 0, 1440, ?, ?, ?)`,
        )
        .bind(version, version, version),
    ]);
  });
  async function syncEnv(withSession = false) {
    const key = "11".repeat(32);
    const encrypted = await encryptJson(
      {
        mobile: "0912345678",
        password: "synthetic",
        ...(withSession
          ? {
              sid: "synthetic-sid",
              token: "synthetic-token",
              loginAppId: "synthetic-app",
              loginLiat: 1,
              loginSsMe: "synthetic-session",
            }
          : {}),
      },
      key,
    );
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'einvoice'",
      )
      .bind(encrypted)
      .run();
    return {
      DB: db,
      CONFIG_ENCRYPTION_KEY: key,
      SYNC_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env;
  }
  async function prepareRun(done = true, id = "run", createdAt = version) {
    const { run } = await createOrGetActiveEinvoiceRun(db, {
      id,
      trigger: "manual",
      now: createdAt,
    });
    await mergeEinvoiceRunItems(
      db,
      run.id,
      [
        {
          invoiceSourceId: "invoice-1",
          header: { invoiceNumber: "AB12345678" },
          normalizedInvoice: {
            sourceId: "invoice-1",
            invoiceNumber: "AB12345678",
            invoiceDate: "2026-09-01",
            sellerName: "測試商店",
            amount: 120,
          },
          detailKey: "detail-1",
          ...(done
            ? {
                detailItems: [
                  {
                    invoiceSourceId: "invoice-1",
                    sourceId: "line-1",
                    lineNumber: 1,
                    description: "測試品項",
                    quantity: 2,
                    unitPrice: 60,
                    amount: 120,
                  },
                ],
              }
            : {}),
        },
      ],
      version,
    );
    await db
      .prepare(
        "UPDATE einvoice_sync_runs SET status = 'processing', settings_version = (SELECT updated_at FROM connector_settings WHERE connector_id = 'einvoice') WHERE id = ?",
      )
      .bind(run.id)
      .run();
    return run;
  }
  async function snapshot() {
    return Promise.all(
      [
        "einvoice_sync_runs",
        "connector_settings",
        "invoices",
        "invoice_line_items",
      ].map(
        async (table) =>
          (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
            .results,
      ),
    );
  }

  it.each(["manual", "scheduled"] as const)(
    "重試 %s active run 會補送同一個 continuation",
    async (trigger) => {
      const env = await syncEnv();
      const { run } = await startEinvoiceSyncRun(env, { trigger });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await syncRoutes.request(
          "/connectors/einvoice/sync",
          { method: "POST" },
          env,
        );
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({ runId: run.id });
      }
      expect(env.SYNC_QUEUE.send).toHaveBeenCalledTimes(2);
      expect(env.SYNC_QUEUE.send).toHaveBeenCalledWith({
        type: "run-einvoice-chunk",
        runId: run.id,
      });
      expect(await getEinvoiceRun(db, run.id)).toMatchObject({
        trigger,
        status: "queued",
      });
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM einvoice_sync_runs")
          .first("count"),
      ).toBe(1);
    },
  );

  it("初始化 cursor 寫入失敗會結案並清鎖，修復後可以重新啟動", async () => {
    const env = await syncEnv();
    await db
      .prepare(
        `CREATE TRIGGER fail_initial_cursor BEFORE UPDATE OF sync_cursor ON connector_settings
      BEGIN SELECT RAISE(ABORT, 'synthetic startup failure'); END`,
      )
      .run();
    await expect(
      startEinvoiceSyncRun(env, { trigger: "manual" }),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT status FROM einvoice_sync_runs").first("status"),
    ).toBe("failed");
    expect(
      await db
        .prepare("SELECT locked_by, last_status, enabled FROM sync_jobs")
        .first(),
    ).toEqual({ locked_by: null, last_status: "failed", enabled: 0 });
    await db.prepare("DROP TRIGGER fail_initial_cursor").run();
    expect(
      (await startEinvoiceSyncRun(env, { trigger: "manual" })).created,
    ).toBe(true);
  });

  it("完整發票與品項一起寫入，重送不重複資料或推進 cursor", async () => {
    const run = await prepareRun();
    expect(
      await promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: version,
        cursor: "new",
        now: promotedAt,
      }),
    ).toBe(true);
    expect(
      (
        await db
          .prepare("SELECT id, source_id, invoice_number, amount FROM invoices")
          .all()
      ).results,
    ).toEqual([
      {
        id: "einvoice:invoice-1",
        source_id: "invoice-1",
        invoice_number: "AB12345678",
        amount: 120,
      },
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT invoice_id, quantity, unit_price, amount FROM invoice_line_items",
          )
          .all()
      ).results,
    ).toEqual([
      {
        invoice_id: "einvoice:invoice-1",
        quantity: 2,
        unit_price: 60,
        amount: 120,
      },
    ]);
    expect(await getEinvoiceRun(db, run.id)).toMatchObject({
      new_invoice_count: 1,
      promoted_at: promotedAt,
    });
    expect(
      await db
        .prepare("SELECT sync_cursor, updated_at FROM connector_settings")
        .first(),
    ).toEqual({ sync_cursor: "new", updated_at: promotedAt });
    const after = await snapshot();
    expect(
      await promoteEinvoiceRunRecords(db, {
        runId: run.id,
        expectedSettingsUpdatedAt: promotedAt,
        cursor: "replay",
        now: "2026-09-03T00:00:00Z",
      }),
    ).toBe(false);
    expect(await snapshot()).toEqual(after);
  });

  it("完整分段同步首次成功啟用排程；重送及後續同步保留手動關閉與自訂排程", async () => {
    const env = await syncEnv(true);
    await db
      .prepare(
        "UPDATE sync_jobs SET schedule_mode = 'custom', interval_minutes = 10080, preferred_time = '09:30', preferred_weekdays = '[1,3,5]'",
      )
      .run();
    const schedule = {
      schedule_mode: "custom",
      interval_minutes: 10080,
      preferred_time: "09:30",
      preferred_weekdays: "[1,3,5]",
    };
    const job = () => db.prepare("SELECT * FROM sync_jobs").first();
    const first = await prepareRun(true, "first", new Date().toISOString());
    expect(await processEinvoiceSyncChunk(env, first.id)).toEqual({
      status: "completed",
    });
    expect(await job()).toMatchObject({
      ...schedule,
      enabled: 1,
      last_status: "success",
      last_success_at: expect.any(String),
      locked_by: null,
    });

    await db.prepare("UPDATE sync_jobs SET enabled = 0").run();
    expect(await processEinvoiceSyncChunk(env, first.id)).toEqual({
      status: "terminal",
    });
    expect(await job()).toMatchObject({ ...schedule, enabled: 0 });
    const second = await prepareRun(true, "second", new Date().toISOString());
    expect(await processEinvoiceSyncChunk(env, second.id)).toEqual({
      status: "completed",
    });
    expect(await job()).toMatchObject({ ...schedule, enabled: 0 });
  });

  it.each(["settings-changed", "incomplete"])(
    "%s 的 run 不會發布部分發票或覆蓋 cursor",
    async (state) => {
      const run = await prepareRun(state !== "incomplete");
      if (state === "settings-changed")
        await db
          .prepare(
            "UPDATE connector_settings SET encrypted_config = 'new-secret', updated_at = 'new-version'",
          )
          .run();
      const before = await snapshot();
      expect(
        await promoteEinvoiceRunRecords(db, {
          runId: run.id,
          expectedSettingsUpdatedAt: version,
          cursor: "stale",
          now: promotedAt,
        }),
      ).toBe(false);
      expect(await snapshot()).toEqual(before);
    },
  );
});
