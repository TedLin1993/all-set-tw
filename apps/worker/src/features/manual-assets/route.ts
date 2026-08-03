import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  addManualAsset,
  editManualAsset,
  getManualAssetHistory,
  getManualAssets,
  removeManualAsset,
  removeManualAssetHistory,
  setManualAssetHistory,
} from "./service";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencySchema = z.enum(["TWD", "USD", "JPY", "EUR"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(64),
  note: z.string().max(1_000).optional(),
  currency: currencySchema.default("TWD"),
  value: z.number().finite(),
  date: isoDateSchema,
});
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(64).optional(),
    note: z.string().max(1_000).nullable().optional(),
    currency: currencySchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0);
const historySchema = z.object({
  value: z.number().finite(),
  date: isoDateSchema,
});
const historyDateParamSchema = z.object({
  id: z.string(),
  date: isoDateSchema,
});

export const manualAssetRoutes = honoFactory.createApp();
registerManualAssetRoutes(manualAssetRoutes);

function registerManualAssetRoutes(api: Hono<AppBindings>) {
  api.get("/manual-assets", async (c) =>
    c.json(await getManualAssets(c.env.DB)),
  );

  api.post(
    "/manual-assets",
    zValidator(
      "json",
      createSchema,
      validationHook("INVALID_REQUEST", "Manual asset is invalid."),
    ),
    async (c) =>
      c.json({ id: await addManualAsset(c.env.DB, c.req.valid("json")) }),
  );

  api.put(
    "/manual-assets/:id",
    zValidator(
      "json",
      updateSchema,
      validationHook("INVALID_REQUEST", "Manual asset update is invalid."),
    ),
    async (c) => {
      await editManualAsset(c.env.DB, c.req.param("id"), c.req.valid("json"));
      return c.json({ success: true });
    },
  );

  api.delete("/manual-assets/:id", async (c) => {
    await removeManualAsset(c.env.DB, c.req.param("id"));
    return c.json({ success: true });
  });

  api.get("/manual-assets/:id/history", async (c) =>
    c.json(await getManualAssetHistory(c.env.DB, c.req.param("id"))),
  );

  api.post(
    "/manual-assets/:id/history",
    zValidator(
      "json",
      historySchema,
      validationHook(
        "INVALID_REQUEST",
        "Manual asset history entry is invalid.",
      ),
    ),
    async (c) => {
      await setManualAssetHistory(
        c.env.DB,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json({ success: true });
    },
  );

  api.delete(
    "/manual-assets/:id/history/:date",
    zValidator(
      "param",
      historyDateParamSchema,
      validationHook("INVALID_REQUEST", "date must use YYYY-MM-DD."),
    ),
    async (c) => {
      const params = c.req.valid("param");
      await removeManualAssetHistory(c.env.DB, params.id, params.date);
      return c.json({ success: true });
    },
  );
}
