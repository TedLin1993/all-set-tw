import {
  createDrizzle,
  bankAccounts,
  bankTransactionPreferences,
  bankTransactions,
  classificationCategories,
  classificationOverrides,
  invoiceTransactionPreferences,
} from "../../db";
import { and, eq } from "drizzle-orm";

/** 手動記錄固定掛在這個 is_manual 虛擬帳戶底下（由 0066 建立）。 */
export const MANUAL_ACCOUNT_ID = "manual:cash";
export const MANUAL_CONNECTOR_ID = "manual";

export type ManualTransactionRow = {
  id: string;
  amount: number;
  rawPayload: string | null;
};

export async function categoryExists(db: D1Database, categoryId: string) {
  return Boolean(
    await createDrizzle(db)
      .select({ id: classificationCategories.id })
      .from(classificationCategories)
      .where(eq(classificationCategories.id, categoryId))
      .limit(1)
      .get(),
  );
}

/** 只回傳掛在 is_manual 帳戶底下的交易；其他交易視為不存在。 */
export async function getManualTransaction(db: D1Database, id: string) {
  return (
    (await createDrizzle(db)
      .select({
        id: bankTransactions.id,
        amount: bankTransactions.amount,
        rawPayload: bankTransactions.rawPayload,
      })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.accountId))
      .where(and(eq(bankTransactions.id, id), eq(bankAccounts.isManual, 1)))
      .limit(1)
      .get()) ?? null
  );
}

export async function insertManualTransaction(
  db: D1Database,
  input: {
    id: string;
    date: string;
    amount: number;
    description: string;
    rawPayload: string;
    categoryId: string;
    now: string;
  },
) {
  const database = createDrizzle(db);
  await database.batch([
    database.insert(bankTransactions).values({
      id: input.id,
      connectorId: MANUAL_CONNECTOR_ID,
      accountId: MANUAL_ACCOUNT_ID,
      sourceId: input.id,
      postedDate: input.date,
      authorizedAt: input.date,
      amount: input.amount,
      currency: "TWD",
      description: input.description,
      counterparty: null,
      rawPayload: input.rawPayload,
      status: "posted",
      createdAt: input.now,
      updatedAt: input.now,
    }),
    database.insert(classificationOverrides).values({
      id: `override:bank_transaction:${input.id}`,
      targetType: "bank_transaction",
      targetId: input.id,
      categoryId: input.categoryId,
      createdAt: input.now,
      updatedAt: input.now,
    }),
  ]);
}

export async function updateManualTransactionRow(
  db: D1Database,
  id: string,
  patch: {
    date?: string;
    amount?: number;
    description?: string;
    rawPayload?: string;
  },
  now: string,
) {
  const values: Partial<typeof bankTransactions.$inferInsert> = {
    updatedAt: now,
  };
  if (patch.date !== undefined) {
    values.postedDate = patch.date;
    values.authorizedAt = patch.date;
  }
  if (patch.amount !== undefined) values.amount = patch.amount;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.rawPayload !== undefined) values.rawPayload = patch.rawPayload;
  await createDrizzle(db)
    .update(bankTransactions)
    .set(values)
    .where(eq(bankTransactions.id, id))
    .run();
}

export async function upsertOverride(
  db: D1Database,
  targetId: string,
  categoryId: string,
  now: string,
) {
  await createDrizzle(db)
    .insert(classificationOverrides)
    .values({
      id: `override:bank_transaction:${targetId}`,
      targetType: "bank_transaction",
      targetId,
      categoryId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        classificationOverrides.targetType,
        classificationOverrides.targetId,
      ],
      set: { categoryId, updatedAt: now },
    })
    .run();
}

/** 刪除交易，連同分類 override、計算偏好；已連結的發票改回「不關聯」。 */
export async function deleteManualTransaction(db: D1Database, id: string) {
  const database = createDrizzle(db);
  await database.batch([
    database
      .delete(classificationOverrides)
      .where(
        and(
          eq(classificationOverrides.targetType, "bank_transaction"),
          eq(classificationOverrides.targetId, id),
        ),
      ),
    database
      .delete(bankTransactionPreferences)
      .where(eq(bankTransactionPreferences.transactionId, id)),
    database
      .update(invoiceTransactionPreferences)
      .set({ transactionId: null, decision: "separate" })
      .where(
        and(
          eq(invoiceTransactionPreferences.transactionId, id),
          eq(invoiceTransactionPreferences.decision, "linked"),
        ),
      ),
    database.delete(bankTransactions).where(eq(bankTransactions.id, id)),
  ]);
}
