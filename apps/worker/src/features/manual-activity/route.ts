import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  ManualActivityCategoryNotFoundError,
  ManualActivityNotFoundError,
  createManualActivity,
  removeManualActivity,
  updateManualActivity,
} from "./service";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fxSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: z.number().nonnegative(),
    rate: z.number().positive(),
  })
  .nullable();
const createSchema = z.object({
  date: isoDateSchema,
  kind: z.enum(["expense", "income"]),
  categoryId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  amount: z.number().positive(),
  fx: fxSchema.optional(),
});
const patchSchema = createSchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, "empty patch");

export const manualActivityRoutes = honoFactory.createApp();
registerManualActivityRoutes(manualActivityRoutes);

function registerManualActivityRoutes(api: Hono<AppBindings>) {
  api.post(
    "/activity/manual",
    zValidator(
      "json",
      createSchema,
      validationHook("INVALID_REQUEST", "Manual activity is invalid."),
    ),
    async (c) => {
      try {
        const id = await createManualActivity(c.env.DB, c.req.valid("json"));
        return c.json({ id }, 201);
      } catch (error) {
        return manualActivityError(error);
      }
    },
  );

  api.put(
    "/activity/manual/:id",
    zValidator(
      "json",
      patchSchema,
      validationHook("INVALID_REQUEST", "Manual activity update is invalid."),
    ),
    async (c) => {
      try {
        await updateManualActivity(
          c.env.DB,
          c.req.param("id"),
          c.req.valid("json"),
        );
        return c.json({ success: true });
      } catch (error) {
        return manualActivityError(error);
      }
    },
  );

  api.delete("/activity/manual/:id", async (c) => {
    try {
      await removeManualActivity(c.env.DB, c.req.param("id"));
      return c.json({ success: true });
    } catch (error) {
      return manualActivityError(error);
    }
  });
}

function manualActivityError(error: unknown) {
  if (error instanceof ManualActivityNotFoundError)
    return jsonError(
      "MANUAL_ACTIVITY_NOT_FOUND",
      "Manual activity was not found.",
      404,
    );
  if (error instanceof ManualActivityCategoryNotFoundError)
    return jsonError(
      "CATEGORY_NOT_FOUND",
      "Classification category was not found.",
      404,
    );
  throw error;
}
