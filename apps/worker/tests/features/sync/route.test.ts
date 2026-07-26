import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
} from "../../../src/connectors/taishin";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  prepareTaishinCaptchaSession: vi.fn(),
  startManualSyncJob: vi.fn(),
  syncTaishin: vi.fn(),
}));

vi.mock("../../../src/features/sync/manual-job", () => ({
  startManualSyncJob: mocks.startManualSyncJob,
}));

vi.mock("../../../src/features/sync/service", () => ({
  NeedsUserActionError: class NeedsUserActionError extends Error {},
  prepareSinopacCaptchaSession: vi.fn(),
  prepareTaishinCaptchaSession: mocks.prepareTaishinCaptchaSession,
  safeErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncCathaybk: vi.fn(),
  syncEinvoice: vi.fn(),
  syncEsun: vi.fn(),
  syncSinopac: vi.fn(),
  syncTaishin: mocks.syncTaishin,
  syncTdcc: vi.fn(),
  SyncAlreadyRunningError: class SyncAlreadyRunningError extends Error {},
  SYNC_SCOPE_ALL: "all",
  TDCC_SCOPE_BANK: "bank",
  TDCC_SCOPE_INVESTMENTS: "investments",
  TDCC_SCOPE_TRADES: "trades",
  withManualSyncLock: async (
    _env: Env,
    _connectorId: string,
    _scope: string,
    task: () => Promise<unknown>,
  ) => task(),
}));

import { syncRoutes } from "../../../src/features/sync/route";

const env = {} as Env;
const executionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareTaishinCaptchaSession.mockResolvedValue({
    captchaImage: "data:image/jpeg;base64,AQID",
    expiresAt: "2026-07-23T12:02:00.000Z",
    digitCount: 6,
  });
  mocks.syncTaishin.mockResolvedValue({
    success: true,
    connectorId: "taishin",
    scope: "all",
    records: 3,
    cursorUpdated: true,
  });
  mocks.startManualSyncJob.mockImplementation(
    async (
      _env: Env,
      connectorId: string,
      scope: string,
      task: () => Promise<unknown>,
    ) => ({
      runId: "manual-run-1",
      completion: task(),
      connectorId,
      scope,
    }),
  );
});

describe("Taishin sync routes", () => {
  it("accepts an empty sync body as a background manual sync", async () => {
    const response = await syncRoutes.request(
      "/connectors/taishin/sync",
      { method: "POST" },
      env,
      executionCtx,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      connectorId: "taishin",
      scope: "all",
      runId: "manual-run-1",
    });
    expect(mocks.syncTaishin).toHaveBeenCalledWith(env, "manual", {});
    expect(executionCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it("rejects malformed manual CAPTCHA input", async () => {
    const response = await syncRoutes.request(
      "/connectors/taishin/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "12AB" }),
      },
      env,
      executionCtx,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(mocks.syncTaishin).not.toHaveBeenCalled();
  });

  it("returns the manual CAPTCHA metadata", async () => {
    const response = await syncRoutes.request(
      "/connectors/taishin/captcha",
      { method: "POST" },
      env,
      executionCtx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      digitCount: 6,
      captchaImage: "data:image/jpeg;base64,AQID",
    });
  });

  it("maps Browser Rendering capacity and interactive connection failures", async () => {
    mocks.prepareTaishinCaptchaSession.mockRejectedValueOnce(
      new TaishinBrowserCapacityError("browser busy", 17),
    );
    const busy = await syncRoutes.request(
      "/connectors/taishin/captcha",
      { method: "POST" },
      env,
      executionCtx,
    );
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("17");
    await expect(busy.json()).resolves.toMatchObject({
      error: { code: "TAISHIN_BROWSER_BUSY" },
    });

    mocks.syncTaishin.mockRejectedValueOnce(
      new TaishinConnectionError("schema drift"),
    );
    const failed = await syncRoutes.request(
      "/connectors/taishin/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "123456" }),
      },
      env,
      executionCtx,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "TAISHIN_CONNECTION_FAILED" },
    });
  });
});