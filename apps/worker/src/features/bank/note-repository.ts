import { createDrizzle, bankTransactionPreferences } from "../../db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

const preference = bankTransactionPreferences;

export async function upsertTransactionNote(
  db: D1Database,
  transactionId: string,
  note: string,
  now: string,
) {
  // A note-only row keeps excluded_from_calculation NULL: no calculation choice.
  await createDrizzle(db)
    .insert(preference)
    .values({ transactionId, note, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: preference.transactionId,
      set: { note, updatedAt: now },
    })
    .run();
}

/** Clears the note; a row left without any preference is removed. */
export async function clearTransactionNote(
  db: D1Database,
  transactionId: string,
  now: string,
) {
  const drizzle = createDrizzle(db);
  const target = eq(preference.transactionId, transactionId);
  await drizzle.batch([
    drizzle
      .update(preference)
      .set({ note: null, updatedAt: now })
      .where(
        and(
          target,
          isNotNull(preference.note),
          isNotNull(preference.excludedFromCalculation),
        ),
      ),
    drizzle
      .delete(preference)
      .where(and(target, isNull(preference.excludedFromCalculation))),
  ]);
}
