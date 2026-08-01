import { describe, expect, it } from "vitest";
import {
  getActionableSyncJobs,
  getConfiguredSyncJobs,
  getSyncSourceStatus,
  isActionableSyncJob,
} from "./sync-status";
import type { SyncJobRow } from "./types";

function job(overrides: Partial<SyncJobRow>): SyncJobRow {
  return {
    id: "esun:all",
    connectorId: "esun",
    configured: false,
    scope: "all",
    enabled: false,
    intervalMinutes: 1440,
    nextRunAt: "2026-08-02T00:00:00.000Z",
    scheduleMode: "inherit",
    preferredTime: "06:00",
    preferredWeekday: 1,
    lockedUntil: null,
    lockedBy: null,
    lockTrigger: null,
    lockScope: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    lastError: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    running: false,
    ...overrides,
  };
}

describe("sync source status", () => {
  it("keeps legacy failures on unconfigured connectors in the unconfigured state", () => {
    const unconfigured = job({ lastStatus: "needs_user_action" });

    expect(getSyncSourceStatus(unconfigured)).toBe("unconfigured");
    expect(isActionableSyncJob(unconfigured)).toBe(false);
  });

  it("keeps manual failures on configured connectors actionable", () => {
    const configured = job({ configured: true, lastStatus: "failed" });

    expect(getSyncSourceStatus(configured)).toBe("needs_action");
    expect(isActionableSyncJob(configured)).toBe(true);
  });

  it("separates configured healthy sources from connectors that have not been set up", () => {
    const configured = job({
      configured: true,
      lastSuccessAt: "2026-08-01T00:00:00.000Z",
    });
    const unconfigured = job({ id: "tdcc:all", connectorId: "tdcc" });

    expect(getConfiguredSyncJobs([configured, unconfigured])).toEqual([
      configured,
    ]);
    expect(getSyncSourceStatus(configured)).toBe("healthy");
    expect(getSyncSourceStatus(unconfigured)).toBe("unconfigured");
  });

  it("counts at most the all-scope job for each configured source", () => {
    const source = job({ configured: true, lastStatus: "failed" });
    const nestedScope = job({
      configured: true,
      id: "esun:bank",
      scope: "bank",
      lastStatus: "failed",
    });

    expect(getActionableSyncJobs([source, nestedScope])).toEqual([source]);
  });
});
