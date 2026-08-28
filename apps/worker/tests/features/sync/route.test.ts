import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CtbcConnectionError,
  ObankConnectionError,
  SkbankConnectionError,
} from "@taiwan-fin-hub/connectors";
import {
  FirstbankBrowserCapacityError,
  FirstbankConnectionError,
} from "../../../src/connectors/firstbank";
import {
  HncbBrowserCapacityError,
  HncbConnectionError,
} from "../../../src/connectors/hncb";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
} from "../../../src/connectors/cathaybk";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
} from "../../../src/connectors/taishin";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({
  cancelQueuedEinvoiceSyncRun: vi.fn(),
  cancelQueuedTdccSyncRun: vi.fn(),
  enqueueEinvoiceSyncChunk: vi.fn(),
  enqueueTdccSyncChunk: vi.fn(),
  prepareTaishinCaptchaSession: vi.fn(),
  prepareHncbCaptchaSession: vi.fn(),
  prepareObankCaptchaSession: vi.fn(),
  prepareFirstbankCaptchaSession: vi.fn(),
  startEinvoiceSyncRun: vi.fn(),
  startTdccSyncRun: vi.fn(),
  syncCtbc: vi.fn(),
  syncCathaybk: vi.fn(),
  syncEsun: vi.fn(),
  syncObank: vi.fn(),
  syncFirstbank: vi.fn(),
  syncHncb: vi.fn(),
  syncTaishin: vi.fn(),
  syncSkbank: vi.fn(),
}));

vi.mock("../../../src/features/sync/einvoice-sync-service", () => ({
  cancelQueuedEinvoiceSyncRun: mocks.cancelQueuedEinvoiceSyncRun,
  startEinvoiceSyncRun: mocks.startEinvoiceSyncRun,
}));

vi.mock("../../../src/features/sync/tdcc-sync-service", () => ({
  cancelQueuedTdccSyncRun: mocks.cancelQueuedTdccSyncRun,
  startTdccSyncRun: mocks.startTdccSyncRun,
}));

vi.mock("../../../src/features/sync/scheduler-queue", () => ({
  enqueueEinvoiceSyncChunk: mocks.enqueueEinvoiceSyncChunk,
  enqueueTdccSyncChunk: mocks.enqueueTdccSyncChunk,
}));

