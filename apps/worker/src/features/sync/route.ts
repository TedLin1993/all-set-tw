import {
  CtbcConnectionError,
  EInvoiceProtocolUnavailableError,
  ObankConnectionError,
  ObankProtocolError,
  SkbankConnectionError,
  SkbankProtocolError,
  TdccConnectionError,
  TdccVerificationRequiredError,
} from "@taiwan-fin-hub/connectors";
import { zValidator } from "@hono/zod-validator";
import { type Context, type Hono } from "hono";
import { z } from "zod";
import {
  FirstbankBrowserCapacityError,
  FirstbankConnectionError,
  FirstbankVerificationRequiredError,
} from "../../connectors/firstbank";
import {
  HncbBrowserCapacityError,
  HncbConnectionError,
  HncbVerificationRequiredError,
} from "../../connectors/hncb";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
  CathayVerificationRequiredError,
} from "../../connectors/cathaybk";
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
import { cancelQueuedTdccSyncRun, startTdccSyncRun } from "./tdcc-sync-service";
import { enqueueTdccSyncChunk } from "./scheduler-queue";
import type { TdccRunScope } from "./tdcc-run-repository";

const tdccSyncBodySchema = z.object({
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
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

const hncbSyncBodySchema = z.object({
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

const firstbankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4,8}$/)
    .optional(),
});

const cathaySyncBodySchema = z.object({
  otp: z.string().min(1).optional(),
  otpChannel: z.enum(["email", "sms"]).optional(),
});

export const syncRoutes = honoFactory.createApp();
registerSyncRoutes(syncRoutes);

