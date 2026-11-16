import { zValidator } from "@hono/zod-validator";
import {
  type ManualTransactionDeleteResponse,
  type ManualTransactionsRequest,
  type ManualTransactionsResponse,
} from "@taiwan-fin-hub/shared";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { ClassificationCategoryNotFoundError } from "../classification/service";
import { manualTransactionsSchema } from "./schema";
import {
  ManualTransactionNotFoundError,
  recordManualTransactions,
  removeManualTransaction,
} from "./service";

export const manualTransactionRoutes = honoFactory.createApp();

manualTransactionRoutes.post(
  "/manual-transactions",
  zValidator(
    "json",
    manualTransactionsSchema,
    validationHook("INVALID_REQUEST", "Manual transactions are invalid."),
  ),
  async (c) => {
    try {
      const input = c.req.valid("json") satisfies ManualTransactionsRequest;
      return c.json(
        (await recordManualTransactions(
          c.env.DB,
          input,
        )) satisfies ManualTransactionsResponse,
      );
    } catch (error) {
      if (error instanceof ClassificationCategoryNotFoundError)
        return jsonError("CATEGORY_NOT_FOUND", "Category was not found.", 404);
      throw error;
    }
  },
);

manualTransactionRoutes.delete("/manual-transactions/:id", async (c) => {
  try {
    return c.json(
      (await removeManualTransaction(
        c.env.DB,
        c.req.param("id"),
      )) satisfies ManualTransactionDeleteResponse,
    );
  } catch (error) {
    if (error instanceof ManualTransactionNotFoundError)
      return jsonError(
        "MANUAL_TRANSACTION_NOT_FOUND",
        "Manual transaction was not found.",
        404,
      );
    throw error;
  }
});
