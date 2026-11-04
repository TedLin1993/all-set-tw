import { createDrizzle, bankTransactionNotes } from "../../db";
import { eq } from "drizzle-orm";

export async function upsertTransactionNote(
  db: D1Database,
  transactionId: string,
  note: string,
  now: string,
) {
  await createDrizzle(db)
    .insert(bankTransactionNotes)
    .values({ transactionId, note, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: bankTransactionNotes.transactionId,
      set: { note, updatedAt: now },
    })
    .run();
}

export async function deleteTransactionNote(
  db: D1Database,
  transactionId: string,
) {
  await createDrizzle(db)
    .delete(bankTransactionNotes)
    .where(eq(bankTransactionNotes.transactionId, transactionId))
    .run();
}
