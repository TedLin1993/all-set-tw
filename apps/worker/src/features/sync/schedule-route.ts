import { isConnectorId } from "@taiwan-fin-hub/core";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  editSyncJob,
  getDefaultSyncSchedule,
  getSyncJobs,
  setDefaultSyncSchedule,
  SyncJobNotFoundError,
} from "./schedule-service";
import { getLatestScheduledSyncReport } from "./report-repository";

const syncIntervalSchema = z
  .number()
  .int()
  .refine(
    (value) => [60, 360, 720, 1440, 10080].includes(value),
    "Unsupported sync interval.",
  );
const preferredTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const preferredWeekdaySchema = z.number().int().min(0).max(6);
const syncScheduleUpdateSchema = z.object({
  intervalMinutes: syncIntervalSchema,
  preferredTime: preferredTimeSchema,
  preferredWeekday: preferredWeekdaySchema,
});
const syncJobUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    nextRunAt: z.string().datetime().optional(),
    intervalMinutes: syncIntervalSchema.optional(),
    preferredTime: preferredTimeSchema.optional(),
    preferredWeekday: preferredWeekdaySchema.optional(),
    scheduleMode: z.enum(["inherit", "custom"]).optional(),
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    "At least one sync job setting is required.",
  );
const scheduledSyncScopeSchema = z.literal("all");
const syncJobParamSchema = z.object({
  connectorId: z.string(),
  scope: scheduledSyncScopeSchema,
});

export const syncScheduleRoutes = honoFactory.createApp();
registerSyncScheduleRoutes(syncScheduleRoutes);

function registerSyncScheduleRoutes(api: Hono<AppBindings>) {
  api.get("/sync-schedule", async (c) =>
    c.json(await getDefaultSyncSchedule(c.env.DB)),
  );

  api.put(
    "/sync-schedule",
    zValidator(
      "json",
      syncScheduleUpdateSchema,
      validationHook(
        "INVALID_REQUEST_BODY",
        "Sync schedule requires a supported interval and HH:mm time.",
      ),
    ),
    async (c) =>
      c.json(await setDefaultSyncSchedule(c.env.DB, c.req.valid("json"))),
  );

  api.get("/sync-jobs", async (c) => c.json(await getSyncJobs(c.env.DB)));

  api.get("/sync-reports/latest", async (c) =>
    c.json(await getLatestScheduledSyncReport(c.env.DB)),
  );

  api.patch(
    "/sync-jobs/:connectorId/:scope",
    zValidator(
      "param",
      syncJobParamSchema,
      validationHook(
        "SYNC_JOB_NOT_FOUND",
        "Scheduled sync scope is not supported.",
        404,
      ),
    ),
    zValidator(
      "json",
      syncJobUpdateSchema,
      validationHook(
        "INVALID_REQUEST_BODY",
        "Request body must include a valid sync job setting.",
      ),
    ),
    async (c) => {
      const { connectorId, scope } = c.req.valid("param");
      if (!isConnectorId(connectorId)) {
        return jsonError(
          "CONNECTOR_NOT_FOUND",
          "Connector id is not supported.",
          404,
        );
      }
      try {
        return c.json(
          await editSyncJob(c.env.DB, connectorId, scope, c.req.valid("json")),
        );
      } catch (error) {
        if (error instanceof SyncJobNotFoundError) {
          return jsonError(
            "SYNC_JOB_NOT_FOUND",
            "Sync job is not configured.",
            404,
          );
        }
        throw error;
      }
    },
  );
}
