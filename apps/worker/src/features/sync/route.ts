import {
  EInvoiceProtocolUnavailableError,
  TdccConnectionError,
  TdccVerificationRequiredError,
} from "@taiwan-fin-hub/connectors";
import type { ConnectorId } from "@taiwan-fin-hub/core";
import { zValidator } from "@hono/zod-validator";
import { type Context, type Hono } from "hono";
import { z } from "zod";
import { SinopacBrowserCapacityError } from "../../connectors/sinopac";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
} from "../../connectors/taishin";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { startManualSyncJob } from "./manual-job";
import {
  NeedsUserActionError,
  prepareSinopacCaptchaSession,
  prepareTaishinCaptchaSession,
  safeErrorMessage,
  syncCathaybk,
  syncEinvoice,
  syncEsun,
  syncSinopac,
  syncTaishin,
  syncTdcc,
  SyncAlreadyRunningError,
  SYNC_SCOPE_ALL,
  TDCC_SCOPE_BANK,
  TDCC_SCOPE_INVESTMENTS,
  TDCC_SCOPE_TRADES,
  withManualSyncLock,
  type SyncOutcome,
  type SyncScope,
} from "./service";

const tdccSyncBodySchema = z.object({
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});
const einvoiceSyncBodySchema = z.object({ fetchDetails: z.boolean().optional() });
const sinopacSyncBodySchema = z.object({
  captcha: z.string().regex(/^\d{6}$/).optional(),
});
const taishinSyncBodySchema = z.object({
  captcha: z.string().regex(/^\d{4,8}$/).optional(),
});

export const syncRoutes = honoFactory.createApp();
registerSyncRoutes(syncRoutes);

function registerSyncRoutes(api: Hono<AppBindings>) {
  api.post(
    "/connectors/einvoice/sync",
    zValidator(
      "json",
      einvoiceSyncBodySchema,
      validationHook("INVALID_REQUEST", "E-Invoice sync options are invalid."),
    ),
    async (c) =>
      acceptManualSync(c, "einvoice", SYNC_SCOPE_ALL, () =>
        syncEinvoice(c.env, "manual", c.req.valid("json")),
      ),
  );

  registerTdccRoutes(api);

  api.post("/connectors/esun/sync", async (c) =>
    acceptManualSync(c, "esun", SYNC_SCOPE_ALL, () =>
      syncEsun(c.env, "manual"),
    ),
  );
  api.post("/connectors/cathaybk/sync", async (c) =>
    acceptManualSync(c, "cathaybk", SYNC_SCOPE_ALL, () =>
      syncCathaybk(c.env, "manual"),
    ),
  );

  api.post("/connectors/sinopac/captcha", (c) =>
    prepareCaptchaResponse(c, "sinopac"),
  );
  api.post(
    "/connectors/sinopac/sync",
    zValidator(
      "json",
      sinopacSyncBodySchema,
      validationHook("INVALID_REQUEST", "Sinopac sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncInteractiveOrBackground(
        c,
        "sinopac",
        Boolean(overrides.captcha),
        () => syncSinopac(c.env, "manual", overrides),
      );
    },
  );

  api.post("/connectors/taishin/captcha", (c) =>
    prepareCaptchaResponse(c, "taishin"),
  );
  api.post(
    "/connectors/taishin/sync",
    zValidator(
      "json",
      taishinSyncBodySchema,
      validationHook("INVALID_REQUEST", "Taishin sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncInteractiveOrBackground(
        c,
        "taishin",
        Boolean(overrides.captcha),
        () => syncTaishin(c.env, "manual", overrides),
      );
    },
  );
}

function registerTdccRoutes(api: Hono<AppBindings>) {
  const register = (
    path: string,
    scope: SyncScope,
    scopes: Array<
      | typeof TDCC_SCOPE_INVESTMENTS
      | typeof TDCC_SCOPE_BANK
      | typeof TDCC_SCOPE_TRADES
    >,
  ) =>
    api.post(
      path,
      zValidator(
        "json",
        tdccSyncBodySchema,
        validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
      ),
      async (c) => {
        const overrides = c.req.valid("json");
        return syncRouteResponse(
          c,
          withManualSyncLock(c.env, "tdcc", scope, () =>
            syncTdcc(c.env, "manual", overrides, scopes),
          ),
        );
      },
    );

  register("/connectors/tdcc/sync", SYNC_SCOPE_ALL, [
    TDCC_SCOPE_INVESTMENTS,
    TDCC_SCOPE_BANK,
    TDCC_SCOPE_TRADES,
  ]);
  register(
    "/connectors/tdcc/sync/investments",
    TDCC_SCOPE_INVESTMENTS,
    [TDCC_SCOPE_INVESTMENTS],
  );
  register("/connectors/tdcc/sync/bank", TDCC_SCOPE_BANK, [TDCC_SCOPE_BANK]);
  register("/connectors/tdcc/sync/trades", TDCC_SCOPE_TRADES, [
    TDCC_SCOPE_TRADES,
  ]);
}