vi.mock("../../../src/features/sync/service", () => ({
  NeedsUserActionError: class NeedsUserActionError extends Error {},
  prepareSinopacCaptchaSession: vi.fn(),
  prepareHncbCaptchaSession: mocks.prepareHncbCaptchaSession,
  prepareTaishinCaptchaSession: mocks.prepareTaishinCaptchaSession,
  prepareObankCaptchaSession: mocks.prepareObankCaptchaSession,
  prepareFirstbankCaptchaSession: mocks.prepareFirstbankCaptchaSession,
  safeErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  syncCathaybk: mocks.syncCathaybk,
  syncCtbc: mocks.syncCtbc,
  syncEinvoice: vi.fn(),
  syncEsun: mocks.syncEsun,
  syncSinopac: vi.fn(),
  syncObank: mocks.syncObank,
  syncFirstbank: mocks.syncFirstbank,
  syncHncb: mocks.syncHncb,
  syncTaishin: mocks.syncTaishin,
  syncSkbank: mocks.syncSkbank,
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
  mocks.startEinvoiceSyncRun.mockResolvedValue({
    run: { id: "einvoice-run-1" },
    created: true,
  });
  mocks.enqueueEinvoiceSyncChunk.mockResolvedValue(undefined);
  mocks.cancelQueuedEinvoiceSyncRun.mockResolvedValue(undefined);
  mocks.startTdccSyncRun.mockResolvedValue({
    run: { id: "tdcc-run-1" },
    created: true,
  });
  mocks.enqueueTdccSyncChunk.mockResolvedValue(undefined);
  mocks.cancelQueuedTdccSyncRun.mockResolvedValue(undefined);
  mocks.prepareTaishinCaptchaSession.mockResolvedValue({
    captchaImage: "data:image/jpeg;base64,AQID",
    expiresAt: "2026-07-23T12:02:00.000Z",
    digitCount: 6,
  });
  mocks.prepareHncbCaptchaSession.mockResolvedValue({
    captchaImage: "data:image/jpeg;base64,AQID",
    expiresAt: "2026-08-19T08:02:00.000Z",
    digitCount: 4,
    captchaKind: "numeric",
  });
  mocks.syncHncb.mockResolvedValue({
    success: true,
    connectorId: "hncb",
    scope: "all",
    records: 3,
    newRecords: {
      invoices: 0,
      bankTransactions: 3,
      investmentTransactions: 0,
    },
    cursorUpdated: true,
  });
  mocks.syncTaishin.mockResolvedValue({
    success: true,
    connectorId: "taishin",
    scope: "all",
    records: 3,
    newRecords: {
      invoices: 0,
      bankTransactions: 3,
      investmentTransactions: 0,
    },
    cursorUpdated: true,
  });
  mocks.syncCtbc.mockResolvedValue({
    success: true,
    connectorId: "ctbc",
    scope: "all",
    records: 4,
    newRecords: {
      invoices: 0,
      bankTransactions: 4,
      investmentTransactions: 0,
    },
    cursorUpdated: true,
  });
  mocks.syncEsun.mockResolvedValue({
    success: true,
    connectorId: "esun",
    scope: "all",
    records: 4,
    newRecords: {
      invoices: 0,
      bankTransactions: 4,
      investmentTransactions: 0,
    },
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
    newRecords: {
      invoices: 0,
      bankTransactions: 3,
      investmentTransactions: 0,
    },
    cursorUpdated: true,
  });
  mocks.prepareFirstbankCaptchaSession.mockResolvedValue({
    captchaImage: "data:image/jpeg;base64,AQID",
    expiresAt: "2026-08-25T12:02:00.000Z",
    captchaLength: 4,
    captchaKind: "alphanumeric",
  });
  mocks.syncFirstbank.mockResolvedValue({
    success: true,
    connectorId: "firstbank",
    scope: "all",
    records: 2,
    newRecords: {
      invoices: 0,
      bankTransactions: 0,
      investmentTransactions: 0,
    },
    cursorUpdated: true,
  });
});

describe("e-invoice sync route", () => {
  it("queues a newly-created manual durable run and returns its run ID", async () => {
    const response = await syncRoutes.request(
      "/connectors/einvoice/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      connectorId: "einvoice",
      scope: "all",
      status: "queued",
      runId: "einvoice-run-1",
    });
    expect(mocks.startEinvoiceSyncRun).toHaveBeenCalledWith(env, {
      trigger: "manual",
    });
    expect(mocks.enqueueEinvoiceSyncChunk).toHaveBeenCalledWith(
      env,
      "einvoice-run-1",
    );
  });

  it("returns a reused run without enqueueing it again", async () => {
    mocks.startEinvoiceSyncRun.mockResolvedValueOnce({
      run: { id: "einvoice-running" },
      created: false,
    });

    const response = await syncRoutes.request(
      "/connectors/einvoice/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      runId: "einvoice-running",
    });
    expect(mocks.enqueueEinvoiceSyncChunk).not.toHaveBeenCalled();
    expect(mocks.cancelQueuedEinvoiceSyncRun).not.toHaveBeenCalled();
  });

  it("cancels only its newly-created run when Queue enqueueing fails", async () => {
    const error = new Error("Queue unavailable");
    mocks.enqueueEinvoiceSyncChunk.mockRejectedValueOnce(error);

    const response = await syncRoutes.request(
      "/connectors/einvoice/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(500);
    expect(mocks.cancelQueuedEinvoiceSyncRun).toHaveBeenCalledWith(
      env,
      "einvoice-run-1",
      error,
    );
  });
});

