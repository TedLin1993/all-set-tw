import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CtbcConnectionError,
  ObankConnectionError,
} from "@taiwan-fin-hub/connectors";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
} from "../../../src/connectors/taishin";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  prepareTaishinCaptchaSession: vi.fn(),
  prepareObankCaptchaSession: vi.fn(),
  syncCtbc: vi.fn(),
  syncObank: vi.fn(),
  syncTaishin: vi.fn(),
}));

vi.mock("../../../src/features/sync/service", () => ({
  NeedsUserActionError: class NeedsUserActionError extends Error {},
  prepareSinopacCaptchaSession: vi.fn(),
  prepareTaishinCaptchaSession: mocks.prepareTaishinCaptchaSession,
  prepareObankCaptchaSession: mocks.prepareObankCaptchaSession,
  safeErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncCathaybk: vi.fn(),
  syncCtbc: mocks.syncCtbc,
  syncEinvoice: vi.fn(),
  syncEsun: vi.fn(),
  syncSinopac: vi.fn(),
  syncObank: mocks.syncObank,
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
  mocks.syncCtbc.mockResolvedValue({
    success: true,
    connectorId: "ctbc",
    scope: "all",
    records: 4,
    cursorUpdated: true,
  });
  mocks.prepareObankCaptchaSession.mockResolvedValue({
    captchaImage: "data:image/png;base64,AQID",
    expiresAt: "2026-08-08T12:02:00.000Z",
    captchaLength: 4,
    captchaKind: "alphanumeric",
  });
  mocks.syncObank.mockResolvedValue({
    success: true,
    connectorId: "obank",
    scope: "all",
    records: 3,
    cursorUpdated: true,
  });
});

describe("CTBC sync route", () => {
  it("dispatches a manual sync", async () => {
    const response = await syncRoutes.request(
      "/connectors/ctbc/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.syncCtbc).toHaveBeenCalledWith(env, "manual");
  });

  it("maps mobile API connection failures", async () => {
    mocks.syncCtbc.mockRejectedValueOnce(
      new CtbcConnectionError("schema drift"),
    );
    const failed = await syncRoutes.request(
      "/connectors/ctbc/sync",
      { method: "POST" },
      env,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "CTBC_CONNECTION_FAILED" },
    });
  });
});

describe("Taishin sync routes", () => {
  it("accepts an empty sync body and dispatches the manual sync", async () => {
    const response = await syncRoutes.request(
      "/connectors/taishin/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.syncTaishin).toHaveBeenCalledWith(env, "manual", {});
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
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      digitCount: 6,
      captchaImage: "data:image/jpeg;base64,AQID",
    });
  });

  it("maps Browser Rendering capacity and connection failures", async () => {
    mocks.prepareTaishinCaptchaSession.mockRejectedValueOnce(
      new TaishinBrowserCapacityError("browser busy", 17),
    );
    const busy = await syncRoutes.request(
      "/connectors/taishin/captcha",
      { method: "POST" },
      env,
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
      { method: "POST" },
      env,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "TAISHIN_CONNECTION_FAILED" },
    });
  });
});

describe("O-Bank sync routes", () => {
  it("returns the App API CAPTCHA metadata", async () => {
    const response = await syncRoutes.request(
      "/connectors/obank/captcha",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      captchaLength: 4,
      captchaKind: "alphanumeric",
      captchaImage: "data:image/png;base64,AQID",
    });
  });

  it("accepts four alphanumeric characters and rejects malformed input", async () => {
    const valid = await syncRoutes.request(
      "/connectors/obank/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "A1b2" }),
      },
      env,
    );
    expect(valid.status).toBe(200);
    expect(mocks.syncObank).toHaveBeenCalledWith(env, "manual", {
      captcha: "A1b2",
    });

    const invalid = await syncRoutes.request(
      "/connectors/obank/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "12345" }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
  });

  it("maps App API connection failures", async () => {
    mocks.syncObank.mockRejectedValueOnce(
      new ObankConnectionError("schema drift"),
    );
    const response = await syncRoutes.request(
      "/connectors/obank/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "OBANK_CONNECTION_FAILED" },
    });
  });
});
