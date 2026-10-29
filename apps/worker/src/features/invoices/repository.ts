import type { ConnectorId } from "@taiwan-fin-hub/shared";
import { createDrizzle, invoiceLineItems, invoices } from "../../db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { MonthDateRange } from "../../platform/month-range";

// Taipei calendar day for precise timestamps; date-only TEXT stays unchanged.
const invoiceDay = sql`CASE WHEN length(${invoices.invoiceDate}) > 10
  THEN COALESCE(date(${invoices.invoiceDate}, '+8 hours'), substr(${invoices.invoiceDate}, 1, 10))
  ELSE ${invoices.invoiceDate} END`;

/**
 * Taipei-day range on invoices. The raw invoice_date bounds widen by one day
 * on each side (covering any UTC offset) so idx_invoices_page can narrow the
 * scan before the exact day expression is evaluated.
 */
export function invoiceDayInRange(range: MonthDateRange) {
  return and(
    sql`${invoices.invoiceDate} >= date(${range.from}, '-1 day')`,
    sql`${invoices.invoiceDate} < date(${range.to}, '+1 day')`,
    sql`(${invoiceDay}) >= ${range.from}`,
    sql`(${invoiceDay}) < ${range.to}`,
  );
}

const invoiceSummaryColumns = {
  id: invoices.id,
  connectorId: sql<ConnectorId>`${invoices.connectorId}`,
  sourceId: invoices.sourceId,
  invoiceNumber: invoices.invoiceNumber,
  invoiceDate: invoices.invoiceDate,
  sellerName: invoices.sellerName,
  amount: invoices.amount,
  excludedFromCalculation:
    sql<boolean>`${invoices.excludedFromCalculation} = 1`.mapWith(Boolean),
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
  excludedFromCalculation: boolean;
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
        : invoiceDayInRange(range),
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

/**
 * Leaves updated_at alone: it is the page cursor and the AI scan watermark,
 * and tracks source data rather than this user preference.
 */
export async function updateInvoiceCalculationExclusion(
  db: D1Database,
  invoiceId: string,
  excludedFromCalculation: boolean,
) {
  const result = await createDrizzle(db)
    .update(invoices)
    .set({ excludedFromCalculation: excludedFromCalculation ? 1 : 0 })
    .where(eq(invoices.id, invoiceId))
    .run();
  return result.meta.changes === 1;
}
