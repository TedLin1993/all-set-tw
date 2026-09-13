import {
  createDrizzle,
  bankAccounts,
  bankTransactions,
  invoiceTransactionPreferences,
  invoices,
} from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

const bankTx = alias(bankTransactions, "bank_tx");
const account = alias(bankAccounts, "account");

export type InvoiceTransactionPreferenceRow = {
  invoiceId: string;
  transactionId: string | null;
  decision: "linked" | "separate";
  createdAt: string;
  updatedAt: string;
};

export type MappingInvoiceRow = {
  id: string;
  invoiceDate: string;
};

export type MappingTransactionRow = {
  id: string;
  postedDate: string | null;
  authorizedAt: string | null;
  amount: number;
  currency: string;
  accountType: string | null;
};

export async function listInvoiceTransactionPreferences(db: D1Database) {
  return createDrizzle(db)
    .select({
      invoiceId: sql<string>`${invoiceTransactionPreferences.invoiceId}`,
      transactionId: invoiceTransactionPreferences.transactionId,
      decision: sql<
        "linked" | "separate"
      >`${invoiceTransactionPreferences.decision}`,
      createdAt: invoiceTransactionPreferences.createdAt,
      updatedAt: invoiceTransactionPreferences.updatedAt,
    })
    .from(invoiceTransactionPreferences)
    .where(
      sql`${invoiceTransactionPreferences.transactionId} IS NULL OR NOT EXISTS (
        SELECT 1 FROM bank_transactions txn
        WHERE txn.id = ${invoiceTransactionPreferences.transactionId} AND txn.status = 'pending' AND txn.matched_transaction_id IS NOT NULL
      )`,
    )
    .orderBy(
      desc(invoiceTransactionPreferences.updatedAt),
      asc(invoiceTransactionPreferences.invoiceId),
    )
    .all();
}

export async function findMappingInvoice(db: D1Database, invoiceId: string) {
  return (
    (await createDrizzle(db)
      .select({
        id: sql<string>`${invoices.id}`,
        invoiceDate: invoices.invoiceDate,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .get()) ?? null
  );
}

export async function findMappingTransaction(
  db: D1Database,
  transactionId: string,
) {
  return (
    (await createDrizzle(db)
      .select({
        id: sql<string>`${bankTx.id}`,
        postedDate: bankTx.postedDate,
        authorizedAt: bankTx.authorizedAt,
        amount: bankTx.amount,
        currency: bankTx.currency,
        accountType: account.accountType,
      })
      .from(bankTx)
      .innerJoin(account, eq(account.id, bankTx.accountId))
      .where(
        and(
          eq(bankTx.id, transactionId),
          sql`(${bankTx.status} <> 'pending' OR ${bankTx.matchedTransactionId} IS NULL)`,
        ),
      )
      .get()) ?? null
  );
}

export async function findLinkedInvoiceId(
  db: D1Database,
  transactionId: string,
) {
  const row = await createDrizzle(db)
    .select({
      invoiceId: sql<string>`${invoiceTransactionPreferences.invoiceId}`,
    })
    .from(invoiceTransactionPreferences)
    .where(
      and(
        eq(invoiceTransactionPreferences.transactionId, transactionId),
        eq(invoiceTransactionPreferences.decision, "linked"),
      ),
    )
    .get();
  return row?.invoiceId;
}

export async function upsertInvoiceTransactionPreference(
  db: D1Database,
  input: {
    invoiceId: string;
    transactionId: string | null;
    decision: "linked" | "separate";
    now: string;
  },
) {
  await createDrizzle(db)
    .insert(invoiceTransactionPreferences)
    .values({
      invoiceId: input.invoiceId,
      transactionId: input.transactionId,
      decision: input.decision,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: invoiceTransactionPreferences.invoiceId,
      set: {
        transactionId: input.transactionId,
        decision: input.decision,
        updatedAt: input.now,
      },
    })
    .run();
}
