import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import {
  ClassificationCategoryExistsError,
  ClassificationCategoryNotFoundError,
  ClassificationRuleOrderError,
  ClassificationRuleNotFoundError,
  createClassificationCategory,
  createClassificationRule,
  editClassificationRule,
  getClassificationCategories,
  getClassificationRules,
  removeClassificationOverride,
  removeClassificationRule,
  reorderClassificationRules,
  setClassificationOverride,
} from "./service";

const targetTypeSchema = z.enum(["bank_transaction"]);
const overrideParamSchema = z.object({ targetType: targetTypeSchema });
const categorySchema = z.object({ categoryId: z.string().min(1).max(64) });
const createCategorySchema = z.object({
  label: z.string().trim().min(1).max(24),
});
const createRuleSchema = z.object({
  categoryId: z.string().min(1).max(64),
  targetType: targetTypeSchema.optional(),
  field: z.enum(["any_text", "description", "counterparty", "source_id"]),
  operator: z.enum(["contains", "equals", "starts_with", "regex"]),
  pattern: z.string().min(1).max(300),
  priority: z.number().int().min(0).max(10_000).optional(),
  description: z.string().max(500).optional(),
  excludedFromCalculation: z.boolean().optional(),
});
const updateRuleSchema = z
  .object({
    categoryId: z.string().min(1).max(64).optional(),
    operator: z.enum(["contains", "equals", "starts_with", "regex"]).optional(),
    pattern: z.string().min(1).max(300).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    enabled: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
    excludedFromCalculation: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0);
const reorderRulesSchema = z.object({
  ruleIds: z
    .array(z.string().min(1).max(128))
    .max(9_000)
    .refine((ruleIds) => new Set(ruleIds).size === ruleIds.length),
});

function extractOverrideTargetId(requestPath: string, targetType: string) {
  const prefix = `/classification/overrides/${targetType}/`;
  const index = requestPath.indexOf(prefix);
  return index >= 0 ? requestPath.slice(index + prefix.length) : "";
}

export const classificationRoutes = honoFactory.createApp();
registerClassificationRoutes(classificationRoutes);

function registerClassificationRoutes(api: Hono<AppBindings>) {
  api.get("/classification/categories", async (c) =>
    c.json(await getClassificationCategories(c.env.DB)),
  );

  api.post(
    "/classification/categories",
    zValidator(
      "json",
      createCategorySchema,
      validationHook("INVALID_REQUEST", "Classification category is invalid."),
    ),
    async (c) => {
      try {
        return c.json(
          await createClassificationCategory(
            c.env.DB,
            c.req.valid("json").label,
          ),
          201,
        );
      } catch (error) {
        if (error instanceof ClassificationCategoryExistsError) {
          return jsonError(
            "CATEGORY_EXISTS",
            "A category with the same name already exists.",
            409,
          );
        }
        throw error;
      }
    },
  );

  api.get("/classification/rules", async (c) =>
    c.json(await getClassificationRules(c.env.DB)),
  );

  api.put(
    "/classification/rules/order",
    zValidator(
      "json",
      reorderRulesSchema,
      validationHook(
        "INVALID_REQUEST",
        "Classification rule order is invalid.",
      ),
    ),
    async (c) => {
      try {
        await reorderClassificationRules(c.env.DB, c.req.valid("json").ruleIds);
        return c.json({ success: true });
      } catch (error) {
        return classificationServiceError(error);
      }
    },
  );

  api.put(
    "/classification/overrides/:targetType/*",
    zValidator(
      "param",
      overrideParamSchema,
      validationHook("INVALID_REQUEST", "Classification override is invalid."),
    ),
    zValidator(
      "json",
      categorySchema,
      validationHook("INVALID_REQUEST", "Classification override is invalid."),
    ),
    async (c) => {
      const targetType = c.req.valid("param").targetType;
      const body = c.req.valid("json");
      const targetId = extractOverrideTargetId(c.req.path, targetType);
      if (!targetId)
        return jsonError("INVALID_REQUEST", "targetId is required.");
      await setClassificationOverride(
        c.env.DB,
        targetType,
        targetId,
        body.categoryId,
      );
      return c.json({ success: true });
    },
  );

  api.delete(
    "/classification/overrides/:targetType/*",
    zValidator(
      "param",
      overrideParamSchema,
      validationHook("INVALID_REQUEST", "targetType is not supported."),
    ),
    async (c) => {
      const targetType = c.req.valid("param").targetType;
      const targetId = extractOverrideTargetId(c.req.path, targetType);
      if (!targetId)
        return jsonError("INVALID_REQUEST", "targetId is required.");
      await removeClassificationOverride(c.env.DB, targetType, targetId);
      return c.json({ success: true });
    },
  );

  api.post(
    "/classification/rules",
    zValidator(
      "json",
      createRuleSchema,
      validationHook("INVALID_REQUEST", "Classification rule is invalid."),
    ),
    async (c) => {
      try {
        return c.json({
          id: await createClassificationRule(c.env.DB, c.req.valid("json")),
          success: true,
        });
      } catch (error) {
        return classificationServiceError(error);
      }
    },
  );

  api.put(
    "/classification/rules/:ruleId",
    zValidator(
      "json",
      updateRuleSchema,
      validationHook(
        "INVALID_REQUEST",
        "Classification rule update is invalid.",
      ),
    ),
    async (c) => {
      try {
        await editClassificationRule(
          c.env.DB,
          c.req.param("ruleId"),
          c.req.valid("json"),
        );
        return c.json({ success: true });
      } catch (error) {
        return classificationServiceError(error);
      }
    },
  );

  api.delete("/classification/rules/:ruleId", async (c) => {
    try {
      await removeClassificationRule(c.env.DB, c.req.param("ruleId"));
      return c.json({ success: true });
    } catch (error) {
      return classificationServiceError(error);
    }
  });
}

function classificationServiceError(error: unknown) {
  if (error instanceof ClassificationCategoryNotFoundError) {
    return jsonError(
      "CATEGORY_NOT_FOUND",
      "Classification category was not found.",
      404,
    );
  }
  if (error instanceof ClassificationRuleNotFoundError) {
    return jsonError("RULE_NOT_FOUND", "Editable rule was not found.", 404);
  }
  if (error instanceof ClassificationRuleOrderError) {
    return jsonError(
      "INVALID_REQUEST",
      "Classification rule order is out of date. Reload and try again.",
      400,
    );
  }
  throw error;
}
