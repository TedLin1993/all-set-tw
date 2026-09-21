import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { CloudflareApiError } from "../../platform/cloudflare";
import { ReleaseUnavailableError } from "../../platform/release";
import { requireCsrf, requireSession } from "../../middleware/session";
import { AuthServiceError } from "../auth/service";
import {
  AccountNotAuthorizedError,
  WORKER_NAME_PATTERN,
} from "../precheck/service";
import {
  InstallationConflictError,
  InstallationNotFoundError,
  createOrReuseInstallation,
  getOwnedInstallationDetail,
  getOwnedInstallationJob,
  getOwnedUpdatePlan,
  installerWritesEnabled,
  listOwnedInstallations,
  resumeOwnedInstallation,
  startOwnedUpdate,
  toInstallationDto,
  toJobDto,
  UpgradeNotAllowedError,
  InstallationNotReadyError,
} from "./service";

const createSchema = z.object({
  accountId: z.string().min(1).max(64),
  workerName: z.string().regex(WORKER_NAME_PATTERN),
  allowedEmail: z.string().email().max(254),
  targetVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),
  targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

export const installationRoutes = honoFactory.createApp();
registerInstallationRoutes(installationRoutes);

function registerInstallationRoutes(api: Hono<AppBindings>) {
  api.get("/installations", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    try {
      const rows = await listOwnedInstallations(c.env, session!);
      return c.json({ installations: rows.map(toInstallationDto) });
    } catch (error) {
      return mapInstallationError(error);
    }
  });

  api.post(
    "/installations",
    zValidator(
      "json",
      createSchema,
      validationHook("INVALID_REQUEST", "安裝參數無效。"),
    ),
    async (c) => {
      const session = c.get("session");
      const unauthorized = requireSession(session);
      if (unauthorized) return unauthorized;
      const csrf = requireCsrf(session!, c.req.header("X-CSRF-Token"));
      if (csrf) return csrf;
      try {
        const result = await createOrReuseInstallation(
          c.env,
          session!,
          c.req.valid("json"),
        );
        return c.json({
          installation: toInstallationDto(result.installation),
          job: toJobDto(result.job),
          reused: result.reused,
          writesEnabled: installerWritesEnabled(c.env),
        });
      } catch (error) {
        return mapInstallationError(error);
      }
    },
  );

  api.get("/installations/:id", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    try {
      const result = await getOwnedInstallationDetail(
        c.env,
        session!,
        c.req.param("id"),
      );
      return c.json({
        installation: toInstallationDto(result.installation),
        job: result.job ? toJobDto(result.job) : null,
      });
    } catch (error) {
      return mapInstallationError(error);
    }
  });

  api.get("/installations/:id/jobs/:jobId", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    try {
      const result = await getOwnedInstallationJob(
        c.env,
        session!,
        c.req.param("id"),
        c.req.param("jobId"),
      );
      return c.json({
        installation: toInstallationDto(result.installation),
        job: toJobDto(result.job),
      });
    } catch (error) {
      return mapInstallationError(error);
    }
  });

  api.post("/installations/:id/jobs", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    const csrf = requireCsrf(session!, c.req.header("X-CSRF-Token"));
    if (csrf) return csrf;
    try {
      const result = await resumeOwnedInstallation(
        c.env,
        session!,
        c.req.param("id"),
      );
      return c.json({
        installation: toInstallationDto(result.installation),
        job: toJobDto(result.job),
      });
    } catch (error) {
      return mapInstallationError(error);
    }
  });

  api.get("/installations/:id/update-plan", async (c) => {
    const session = c.get("session");
    const unauthorized = requireSession(session);
    if (unauthorized) return unauthorized;
    try {
      const plan = await getOwnedUpdatePlan(c.env, session!, c.req.param("id"));
      return c.json(plan);
    } catch (error) {
      return mapInstallationError(error);
    }
  });

  api.post(
    "/installations/:id/updates",
    zValidator(
      "json",
      z.object({
        targetVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),
        targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      validationHook("INVALID_REQUEST", "更新參數無效。"),
    ),
    async (c) => {
      const session = c.get("session");
      const unauthorized = requireSession(session);
      if (unauthorized) return unauthorized;
      const csrf = requireCsrf(session!, c.req.header("X-CSRF-Token"));
      if (csrf) return csrf;
      try {
        const result = await startOwnedUpdate(
          c.env,
          session!,
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json({
          installation: toInstallationDto(result.installation),
          job: toJobDto(result.job),
          writesEnabled: installerWritesEnabled(c.env),
        });
      } catch (error) {
        return mapInstallationError(error);
      }
    },
  );
}

function mapInstallationError(error: unknown) {
  if (error instanceof AuthServiceError) {
    const status =
      error.code === "TOKEN_EXPIRED" || error.code === "SESSION_EXPIRED"
        ? 401
        : 400;
    return jsonError(error.code, error.message, status);
  }
  if (error instanceof AccountNotAuthorizedError) {
    return jsonError(
      "ACCOUNT_NOT_AUTHORIZED",
      "請先選擇此次授權可管理的帳戶。",
      403,
    );
  }
  if (error instanceof InstallationConflictError) {
    return jsonError(
      "INSTALLATION_CONFLICT",
      "此帳戶已有同名安裝，且不屬於目前授權身分。",
      409,
    );
  }
  if (error instanceof InstallationNotFoundError) {
    return jsonError("INSTALLATION_NOT_FOUND", "找不到這筆安裝紀錄。", 404);
  }
  if (error instanceof InstallationNotReadyError) {
    const message =
      error.code === "UP_TO_DATE"
        ? "目前已是這個版本。"
        : "這筆安裝還不能更新。";
    return jsonError(error.code, message, 409);
  }
  if (error instanceof UpgradeNotAllowedError) {
    return jsonError(
      "UPGRADE_NOT_ALLOWED",
      "這個版本尚未開放從此安裝來源更新。",
      409,
    );
  }
  if (error instanceof ReleaseUnavailableError) {
    return jsonError(error.code, "維護者尚未發布可安裝的版本包。", 503);
  }
  if (error instanceof CloudflareApiError && error.code === "TOKEN_EXPIRED") {
    return jsonError(
      "TOKEN_EXPIRED",
      "Cloudflare 授權已過期，請重新授權後續跑。",
      401,
    );
  }
  if (error instanceof Error && error.message === "INVALID_REQUEST") {
    return jsonError("INVALID_REQUEST", "安裝參數無效。", 400);
  }
  throw error;
}
