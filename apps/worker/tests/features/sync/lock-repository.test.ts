import { describe, expect, it } from "vitest";
import { acquireSyncJobLock, renewSyncJobLock } from "@taiwan-fin-hub/db";

function recordingDb(changes: number) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      calls.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async run() {
          return { meta: { changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("sync job lock repository", () => {
  it("acquires a lease with ownership and expiry bindings", async () => {
    const { db, calls } = recordingDb(1);
    await expect(
      acquireSyncJobLock(db, {
        lockRowId: "tdcc:all",
        scope: "all",
        trigger: "scheduled",
        runId: "run-1",
        leaseMs: 30 * 60 * 1000,
      }),
    ).resolves.toBe(true);

    expect(calls[0]?.sql).toContain("locked_until");
    expect(calls[0]?.bindings).toContain("run-1");
    expect(calls[0]?.bindings).toContain("tdcc:all");
  });

  it("reports a lost lease when heartbeat ownership no longer matches", async () => {
    const { db } = recordingDb(0);
    await expect(
      renewSyncJobLock(db, {
        lockRowId: "tdcc:all",
        runId: "old-run",
        leaseMs: 30 * 60 * 1000,
      }),
    ).resolves.toBe(false);
  });
});