function registerSyncRoutes(api: Hono<AppBindings>) {
  api.post("/connectors/einvoice/sync", async (c) => {
    try {
      const { cancelQueuedEinvoiceSyncRun, startEinvoiceSyncRun } =
        await import("./einvoice-sync-service");
      const { enqueueEinvoiceSyncChunk } = await import("./scheduler-queue");
      const { run, created } = await startEinvoiceSyncRun(c.env, {
        trigger: "manual",
      });
      if (created) {
        try {
          await enqueueEinvoiceSyncChunk(c.env, run.id);
        } catch (error) {
          await cancelQueuedEinvoiceSyncRun(c.env, run.id, error);
          throw error;
        }
      }
      return c.json(
        {
          success: true as const,
          connectorId: "einvoice" as const,
          scope: SYNC_SCOPE_ALL,
          status: "queued" as const,
          runId: run.id,
        },
        202,
      );
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError("SYNC_ALREADY_RUNNING", error.message, 409);
      }
      if (error instanceof NeedsUserActionError) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      throw error;
    }
  });

  api.post(
    "/connectors/tdcc/sync",
    zValidator(
      "json",
      tdccSyncBodySchema,
      validationHook("INVALID_REQUEST", "TDCC sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return queuedTdccSyncResponse(c, "all", overrides);
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
      return queuedTdccSyncResponse(c, "investments", overrides);
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
      return queuedTdccSyncResponse(c, "bank", overrides);
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
      return queuedTdccSyncResponse(c, "trades", overrides);
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

  api.post(
    "/connectors/cathaybk/sync",
    zValidator(
      "json",
      cathaySyncBodySchema,
      validationHook("INVALID_REQUEST", "Cathay sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "cathaybk", SYNC_SCOPE_ALL, () =>
          runConnectorSync(
            c.env,
            "cathaybk",
            "manual",
            SYNC_SCOPE_ALL,
            overrides,
          ),
        ),
      );
    },
  );

  api.post("/connectors/ctbc/sync", async (c) => {
    return syncRouteResponse(
      c,
      withManualSyncLock(c.env, "ctbc", SYNC_SCOPE_ALL, () =>
        runConnectorSync(c.env, "ctbc", "manual"),
      ),
    );
  });

  api.post("/connectors/skbank/sync", async (c) => {
    return syncRouteResponse(
      c,
      withManualSyncLock(c.env, "skbank", SYNC_SCOPE_ALL, () =>
        runConnectorSync(c.env, "skbank", "manual"),
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

  api.post("/connectors/hncb/captcha", async (c) => {
    try {
      return c.json(await prepareConnectorChallenge(c.env, "hncb"));
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError(
          "SYNC_ALREADY_RUNNING",
          "華南銀行已有驗證或同步作業正在進行。",
          409,
        );
      }
      if (error instanceof HncbBrowserCapacityError) {
        const response = jsonError("HNCB_BROWSER_BUSY", error.message, 429);
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
        return response;
      }
      if (error instanceof HncbConnectionError) {
        return jsonError("HNCB_CAPTCHA_FAILED", safeErrorMessage(error), 502);
      }
      if (
        error instanceof NeedsUserActionError ||
        error instanceof HncbVerificationRequiredError
      ) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      return jsonError("HNCB_CAPTCHA_FAILED", safeErrorMessage(error), 502);
    }
  });

  api.post(
    "/connectors/hncb/sync",
    zValidator(
      "json",
      hncbSyncBodySchema,
      validationHook("INVALID_REQUEST", "HNCB sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "hncb", SYNC_SCOPE_ALL, () =>
          runConnectorSync(c.env, "hncb", "manual", SYNC_SCOPE_ALL, overrides),
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

  api.post("/connectors/firstbank/captcha", async (c) => {
    try {
      return c.json(await prepareConnectorChallenge(c.env, "firstbank"));
    } catch (error) {
      if (error instanceof SyncAlreadyRunningError) {
        return jsonError(
          "SYNC_ALREADY_RUNNING",
          "第一銀行已有驗證或同步作業正在進行。",
          409,
        );
      }
      if (error instanceof NeedsUserActionError) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      if (error instanceof FirstbankBrowserCapacityError) {
        const response = jsonError(
          "FIRSTBANK_BROWSER_BUSY",
          error.message,
          429,
        );
        response.headers.set("Retry-After", String(error.retryAfterSeconds));
        return response;
      }
      if (error instanceof FirstbankConnectionError) {
        return jsonError("FIRSTBANK_CONNECTION_FAILED", error.message, 502);
      }
      if (error instanceof FirstbankVerificationRequiredError) {
        return jsonError("USER_ACTION_REQUIRED", error.message, 400);
      }
      return jsonError(
        "FIRSTBANK_CAPTCHA_FAILED",
        safeErrorMessage(error),
        502,
      );
    }
  });

  api.post(
    "/connectors/firstbank/sync",
    zValidator(
      "json",
      firstbankSyncBodySchema,
      validationHook("INVALID_REQUEST", "第一銀行 sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return syncRouteResponse(
        c,
        withManualSyncLock(c.env, "firstbank", SYNC_SCOPE_ALL, () =>
          runConnectorSync(
            c.env,
            "firstbank",
            "manual",
            SYNC_SCOPE_ALL,
            overrides,
          ),
        ),
      );
    },
  );
}

async function queuedTdccSyncResponse(
  c: Context<AppBindings>,
  scope: TdccRunScope,
  overrides: Record<string, unknown>,
) {
  try {
    const { run, created } = await startTdccSyncRun(c.env, {
      trigger: "manual",
      scope,
      overrides,
    });
    try {
      await enqueueTdccSyncChunk(c.env, run.id);
    } catch (error) {
      if (created) {
        await cancelQueuedTdccSyncRun(c.env, run.id, error);
      }
      throw error;
    }
    return c.json(
      {
        success: true as const,
        connectorId: "tdcc" as const,
        scope,
        status: "queued" as const,
        runId: run.id,
      },
      202,
    );
  } catch (error) {
    return syncRouteResponse(c, Promise.reject(error) as Promise<SyncOutcome>);
  }
}

async function syncRouteResponse(
  c: Context<AppBindings>,
  result: Promise<SyncOutcome>,
) {
  try {
    return c.json(await result);
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      return jsonError("SYNC_ALREADY_RUNNING", safeErrorMessage(error), 409);
    }
    if (error instanceof CathayOtpChannelRequiredError) {
      return jsonError(
        "CATHAY_OTP_CHANNEL_REQUIRED",
        safeErrorMessage(error),
        400,
      );
    }
    if (error instanceof CathayOtpRequiredError) {
      return jsonError(
        error.channel === "sms"
          ? "CATHAY_SMS_OTP_REQUIRED"
          : "CATHAY_EMAIL_OTP_REQUIRED",
        safeErrorMessage(error),
        400,
      );
    }
    if (error instanceof CathayOtpSessionExpiredError) {
      return jsonError(
        "CATHAY_OTP_SESSION_EXPIRED",
        safeErrorMessage(error),
        400,
      );
    }
    if (error instanceof CathayOtpInvalidError) {
      return jsonError("CATHAY_OTP_INVALID", safeErrorMessage(error), 400);
    }
    if (error instanceof CathayVerificationRequiredError) {
      return jsonError("USER_ACTION_REQUIRED", safeErrorMessage(error), 400);
    }
    if (error instanceof TdccVerificationRequiredError) {
      return jsonError(
        error.channel === "sms"
          ? "TDCC_SMS_OTP_REQUIRED"
          : "TDCC_EMAIL_OTP_REQUIRED",
        safeErrorMessage(error),
        400,
      );
    }
    if (error instanceof TdccConnectionError) {
      return jsonError("TDCC_CONNECTION_FAILED", safeErrorMessage(error), 400);
    }
    if (error instanceof NeedsUserActionError) {
      return jsonError("USER_ACTION_REQUIRED", safeErrorMessage(error), 400);
    }
    if (error instanceof EInvoiceProtocolUnavailableError) {
      return jsonError(
        "CONNECTOR_PROTOCOL_UNAVAILABLE",
        safeErrorMessage(error),
        503,
      );
    }
    if (error instanceof SinopacBrowserCapacityError) {
      const response = jsonError(
        "SINOPAC_BROWSER_BUSY",
        safeErrorMessage(error),
        429,
      );
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof TaishinBrowserCapacityError) {
      const response = jsonError(
        "TAISHIN_BROWSER_BUSY",
        safeErrorMessage(error),
        429,
      );
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof CtbcConnectionError) {
      return jsonError("CTBC_CONNECTION_FAILED", safeErrorMessage(error), 502);
    }
    if (
      error instanceof SkbankConnectionError ||
      error instanceof SkbankProtocolError
    ) {
      return jsonError(
        "SKBANK_CONNECTION_FAILED",
        safeErrorMessage(error),
        502,
      );
    }
    if (error instanceof TaishinConnectionError) {
      return jsonError(
        "TAISHIN_CONNECTION_FAILED",
        safeErrorMessage(error),
        502,
      );
    }
    if (error instanceof HncbBrowserCapacityError) {
      const response = jsonError(
        "HNCB_BROWSER_BUSY",
        safeErrorMessage(error),
        429,
      );
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof HncbConnectionError) {
      return jsonError("HNCB_CONNECTION_FAILED", safeErrorMessage(error), 502);
    }
    if (
      error instanceof ObankConnectionError ||
      error instanceof ObankProtocolError
    ) {
      return jsonError("OBANK_CONNECTION_FAILED", safeErrorMessage(error), 502);
    }
    if (error instanceof FirstbankBrowserCapacityError) {
      const response = jsonError("FIRSTBANK_BROWSER_BUSY", error.message, 429);
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
      return response;
    }
    if (error instanceof FirstbankConnectionError) {
      return jsonError(
        "FIRSTBANK_CONNECTION_FAILED",
        safeErrorMessage(error),
        502,
      );
    }
    return jsonError("SYNC_FAILED", safeErrorMessage(error), 500);
  }
}
