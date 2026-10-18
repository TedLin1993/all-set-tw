import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  aiClassifications,
  aiClassificationSettings as settings,
  bankTransactions,
  classificationCategories as categories,
  createDrizzle,
} from "../../db";

export type AiClassificationSettingsRow = typeof settings.$inferSelect;
export type AiClassificationSettingsPatch = Partial<
  Omit<AiClassificationSettingsRow, "id">
>;

export async function getAiClassificationSettings(db: D1Database) {
  const row = await createDrizzle(db)
    .select()
    .from(settings)
    .where(eq(settings.id, "default"))
    .get();
  if (!row) throw new Error("AI classification settings row is missing.");
  return row;
}

export async function updateAiClassificationSettings(
  db: D1Database,
  patch: AiClassificationSettingsPatch,
) {
  await createDrizzle(db)
    .update(settings)
    .set({ ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() })
    .where(eq(settings.id, "default"));
}

export async function listAiClassifications(
  db: D1Database,
  transactionIds: string[],
) {
  if (transactionIds.length === 0) return [];
  return createDrizzle(db)
    .select({
      transactionId: aiClassifications.transactionId,
      categoryId: aiClassifications.categoryId,
      label: categories.label,
      inputHash: aiClassifications.inputHash,
    })
    .from(aiClassifications)
    .leftJoin(categories, eq(categories.id, aiClassifications.categoryId))
    .where(
      sql`${aiClassifications.transactionId} IN (SELECT value FROM json_each(${JSON.stringify(transactionIds)}))`,
    )
    .all();
}

export async function upsertAiClassification(
  db: D1Database,
  input: {
    transactionId: string;
    categoryId: string | null;
    probability: number;
    inputHash: string;
    model: string;
  },
) {
  const now = new Date().toISOString();
  await createDrizzle(db)
    .insert(aiClassifications)
    .values({ ...input, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: aiClassifications.transactionId,
      set: {
        categoryId: input.categoryId,
        probability: input.probability,
        inputHash: input.inputHash,
        model: input.model,
        updatedAt: now,
      },
    });
}

export async function deleteAllAiClassifications(db: D1Database) {
  await createDrizzle(db).delete(aiClassifications);
}

/** Ids among the given transactions first written at or after `since`. */
export async function listBankTransactionIdsCreatedSince(
  db: D1Database,
  transactionIds: string[],
  since: string,
) {
  if (transactionIds.length === 0) return new Set<string>();
  const rows = await createDrizzle(db)
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .where(
      and(
        gte(bankTransactions.createdAt, since),
        sql`${bankTransactions.id} IN (SELECT value FROM json_each(${JSON.stringify(transactionIds)}))`,
      ),
    )
    .all();
  return new Set(rows.map((row) => row.id));
}

export async function countAiClassifications(db: D1Database) {
  const drizzle = createDrizzle(db);
  const [classified, undetermined] = await Promise.all([
    drizzle
      .select({ count: sql<number>`COUNT(*)` })
      .from(aiClassifications)
      .where(isNotNull(aiClassifications.categoryId))
      .get(),
    drizzle
      .select({ count: sql<number>`COUNT(*)` })
      .from(aiClassifications)
      .where(isNull(aiClassifications.categoryId))
      .get(),
  ]);
  return {
    classified: classified?.count ?? 0,
    undetermined: undetermined?.count ?? 0,
  };
}

/** Changes whenever a sync writes transactions or invoices, or a mapping moves. */
export async function readAiClassificationWatermark(db: D1Database) {
  const row = await db
    .prepare(
      `SELECT
         COALESCE((SELECT MAX(updated_at) FROM bank_transactions), '') || '|' ||
         COALESCE((SELECT MAX(updated_at) FROM invoices), '') || '|' ||
         COALESCE((SELECT MAX(updated_at) FROM invoice_transaction_preferences), '')
         AS watermark`,
    )
    .first<{ watermark: string }>();
  return row?.watermark ?? "";
}

/** Month (YYYY-MM) of the oldest bank transaction, or null when there is none. */
export async function findEarliestBankTransactionMonth(db: D1Database) {
  const row = await db
    .prepare(
      "SELECT MIN(substr(COALESCE(authorized_at, posted_date), 1, 7)) AS month FROM bank_transactions",
    )
    .first<{ month: string | null }>();
  return row?.month ?? null;
}