async function prepareCaptchaResponse(
  c: Context<AppBindings>,
  connectorId: "sinopac" | "taishin",
) {
  try {
    return c.json(
      connectorId === "sinopac"
        ? await prepareSinopacCaptchaSession(c.env)
        : await prepareTaishinCaptchaSession(c.env),
    );
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return jsonError(
        "SYNC_ALREADY_RUNNING",
        `${connectorId === "sinopac" ? "永豐" : "台新"}已有驗證或同步作業正在進行。`,
        409,
      );
    }
    if (error instanceof SinopacBrowserCapacityError) {
      const response = jsonError("SINOPAC_BROWSER_BUSY", error.message, 429);
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof TaishinBrowserCapacityError) {
      const response = jsonError("TAISHIN_BROWSER_BUSY", error.message, 429);
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof NeedsUserActionError) {
      return jsonError("USER_ACTION_REQUIRED", error.message, 400);
    }
    return jsonError(
      connectorId === "sinopac"
        ? "SINOPAC_CAPTCHA_FAILED"
        : "TAISHIN_CONNECTION_FAILED",
      safeErrorMessage(error),
      502,
    );
  }
}

async function syncInteractiveOrBackground(
  c: Context<AppBindings>,
  connectorId: "sinopac" | "taishin",
  interactive: boolean,
  task: () => Promise<SyncOutcome>,
) {
  if (!interactive) {
    return acceptManualSync(c, connectorId, SYNC_SCOPE_ALL, task);
  }
  return syncRouteResponse(
    c,
    withManualSyncLock(c.env, connectorId, SYNC_SCOPE_ALL, task),
  );
}

async function acceptManualSync(
  c: Context<AppBindings>,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: () => Promise<SyncOutcome>,
) {
  try {
    const job = await startManualSyncJob(c.env, connectorId, scope, task);
    c.executionCtx.waitUntil(
      job.completion.catch((error) => {
        console.error(
          `[sync] ${connectorId}/${scope}: background job ${job.runId} failed`,
          error,
        );
      }),
    );
    return c.json(
      { accepted: true, connectorId, scope, runId: job.runId },
      202,
    );
  } catch (error) {
    return syncRouteErrorResponse(c, error);
  }
}

async function syncRouteResponse(
  c: Context<AppBindings>,
  result: Promise<SyncOutcome>,
) {
  try {
    return c.json(await result);
  } catch (error) {
    return syncRouteErrorResponse(c, error);
  }
}

function syncRouteErrorResponse(c: Context<AppBindings>, error: unknown) {
  if (error instanceof SyncAlreadyRunningError) {
    return jsonError("SYNC_ALREADY_RUNNING", error.message, 409);
  }
  if (error instanceof TdccVerificationRequiredError) {
    return jsonError(
      error.channel === "sms"
        ? "TDCC_SMS_OTP_REQUIRED"
        : "TDCC_EMAIL_OTP_REQUIRED",
      error.message,
      400,
    );
  }
  if (error instanceof TdccConnectionError) {
    return jsonError("TDCC_CONNECTION_FAILED", error.message, 400);
  }
  if (error instanceof NeedsUserActionError) {
    return jsonError("USER_ACTION_REQUIRED", error.message, 400);
  }
  if (error instanceof EInvoiceProtocolUnavailableError) {
    return jsonError("CONNECTOR_PROTOCOL_UNAVAILABLE", error.message, 503);
  }
  if (error instanceof SinopacBrowserCapacityError) {
    const response = jsonError("SINOPAC_BROWSER_BUSY", error.message, 429);
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof TaishinBrowserCapacityError) {
    const response = jsonError("TAISHIN_BROWSER_BUSY", error.message, 429);
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof TaishinConnectionError) {
    return jsonError("TAISHIN_CONNECTION_FAILED", error.message, 502);
  }
  throw error;
}
