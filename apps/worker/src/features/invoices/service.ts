import {
  findInvoice,
  listInvoiceItems,
  listInvoices,
  listInvoicesInRange,
  type InvoicePageCursor,
  type InvoiceRow,
} from "./repository";
import type { MonthDateRange } from "../../platform/month-range";

export class InvoiceNotFoundError extends Error {}

export async function getInvoicePage(
  db: D1Database,
  limit: number,
  cursor?: InvoicePageCursor,
) {
  const rows = await listInvoices(db, limit + 1, cursor);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    hasMore,
    last: page.at(-1),
    invoices: page.map(presentInvoiceSummary),
  };
}

export async function getInvoicesRange(db: D1Database, range: MonthDateRange) {
  const rows = await listInvoicesInRange(db, range);
  return rows.map(presentInvoiceSummary);
}

export async function getInvoiceDetail(db: D1Database, invoiceId: string) {
  const invoice = await findInvoice(db, invoiceId);
  if (!invoice) throw new InvoiceNotFoundError();
  const items = await listInvoiceItems(db, [invoiceId]);
  return presentInvoice(
    invoice,
    items.map(({ invoiceId: _invoiceId, ...item }) => item),
  );
}

function presentInvoice<T extends Omit<InvoiceRow, "updatedAt"> | InvoiceRow>(
  invoice: T,
  items: unknown[],
) {
  return {
    ...presentInvoiceSummary(invoice),
    items,
  };
}

function presentInvoiceSummary<
  T extends Omit<InvoiceRow, "updatedAt"> | InvoiceRow,
>(invoice: T) {
  const { updatedAt: _updatedAt, ...presented } = invoice as InvoiceRow;
  return {
    ...presented,
    invoiceNumber: invoice.invoiceNumber ?? undefined,
    sellerName: invoice.sellerName ?? undefined,
  };
}
