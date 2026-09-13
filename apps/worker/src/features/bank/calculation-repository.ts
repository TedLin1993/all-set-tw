import {
  createDrizzle,
  bankTransactionPreferences,
  bankTransactions,
} from "@taiwan-fin-hub/db";
import { and, eq, sql } from "drizzle-orm";

export async function bankTransactionExists(
  db: D1Database,
  transactionId: string,
) {
  return Boolean(
    await createDrizzle(db)
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.id, transactionId),
          sql`(${bankTransactions.status} <> 'pending' OR ${bankTransactions.matchedTransactionId} IS NULL)`,
        ),
      )
      .get(),
  );
}

export async function upsertCalculationPreference(
  db: D1Database,
  transactionId: string,
  excludedFromCalculation: boolean,
  now: string,
) {
  await createDrizzle(db)
    .insert(bankTransactionPreferences)
    .values({
      transactionId,
      excludedFromCalculation: excludedFromCalculation ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: bankTransactionPreferences.transactionId,
      set: {
        excludedFromCalculation: excludedFromCalculation ? 1 : 0,
        updatedAt: now,
      },
    })
    .run();
}
