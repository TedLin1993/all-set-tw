import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { CloudflareApiError } from "../../platform/cloudflare";
import { requireCsrf, requireSession } from "../../middleware/session";
import { AuthServiceError } from "../auth/service";
import {
  AccountNotAuthorizedError,
  WORKER_NAME_PATTERN,
  precheckSelectedAccount,
} from "./service";

export const precheckRoutes = honoFactory.createApp();
registerPrecheckRoutes(precheckRoutes);

function registerPrecheckRoutes(api: Hono<AppBindings>) {
  api.post(
    "/precheck",
    zValidator(
      "json",
      z.object({
        accountId: z.string().min(1).max(64),
        workerName: z.string().regex(WORKER_NAME_PATTERN),
      }),
      validationHook("INVALID_REQUEST", "預檢參數無效。"),
    ),
    async (c) => {
      const session = c.get("session");
      const unauthorized = requireSession(session);
      if (unauthorized) return unauthorized;
      const csrf = requireCsrf(session!, c.req.header("X-CSRF-Token"));
      if (csrf) return csrf;
      try {
        return c.json(
          await precheckSelectedAccount(c.env, session!, c.req.valid("json")),
        );
      } catch (error) {
        return mapPrecheckError(error);
      }
    },
  );
}

function mapPrecheckError(error: unknown) {
  if (error instanceof AuthServiceError) {
    const status =
      error.code === "TOKEN_EXPIRED" || error.code === "SESSION_EXPIRED"
        ? 401
        : 400;
    return jsonError(error.code, error.message, status);
  }
  if (error instanceof CloudflareApiError) {
    if (error.code === "TOKEN_EXPIRED") {
      return jsonError(
        "TOKEN_EXPIRED",
        "Cloudflare 授權已過期，請重新授權後續跑。",
        401,
      );
    }
    return jsonError(error.code, "無法完成帳戶預檢。", error.status);
  }
  if (error instanceof AccountNotAuthorizedError) {
    return jsonError(
      "ACCOUNT_NOT_AUTHORIZED",
      "請先選擇此次授權可管理的帳戶。",
      403,
    );
  }
  throw error;
}
