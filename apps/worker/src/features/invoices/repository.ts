import type { ConnectorId } from "@taiwan-fin-hub/core";
import { createDrizzle, invoiceLineItems, invoices } from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { MonthDateRange } from "../../platform/month-range";

// Taipei calendar day for precise timestamps; date-only TEXT stays unchanged.
const invoiceDay = sql`CASE WHEN length(${invoices.invoiceDate}) > 10
  THEN COALESCE(date(${invoices.invoiceDate}, '+8 hours'), substr(${invoices.invoiceDate}, 1, 10))
  ELSE ${invoices.invoiceDate} END`;

const invoiceSummaryColumns = {
  id: invoices.id,
  connectorId: sql<ConnectorId>`${invoices.connectorId}`,
  sourceId: invoices.sourceId,
  invoiceNumber: invoices.invoiceNumber,
  invoiceDate: invoices.invoiceDate,
  sellerName: invoices.sellerName,
  amount: invoices.amount,
};

export type InvoicePageCursor = {
  invoiceDate: string;
  updatedAt: string;
  id: string;
};

export type InvoiceRow = {
  id: string;
  connectorId: ConnectorId;
  sourceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  sellerName: string | null;
  amount: number;
  updatedAt: string;
};

export type InvoiceItemRow = {
  id: string;
  invoiceId: string;
  sourceId: string;
  lineNumber: number;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
};

export async function listInvoices(
  db: D1Database,
  limit: number,
  cursor?: InvoicePageCursor,
) {
  return createDrizzle(db)
    .select({
      ...invoiceSummaryColumns,
      updatedAt: invoices.updatedAt,
    })
    .from(invoices)
    .where(
      cursor
        ? sql`(${invoices.invoiceDate}, ${invoices.updatedAt}, ${invoices.id}) < (${cursor.invoiceDate}, ${cursor.updatedAt}, ${cursor.id})`
        : undefined,
    )
    .orderBy(
      desc(invoices.invoiceDate),
      desc(invoices.updatedAt),
      desc(invoices.id),
    )
    .limit(limit)
    .all();
}

export async function listInvoicesInRange(
  db: D1Database,
  range: MonthDateRange,
  days?: string[],
) {
  return createDrizzle(db)
    .select({
      ...invoiceSummaryColumns,
      updatedAt: invoices.updatedAt,
    })
    .from(invoices)
    .where(
      days
        ? sql`(${invoiceDay}) IN (SELECT value FROM json_each(${JSON.stringify(days)}))`
        : and(
            sql`(${invoiceDay}) >= ${range.from}`,
            sql`(${invoiceDay}) < ${range.to}`,
          ),
    )
    .orderBy(
      desc(invoices.invoiceDate),
      desc(invoices.updatedAt),
      desc(invoices.id),
    )
    .all();
}

export async function listInvoiceItems(db: D1Database, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return [];
  return createDrizzle(db)
    .select({
      id: invoiceLineItems.id,
      invoiceId: invoiceLineItems.invoiceId,
      sourceId: invoiceLineItems.sourceId,
      lineNumber: invoiceLineItems.lineNumber,
      description: invoiceLineItems.description,
      quantity: invoiceLineItems.quantity,
      unitPrice: invoiceLineItems.unitPrice,
      amount: invoiceLineItems.amount,
    })
    .from(invoiceLineItems)
    .where(
      sql`${invoiceLineItems.invoiceId} IN (SELECT value FROM json_each(${JSON.stringify(invoiceIds)}))`,
    )
    .orderBy(
      asc(invoiceLineItems.invoiceId),
      asc(invoiceLineItems.lineNumber),
      asc(invoiceLineItems.sourceId),
    )
    .all();
}

export async function findInvoice(db: D1Database, invoiceId: string) {
  return (
    (await createDrizzle(db)
      .select(invoiceSummaryColumns)
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1)
      .get()) ?? null
  );
}
