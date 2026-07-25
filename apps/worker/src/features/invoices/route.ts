import type { Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import {
  encodePageCursor,
  jsonError,
  parseKeysetPagination,
  setKeysetPaginationHeaders,
} from "../../platform/http";
import {
  monthRangeQuerySchema,
  resolveMonthDateRange,
} from "../../platform/month-range";
import { validationHook } from "../../platform/validation";
import {
  getInvoiceDetail,
  getInvoicePage,
  getInvoicesRange,
  InvoiceNotFoundError,
} from "./service";

const invoicePageCursorSchema = z.object({
  invoiceDate: z.string(),
  updatedAt: z.string(),
  id: z.string(),
});

export const invoiceRoutes = honoFactory.createApp();
registerInvoiceRoutes(invoiceRoutes);

function registerInvoiceRoutes(api: Hono<AppBindings>) {
  api.get(
    "/invoices",
    zValidator(
      "query",
      monthRangeQuerySchema,
      validationHook("INVALID_REQUEST", "Invalid month range."),
    ),
    async (c) => {
      const range = resolveMonthDateRange(c.req.valid("query"));
      if (range) return c.json(await getInvoicesRange(c.env.DB, range));

      const { limit, cursor } = parseKeysetPagination(
        c.req.query(),
        invoicePageCursorSchema,
        50,
      );
      const page = await getInvoicePage(c.env.DB, limit, cursor);
      setKeysetPaginationHeaders((name, value) => c.header(name, value), {
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && page.last
            ? encodePageCursor({
                invoiceDate: page.last.invoiceDate,
                updatedAt: page.last.updatedAt,
                id: page.last.id,
              })
            : undefined,
      });
      return c.json(page.invoices);
    },
  );

  api.get("/invoice-detail", async (c) => {
    const invoiceId = c.req.query("invoiceId");
    if (!invoiceId)
      return jsonError(
        "INVALID_REQUEST",
        "invoiceId query parameter is required.",
      );
    return invoiceDetailResponse(c, invoiceId);
  });

  api.get("/invoices/:invoiceId", async (c) =>
    invoiceDetailResponse(c, c.req.param("invoiceId")),
  );
}

async function invoiceDetailResponse(
  c: Context<AppBindings>,
  invoiceId: string,
) {
  try {
    return c.json(await getInvoiceDetail(c.env.DB, invoiceId));
  } catch (error) {
    if (error instanceof InvoiceNotFoundError) {
      return jsonError("INVOICE_NOT_FOUND", "Invoice was not found.", 404);
    }
    throw error;
  }
}
