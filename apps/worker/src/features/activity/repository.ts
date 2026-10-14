import {
  createDrizzle,
  bankAccounts,
  bankTransactions,
  invoiceTransactionPreferences,
  invoices,
} from "../../db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { invoiceDayInRange } from "../invoices/repository";
import type { MonthDateRange } from "../../platform/month-range";

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

export async function listInvoiceTransactionPreferences(
  db: D1Database,
  range?: MonthDateRange,
) {
  const drizzle = createDrizzle(db);
  return drizzle
    .select({
      invoiceId: invoiceTransactionPreferences.invoiceId,
      transactionId: invoiceTransactionPreferences.transactionId,
      decision: sql<
        "linked" | "separate"
      >`${invoiceTransactionPreferences.decision}`,
      createdAt: invoiceTransactionPreferences.createdAt,
      updatedAt: invoiceTransactionPreferences.updatedAt,
    })
    .from(invoiceTransactionPreferences)
    .where(
      and(
        // Linking requires the same Taipei day, so a page only needs the
        // decisions for invoices inside its range.
        range
          ? inArray(
              invoiceTransactionPreferences.invoiceId,
              drizzle
                .select({ id: invoices.id })
                .from(invoices)
                .where(invoiceDayInRange(range)),
            )
          : undefined,
        notExists(
          drizzle
            .select({ id: bankTx.id })
            .from(bankTx)
            .where(
              and(
                eq(bankTx.id, invoiceTransactionPreferences.transactionId),
                eq(bankTx.status, "pending"),
                isNotNull(bankTx.matchedTransactionId),
              ),
            ),
        ),
      ),
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
        id: invoices.id,
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
        id: bankTx.id,
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
          or(ne(bankTx.status, "pending"), isNull(bankTx.matchedTransactionId)),
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
      invoiceId: invoiceTransactionPreferences.invoiceId,
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
