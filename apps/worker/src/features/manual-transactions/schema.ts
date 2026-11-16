import { z } from "zod";
import {
  BANK_TRANSACTION_NOTE_MAX_LENGTH,
  MANUAL_TRANSACTION_BATCH_MAX,
  MANUAL_TRANSACTION_DESCRIPTION_MAX_LENGTH,
  MANUAL_TRANSACTION_TYPES,
} from "@taiwan-fin-hub/shared";

const MAX_AMOUNT = 1_000_000_000;

const transactionSchema = z
  .object({
    externalId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional()
      .describe(
        "自訂識別碼（英數與 . _ -，最多 64 字）；相同識別碼再次寫入會更新同一筆，可用來修改或避免重複。省略時由系統產生。",
      ),
    date: z.iso.date().describe("YYYY-MM-DD。"),
    type: z
      .enum(MANUAL_TRANSACTION_TYPES)
      .describe(
        "expense 支出、income 收入；transfer_in、transfer_out 為自己的帳戶與現金之間的移動（ATM 提款用 transfer_in、把現金存入銀行用 transfer_out），不計入收支。",
      ),
    amount: z
      .number()
      .int()
      .positive()
      .max(MAX_AMOUNT)
      .describe("新台幣正整數，方向由 type 決定。"),
    description: z
      .string()
      .trim()
      .min(1)
      .max(MANUAL_TRANSACTION_DESCRIPTION_MAX_LENGTH),
    categoryId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "分類 ID（見 GET /classification/categories），只適用於 expense、income；省略時由分類規則決定。",
      ),
    note: z
      .string()
      .trim()
      .max(BANK_TRANSACTION_NOTE_MAX_LENGTH)
      .optional()
      .describe("備註，例如外幣原始金額；省略時保留原備註，空字串清除。"),
  })
  .refine(
    (transaction) =>
      transaction.categoryId === undefined ||
      transaction.type === "expense" ||
      transaction.type === "income",
    "categoryId only applies to expense and income.",
  );

export const manualTransactionsSchema = z
  .object({
    transactions: z
      .array(transactionSchema)
      .max(MANUAL_TRANSACTION_BATCH_MAX)
      .optional(),
    balance: z
      .number()
      .int()
      .min(0)
      .max(MAX_AMOUNT)
      .optional()
      .describe(
        "使用者目前實際持有的現金（新台幣）；與記錄加總不同時補一筆不計入收支的餘額調整。",
      ),
  })
  .refine(
    (body) =>
      (body.transactions?.length ?? 0) > 0 || body.balance !== undefined,
    "transactions or balance is required.",
  )
  .refine((body) => {
    const ids = (body.transactions ?? []).flatMap(({ externalId }) =>
      externalId ? [externalId] : [],
    );
    return new Set(ids).size === ids.length;
  }, "externalId must be unique within a request.");
