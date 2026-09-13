import {
  failSyncJob,
  findNextDueSyncJob,
  markManualSyncFailure,
  type SyncJobRow,
} from "@taiwan-fin-hub/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";

const now = "2026-07-15T00:00:00.000Z";

describe("sync job user-action pause", () => {
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
      db.prepare("DELETE FROM connector_settings"),
      db.prepare("DELETE FROM sync_jobs"),
    ]);
  });

  it("keeps an enabled job out of the scheduler while user action is required", async () => {
    const db = harness.binding;
    await db
      .prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, created_at, updated_at) VALUES ('sinopac', 'sinopac', 'synthetic', ?, ?)",
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO sync_jobs (
          id, connector_id, scope, enabled, interval_minutes, next_run_at,
          last_status, created_at, updated_at
        ) VALUES (
          'sinopac:all', 'sinopac', 'all', 1, 1440, ?,
          'needs_user_action', ?, ?
        )`,
      )
      .bind(now, now, now)
      .run();

    expect(await findNextDueSyncJob(db, new Date(now))).toBeNull();

    await db
      .prepare(
        "UPDATE sync_jobs SET last_status = 'success' WHERE id = 'sinopac:all'",
      )
      .run();

    expect(await findNextDueSyncJob(db, new Date(now))).toMatchObject({
      id: "sinopac:all",
      enabled: 1,
    });
  });

  it("records required user action without disabling the user's schedule", async () => {
    const db = harness.binding;
    await db
      .prepare(
        `INSERT INTO sync_jobs (
          id, connector_id, scope, enabled, interval_minutes, next_run_at,
          created_at, updated_at
        ) VALUES (
          'sinopac:all', 'sinopac', 'all', 1, 1440, ?, ?, ?
        )`,
      )
      .bind("2026-07-16T00:00:00.000Z", now, now)
      .run();

    const job = {
      id: "sinopac:all",
      connector_id: "sinopac",
      scope: "all",
      enabled: 1,
      interval_minutes: 1440,
      next_run_at: "2026-07-16T00:00:00.000Z",
    } as SyncJobRow;

    await failSyncJob(db, job, {
      status: "needs_user_action",
      errorMessage: "請重新驗證",
    });
    await markManualSyncFailure(db, "sinopac", "all", {
      status: "needs_user_action",
      errorMessage: "請重新驗證",
    });

    const row = await db
      .prepare(
        "SELECT enabled, last_status, last_error FROM sync_jobs WHERE id = ?",
      )
      .bind("sinopac:all")
      .first<{ enabled: number; last_status: string; last_error: string }>();

    expect(row).toMatchObject({
      enabled: 1,
      last_status: "needs_user_action",
      last_error: "請重新驗證",
    });
  });
});
