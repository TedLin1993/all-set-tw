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
  manualSyncBody,
  manualSyncConnectorIds,
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

  for (const connectorId of manualSyncConnectorIds) {
    const path = `/connectors/${connectorId}/sync`;
    const body = manualSyncBody(connectorId);
    if (!body) {
      api.post(path, (c) => manualSyncResponse(c, connectorId));
      continue;
    }
    api.post(
      path,
      zValidator(
        "json",
        body.schema,
        validationHook("INVALID_REQUEST", body.invalidMessage),
      ),
      (c) => manualSyncResponse(c, connectorId, c.req.valid("json")),
    );
  }
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
