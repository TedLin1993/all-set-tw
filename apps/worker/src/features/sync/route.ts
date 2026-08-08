import {
  CtbcConnectionError,
  EInvoiceProtocolUnavailableError,
  ObankConnectionError,
  ObankProtocolError,
  TdccConnectionError,
  TdccVerificationRequiredError,
} from "@taiwan-fin-hub/connectors";
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
import {
  NeedsUserActionError,
  safeErrorMessage,
  SyncAlreadyRunningError,
  SYNC_SCOPE_ALL,
  TDCC_SCOPE_BANK,
  TDCC_SCOPE_INVESTMENTS,
  TDCC_SCOPE_TRADES,
  withManualSyncLock,
  type SyncOutcome,
} from "./service";
import { prepareConnectorChallenge, runConnectorSync } from "./registry";

const tdccSyncBodySchema = z.object({
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});

const einvoiceSyncBodySchema = z.object({
  fetchDetails: z.boolean().optional(),
});

const sinopacSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

const taishinSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

const obankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
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
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "einvoice", SYNC_SCOPE_ALL, () =>
          runConnectorSync(
            c.env,
            "einvoice",
            "manual",
            SYNC_SCOPE_ALL,
            overrides,
          ),
        ),
      );
    },
  );

  api.post(
    "/connectors/tdcc/sync",
    zValidator(
      "json",
      tdccSyncBodySchema,
      validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "tdcc", SYNC_SCOPE_ALL, () =>
          runConnectorSync(c.env, "tdcc", "manual", SYNC_SCOPE_ALL, overrides),
        ),
      );
    },
  );

  api.post(
    "/connectors/tdcc/sync/investments",
    zValidator(
      "json",
      tdccSyncBodySchema,
      validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "tdcc", TDCC_SCOPE_INVESTMENTS, () =>
          runConnectorSync(
            c.env,
            "tdcc",
            "manual",
            TDCC_SCOPE_INVESTMENTS,
            overrides,
          ),
        ),
      );
    },
  );

  api.post(
    "/connectors/tdcc/sync/bank",
    zValidator(
      "json",
      tdccSyncBodySchema,
      validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "tdcc", TDCC_SCOPE_BANK, () =>
          runConnectorSync(c.env, "tdcc", "manual", TDCC_SCOPE_BANK, overrides),
        ),
      );
    },
  );

  api.post(
    "/connectors/tdcc/sync/trades",
    zValidator(
      "json",
      tdccSyncBodySchema,
      validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "tdcc", TDCC_SCOPE_TRADES, () =>
          runConnectorSync(
            c.env,
            "tdcc",
            "manual",
            TDCC_SCOPE_TRADES,
            overrides,
          ),
        ),
      );
    },
  );

  api.post("/connectors/esun/sync", async (c) => {
    return syncRouteResponse(
      c,
      withManualSyncLock(c.env, "esun", SYNC_SCOPE_ALL, () =>
        runConnectorSync(c.env, "esun", "manual"),
      ),
    );
  });

  api.post("/connectors/cathaybk/sync", async (c) => {
    return syncRouteResponse(
      c,
      withManualSyncLock(c.env, "cathaybk", SYNC_SCOPE_ALL, () =>
        runConnectorSync(c.env, "cathaybk", "manual"),
      ),
    );
  });

  api.post("/connectors/ctbc/sync", async (c) => {
    return syncRouteResponse(
      c,
      withManualSyncLock(c.env, "ctbc", SYNC_SCOPE_ALL, () =>
        runConnectorSync(c.env, "ctbc", "manual"),
      ),
    );
  });

  api.post("/connectors/sinopac/captcha", async (c) => {
    try {
      return c.json(await prepareConnectorChallenge(c.env, "sinopac"));
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError(
          "SYNC_ALREADY_RUNNING",
          "永豐已有驗證或同步作業正在進行。",
          409,
        );
      }
      if (error instanceof SinopacBrowserCapacityError) {
        const response = jsonError("SINOPAC_BROWSER_BUSY", error.message, 429);
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
        return response;
      }
      if (error instanceof NeedsUserActionError) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      return jsonError("SINOPAC_CAPTCHA_FAILED", safeErrorMessage(error), 502);
    }
  });

  api.post(
    "/connectors/sinopac/sync",
    zValidator(
      "json",
      sinopacSyncBodySchema,
      validationHook("INVALID_REQUEST", "Sinopac sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "sinopac", SYNC_SCOPE_ALL, () =>
          runConnectorSync(
            c.env,
            "sinopac",
            "manual",
            SYNC_SCOPE_ALL,
            overrides,
          ),
        ),
      );
    },
  );

  api.post("/connectors/taishin/captcha", async (c) => {
    try {
      return c.json(await prepareConnectorChallenge(c.env, "taishin"));
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError(
          "SYNC_ALREADY_RUNNING",
          "台新已有驗證或同步作業正在進行。",
          409,
        );
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
        "TAISHIN_CONNECTION_FAILED",
        safeErrorMessage(error),
        502,
      );
    }
  });

  api.post(
    "/connectors/taishin/sync",
    zValidator(
      "json",
      taishinSyncBodySchema,
      validationHook("INVALID_REQUEST", "Taishin sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "taishin", SYNC_SCOPE_ALL, () =>
          runConnectorSync(
            c.env,
            "taishin",
            "manual",
            SYNC_SCOPE_ALL,
            overrides,
          ),
        ),
      );
    },
  );

  api.post("/connectors/obank/captcha", async (c) => {
    try {
      return c.json(await prepareConnectorChallenge(c.env, "obank"));
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError(
          "SYNC_ALREADY_RUNNING",
          "王道銀行已有驗證或同步作業正在進行。",
          409,
        );
      }
      if (error instanceof NeedsUserActionError) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      if (
        error instanceof ObankConnectionError ||
        error instanceof ObankProtocolError
      ) {
        return jsonError("OBANK_CONNECTION_FAILED", error.message, 502);
      }
      return jsonError("OBANK_CAPTCHA_FAILED", safeErrorMessage(error), 502);
    }
  });

  api.post(
    "/connectors/obank/sync",
    zValidator(
      "json",
      obankSyncBodySchema,
      validationHook("INVALID_REQUEST", "O-Bank sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "obank", SYNC_SCOPE_ALL, () =>
          runConnectorSync(c.env, "obank", "manual", SYNC_SCOPE_ALL, overrides),
        ),
      );
    },
  );
}

async function syncRouteResponse(
  c: Context<AppBindings>,
  result: Promise<SyncOutcome>,
) {
  try {
    return c.json(await result);
  } catch (error) {
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
    if (error instanceof CtbcConnectionError) {
      return jsonError("CTBC_CONNECTION_FAILED", error.message, 502);
    }
    if (error instanceof TaishinConnectionError) {
      return jsonError("TAISHIN_CONNECTION_FAILED", error.message, 502);
    }
    if (
      error instanceof ObankConnectionError ||
      error instanceof ObankProtocolError
    ) {
      return jsonError("OBANK_CONNECTION_FAILED", error.message, 502);
    }
    throw error;
  }
}
