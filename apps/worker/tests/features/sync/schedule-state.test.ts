import {
  failSyncJob,
  findNextDueSyncJob,
  markManualSyncFailure,
  type SyncJobRow,
} from "@taiwan-fin-hub/db";
import { describe, expect, it, vi } from "vitest";

describe("sync job user-action pause", () => {
  it("keeps an enabled job out of the scheduler while user action is required", async () => {
    let sql = "";
    const db = {
      prepare: vi.fn((statement: string) => {
        sql = statement;
        return {
          bind: vi.fn(() => ({ first: vi.fn().mockResolvedValue(null) })),
        };
      }),
    } as unknown as D1Database;

    await findNextDueSyncJob(db, new Date("2026-07-15T00:00:00.000Z"));
    expect(sql).toContain("last_status != 'needs_user_action'");
    expect(sql).toContain("FROM connector_settings");
  });

  it("records required user action without disabling the user's schedule", async () => {
    const statements: string[] = [];
    const db = {
      prepare: vi.fn((statement: string) => {
        statements.push(statement);
        return {
          bind: vi.fn(() => ({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          })),
        };
      }),
    } as unknown as D1Database;
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

    expect(statements).toHaveLength(2);
    for (const statement of statements)
      expect(statement).not.toMatch(/\benabled\s*=/);
  });
});
