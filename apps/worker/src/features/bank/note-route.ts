import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  BANK_TRANSACTION_NOTE_MAX_LENGTH,
  type BankTransactionNoteResponse,
} from "@taiwan-fin-hub/shared";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import { validationHook } from "../../platform/validation";
import { BankTransactionNotFoundError } from "./calculation-service";
import { setTransactionNote } from "./note-service";

const transactionNoteSchema = z.object({
  note: z.string().trim().max(BANK_TRANSACTION_NOTE_MAX_LENGTH),
});

export const bankNoteRoutes = honoFactory.createApp();

bankNoteRoutes.put(
  "/bank/transactions/:transactionId/note",
  zValidator(
    "json",
    transactionNoteSchema,
    validationHook("INVALID_REQUEST", "Transaction note is invalid."),
  ),
  async (c) => {
    try {
      const note = await setTransactionNote(
        c.env.DB,
        c.req.param("transactionId"),
        c.req.valid("json").note,
      );
      return c.json({ note } satisfies BankTransactionNoteResponse);
    } catch (error) {
      if (error instanceof BankTransactionNotFoundError) {
        return jsonError(
          "BANK_TRANSACTION_NOT_FOUND",
          "Bank transaction was not found.",
          404,
        );
      }
      throw error;
    }
  },
);
