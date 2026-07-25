import type { ConnectorId } from "@taiwan-fin-hub/core";
import type { MonthDateRange } from "../../platform/month-range";

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
  const cursorClause = cursor
    ? "WHERE (invoice_date, updated_at, id) < (?, ?, ?)"
    : "";
  const statement = db.prepare(
    `SELECT
      id,
      connector_id AS connectorId,
      source_id AS sourceId,
      invoice_number AS invoiceNumber,
      invoice_date AS invoiceDate,
      seller_name AS sellerName,
      amount,
      updated_at AS updatedAt
    FROM invoices
    ${cursorClause}
    ORDER BY invoice_date DESC, updated_at DESC, id DESC
    LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(cursor.invoiceDate, cursor.updatedAt, cursor.id, limit)
      : statement.bind(limit)
  ).all<InvoiceRow>();
  return rows.results;
}

export async function listInvoicesInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  const rows = await db
    .prepare(
      `SELECT
      id,
      connector_id AS connectorId,
      source_id AS sourceId,
      invoice_number AS invoiceNumber,
      invoice_date AS invoiceDate,
      seller_name AS sellerName,
      amount,
      updated_at AS updatedAt
    FROM invoices
    WHERE invoice_date >= ? AND invoice_date < ?
    ORDER BY invoice_date DESC, updated_at DESC, id DESC`,
    )
    .bind(range.from, range.to)
    .all<InvoiceRow>();
  return rows.results;
}

export async function listInvoiceItems(db: D1Database, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return [];
  const placeholders = invoiceIds.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT
      id,
      invoice_id AS invoiceId,
      source_id AS sourceId,
      line_number AS lineNumber,
      description,
      quantity,
      unit_price AS unitPrice,
      amount
    FROM invoice_line_items
    WHERE invoice_id IN (${placeholders})
    ORDER BY invoice_id ASC, line_number ASC, source_id ASC`,
    )
    .bind(...invoiceIds)
    .all<InvoiceItemRow>();
  return rows.results;
}

export async function findInvoice(db: D1Database, invoiceId: string) {
  return db
    .prepare(
      `SELECT
      id,
      connector_id AS connectorId,
      source_id AS sourceId,
      invoice_number AS invoiceNumber,
      invoice_date AS invoiceDate,
      seller_name AS sellerName,
      amount
    FROM invoices
    WHERE id = ?`,
    )
    .bind(invoiceId)
    .first<Omit<InvoiceRow, "updatedAt">>();
}
