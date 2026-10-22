import { zValidator } from "@hono/zod-validator";
import { type Context, type Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { NeedsUserActionError, SyncAlreadyRunningError } from "./errors";
import { classifySyncError, type ClassifiedSyncError } from "./error-response";
import { SYNC_SCOPE_ALL, type SyncOutcome } from "./types";
import {
  cancelQueuedManualSync,
  startQueuedManualSync,
  withManualSyncLock,
} from "./manual-sync";
import {
  challengeConnectorIds,
  challengeFailureCode,
  prepareConnectorChallenge,
  runConnectorSync,
} from "./registry";
import {
  cancelQueuedTdccSyncRun,
  startTdccSyncRun,
} from "../../sources/tdcc/sync";
import { enqueueManualSyncRun, enqueueTdccSyncChunk } from "./scheduling/queue";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";
import type { TdccRunScope } from "../../sources/tdcc/run-repository";

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

const rakutenSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^[A-Za-z0-9]{4}$/)
    .optional(),
});

const kgibankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
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

const ctbcSyncBodySchema = z
  .object({
    verification: z.enum(["check", "email", "restart"]).optional(),
    otp: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
  })
  .refine((value) => !(value.verification && value.otp));

const megabankSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  otp: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
});

const fubonSyncBodySchema = z
  .object({
    captcha: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    otp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .refine((value) => !(value.captcha && value.otp));

const feibSyncBodySchema = z.object({
  captcha: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const syncRoutes = honoFactory.createApp();
registerSyncRoutes(syncRoutes);

function registerSyncRoutes(api: Hono<AppBindings>) {
  for (const connectorId of challengeConnectorIds) {
    api.post(`/connectors/${connectorId}/captcha`, (c) =>
      challengeRouteResponse(c, connectorId),
    );
  }

  api.post("/connectors/einvoice/sync", async (c) => {
    try {
      const { cancelQueuedEinvoiceSyncRun, startEinvoiceSyncRun } =
        await import("../../sources/einvoice/sync");
      const { enqueueEinvoiceSyncChunk } = await import("./scheduling/queue");
      const { run, created } = await startEinvoiceSyncRun(c.env, {
        trigger: "manual",
      });
      try {
        await enqueueEinvoiceSyncChunk(c.env, run.id);
      } catch (error) {
        if (created) await cancelQueuedEinvoiceSyncRun(c.env, run.id, error);
        throw error;
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
    return manualSyncResponse(c, "esun");
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
      return manualSyncResponse(c, "cathaybk", overrides);
    },
  );

  api.post(
    "/connectors/ctbc/sync",
    zValidator(
      "json",
      ctbcSyncBodySchema,
      validationHook("INVALID_REQUEST", "中國信託驗證選項格式錯誤。"),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "ctbc", overrides);
    },
  );

  api.post("/connectors/skbank/sync", async (c) => {
    return manualSyncResponse(c, "skbank");
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
      return manualSyncResponse(c, "sinopac", overrides);
    },
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
      return manualSyncResponse(c, "taishin", overrides);
    },
  );

  api.post(
    "/connectors/hncb/sync",
    zValidator(
      "json",
      hncbSyncBodySchema,
      validationHook("INVALID_REQUEST", "HNCB sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "hncb", overrides);
    },
  );

  api.post(
    "/connectors/rakuten/sync",
    zValidator(
      "json",
      rakutenSyncBodySchema,
      validationHook("INVALID_REQUEST", "Rakuten sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "rakuten", overrides);
    },
  );

  api.post(
    "/connectors/kgibank/sync",
    zValidator(
      "json",
      kgibankSyncBodySchema,
      validationHook("INVALID_REQUEST", "KGI Bank sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "kgibank", overrides);
    },
  );

  api.post(
    "/connectors/nextbank/sync",
    zValidator(
      "json",
      z.object({
        captcha: z
          .string()
          .regex(/^[A-Za-z0-9]{1,5}$/)
          .optional(),
      }),
      validationHook("INVALID_REQUEST", "將來銀行驗證碼格式不符。"),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "nextbank", overrides);
    },
  );

  api.post(
    "/connectors/obank/sync",
    zValidator(
      "json",
      obankSyncBodySchema,
      validationHook("INVALID_REQUEST", "O-Bank sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "obank", overrides);
    },
  );

  api.post(
    "/connectors/firstbank/sync",
    zValidator(
      "json",
      firstbankSyncBodySchema,
      validationHook("INVALID_REQUEST", "第一銀行 sync options are invalid."),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "firstbank", overrides);
    },
  );

  api.post(
    "/connectors/megabank/sync",
    zValidator(
      "json",
      megabankSyncBodySchema,
      validationHook("INVALID_REQUEST", "兆豐銀行同步選項格式錯誤。"),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "megabank", overrides);
    },
  );

  api.post(
    "/connectors/fubon/sync",
    zValidator(
      "json",
      fubonSyncBodySchema,
      validationHook("INVALID_REQUEST", "台北富邦銀行同步選項格式錯誤。"),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "fubon", overrides);
    },
  );

  api.post(
    "/connectors/feib/sync",
    zValidator(
      "json",
      feibSyncBodySchema,
      validationHook("INVALID_REQUEST", "遠東商銀同步選項格式錯誤。"),
    ),
    async (c) => {
      const overrides = c.req.valid("json");
      return manualSyncResponse(c, "feib", overrides);
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

/**
 * 沒有使用者輸入的手動同步交給 Queue，前端離開或重新整理不影響同步；
 * 帶驗證碼／OTP 的接續請求必須接上同一個登入工作階段，仍在 request 內完成。
 */
function manualSyncResponse(
  c: Context<AppBindings>,
  connectorId: ConnectorId,
  overrides: Record<string, unknown> = {},
) {
  if (Object.values(overrides).every((value) => value === undefined))
    return queuedManualSyncResponse(c, connectorId);
  return syncRouteResponse(
    c,
    withManualSyncLock(c.env, connectorId, SYNC_SCOPE_ALL, (syncEnv) =>
      runConnectorSync(
        syncEnv,
        connectorId,
        "manual",
        SYNC_SCOPE_ALL,
        overrides,
      ),
    ),
  );
}

async function queuedManualSyncResponse(
  c: Context<AppBindings>,
  connectorId: ConnectorId,
) {
  try {
    const { run, created } = await startQueuedManualSync(c.env, connectorId);
    if (created) {
      try {
        await enqueueManualSyncRun(c.env, run.id);
      } catch (error) {
        await cancelQueuedManualSync(c.env, run.id, error);
        throw error;
      }
    }
    return c.json(
      {
        success: true as const,
        connectorId,
        scope: SYNC_SCOPE_ALL,
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
    return classifiedErrorResponse(classifySyncError(error));
  }
}

/**
 * 準備驗證碼的錯誤沿用同步錯誤分類；錯誤未宣告代碼時，
 * 回傳 registry 為該來源設定的驗證碼失敗代碼。
 */
async function challengeRouteResponse(
  c: Context<AppBindings>,
  connectorId: ConnectorId,
) {
  try {
    return c.json(await prepareConnectorChallenge(c.env, connectorId));
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError)
      return jsonError(
        "SYNC_ALREADY_RUNNING",
        `${connectorCatalog[connectorId].title}已有驗證或同步作業正在進行。`,
        409,
      );
    const classified = classifySyncError(error);
    return classifiedErrorResponse(
      classified.code === "SYNC_FAILED"
        ? {
            ...classified,
            status: 502,
            code: challengeFailureCode(connectorId),
          }
        : classified,
    );
  }
}

function classifiedErrorResponse({
  status,
  code,
  message,
  retryAfterSeconds,
}: ClassifiedSyncError) {
  const response = jsonError(code, message, status);
  if (retryAfterSeconds !== undefined)
    response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}