describe("TDCC sync route", () => {
  it("queues a newly-created manual durable run", async () => {
    const response = await syncRoutes.request(
      "/connectors/tdcc/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      connectorId: "tdcc",
      scope: "all",
      status: "queued",
      runId: "tdcc-run-1",
    });
    expect(mocks.enqueueTdccSyncChunk).toHaveBeenCalledWith(env, "tdcc-run-1");
  });

  it("requeues a reused active run so an orphaned Queue chain can resume", async () => {
    mocks.startTdccSyncRun.mockResolvedValueOnce({
      run: { id: "tdcc-running" },
      created: false,
    });

    const response = await syncRoutes.request(
      "/connectors/tdcc/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );

    expect(response.status).toBe(202);
    expect(mocks.enqueueTdccSyncChunk).toHaveBeenCalledWith(
      env,
      "tdcc-running",
    );
    expect(mocks.cancelQueuedTdccSyncRun).not.toHaveBeenCalled();
  });

  it("does not fail a reused run when its recovery enqueue fails", async () => {
    mocks.startTdccSyncRun.mockResolvedValueOnce({
      run: { id: "tdcc-running" },
      created: false,
    });
    mocks.enqueueTdccSyncChunk.mockRejectedValueOnce(
      new Error("Queue unavailable"),
    );

    const response = await syncRoutes.request(
      "/connectors/tdcc/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );

    expect(response.status).toBe(500);
    expect(mocks.cancelQueuedTdccSyncRun).not.toHaveBeenCalled();
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

describe("SKBank sync route", () => {
  it("dispatches a manual sync", async () => {
    const response = await syncRoutes.request(
      "/connectors/skbank/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.syncSkbank).toHaveBeenCalledWith(env, "manual");
  });

  it("maps App API connection failures", async () => {
    mocks.syncSkbank.mockRejectedValueOnce(new SkbankConnectionError());
    const response = await syncRoutes.request(
      "/connectors/skbank/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SKBANK_CONNECTION_FAILED" },
    });
  });
});

describe("E.SUN sync route", () => {
  it("returns the same safe error message persisted by the sync service", async () => {
    mocks.syncEsun.mockRejectedValueOnce(
      new Error(
        "E.SUN browser login: duplicate-login dialog kept reappearing.",
      ),
    );

    const response = await syncRoutes.request(
      "/connectors/esun/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SYNC_FAILED",
        message:
          "E.SUN browser login: duplicate-login dialog kept reappearing.",
      },
    });
  });
});

describe("Cathay sync routes", () => {
  it("dispatches a manual sync without OTP overrides", async () => {
    const response = await syncRoutes.request(
      "/connectors/cathaybk/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.syncCathaybk).toHaveBeenCalledWith(env, "manual", {});
  });

  it("passes the selected OTP channel and code to the sync service", async () => {
    const response = await syncRoutes.request(
      "/connectors/cathaybk/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otpChannel: "email", otp: "123456" }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.syncCathaybk).toHaveBeenCalledWith(env, "manual", {
      otpChannel: "email",
      otp: "123456",
    });
  });

  it("rejects a malformed OTP channel before dispatch", async () => {
    const response = await syncRoutes.request(
      "/connectors/cathaybk/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otpChannel: "push" }),
      },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(mocks.syncCathaybk).not.toHaveBeenCalled();
  });

  it.each([
    [
      new CathayOtpChannelRequiredError(
        "請選擇驗證方式。",
        "pending-session",
        "2026-08-22T12:00:00.000Z",
      ),
      "CATHAY_OTP_CHANNEL_REQUIRED",
    ],
    [
      new CathayOtpRequiredError("Email 驗證碼已寄出。", "email"),
      "CATHAY_EMAIL_OTP_REQUIRED",
    ],
    [
      new CathayOtpRequiredError("簡訊驗證碼已寄出。", "sms"),
      "CATHAY_SMS_OTP_REQUIRED",
    ],
    [new CathayOtpSessionExpiredError(), "CATHAY_OTP_SESSION_EXPIRED"],
    [new CathayOtpInvalidError(), "CATHAY_OTP_INVALID"],
  ])("maps %s to %s", async (error, code) => {
    mocks.syncCathaybk.mockRejectedValueOnce(error);
    const response = await syncRoutes.request(
      "/connectors/cathaybk/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code },
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

describe("HNCB sync routes", () => {
  it("returns the manual CAPTCHA metadata", async () => {
    const response = await syncRoutes.request(
      "/connectors/hncb/captcha",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      digitCount: 4,
      captchaKind: "numeric",
      captchaImage: "data:image/jpeg;base64,AQID",
    });
  });

  it("accepts four numeric digits and rejects malformed input", async () => {
    const valid = await syncRoutes.request(
      "/connectors/hncb/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "1234" }),
      },
      env,
    );
    expect(valid.status).toBe(200);
    expect(mocks.syncHncb).toHaveBeenCalledWith(env, "manual", {
      captcha: "1234",
    });

    const invalid = await syncRoutes.request(
      "/connectors/hncb/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "12AB" }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
    expect(mocks.syncHncb).toHaveBeenCalledTimes(1);
  });

  it("maps Browser Rendering capacity and connection failures", async () => {
    mocks.prepareHncbCaptchaSession.mockRejectedValueOnce(
      new HncbBrowserCapacityError("browser busy", 17),
    );
    const busy = await syncRoutes.request(
      "/connectors/hncb/captcha",
      { method: "POST" },
      env,
    );
    expect(busy.status).toBe(429);
    expect(busy.headers.get("Retry-After")).toBe("17");
    await expect(busy.json()).resolves.toMatchObject({
      error: { code: "HNCB_BROWSER_BUSY" },
    });

    mocks.syncHncb.mockRejectedValueOnce(
      new HncbConnectionError("schema drift"),
    );
    const failed = await syncRoutes.request(
      "/connectors/hncb/sync",
      { method: "POST" },
      env,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "HNCB_CONNECTION_FAILED" },
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

describe("First Bank web sync routes", () => {
  it("returns alphanumeric CAPTCHA metadata", async () => {
    const response = await syncRoutes.request(
      "/connectors/firstbank/captcha",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      captchaLength: 4,
      captchaKind: "alphanumeric",
      captchaImage: "data:image/jpeg;base64,AQID",
    });
  });

  it("maps browser capacity while preparing CAPTCHA", async () => {
    mocks.prepareFirstbankCaptchaSession.mockRejectedValueOnce(
      new FirstbankBrowserCapacityError("browser busy", 17),
    );
    const response = await syncRoutes.request(
      "/connectors/firstbank/captcha",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FIRSTBANK_BROWSER_BUSY" },
    });
  });

  it("accepts four to eight alphanumeric characters and rejects malformed input", async () => {
    const valid = await syncRoutes.request(
      "/connectors/firstbank/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "XVSH" }),
      },
      env,
    );
    expect(valid.status).toBe(200);
    expect(mocks.syncFirstbank).toHaveBeenCalledWith(env, "manual", {
      captcha: "XVSH",
    });

    const invalid = await syncRoutes.request(
      "/connectors/firstbank/sync",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captcha: "A1-_" }),
      },
      env,
    );
    expect(invalid.status).toBe(400);
  });

  it("maps web connection failures", async () => {
    mocks.syncFirstbank.mockRejectedValueOnce(
      new FirstbankConnectionError("schema drift"),
    );
    const response = await syncRoutes.request(
      "/connectors/firstbank/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FIRSTBANK_CONNECTION_FAILED" },
    });
  });

  it("maps browser capacity during sync", async () => {
    mocks.syncFirstbank.mockRejectedValueOnce(
      new FirstbankBrowserCapacityError("browser busy", 9),
    );
    const response = await syncRoutes.request(
      "/connectors/firstbank/sync",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FIRSTBANK_BROWSER_BUSY" },
    });
  });
});
