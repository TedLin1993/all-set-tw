import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import {
  encodePageCursor,
  parseKeysetPagination,
  setKeysetPaginationHeaders,
} from "../../platform/http";
import {
  monthRangeQuerySchema,
  resolveMonthDateRange,
} from "../../platform/month-range";
import { validationHook } from "../../platform/validation";
import {
  getBankPage,
  getBankRange,
  getCreditCardBillPage,
  getCreditCardBillsRange,
} from "./service";

const transactionPageCursorSchema = z.object({
  effectiveDate: z.string(),
  updatedAt: z.string(),
  id: z.string(),
});

const creditCardBillPageCursorSchema = z.object({
  billingPeriod: z.string(),
  accountId: z.string(),
  id: z.string(),
});

export const bankRoutes = honoFactory.createApp();
registerBankRoutes(bankRoutes);

function registerBankRoutes(api: Hono<AppBindings>) {
  api.get(
    "/bank",
    zValidator(
      "query",
      monthRangeQuerySchema,
      validationHook("INVALID_REQUEST", "Invalid month range."),
    ),
    async (c) => {
      const range = resolveMonthDateRange(c.req.valid("query"));
      if (range) return c.json(await getBankRange(c.env.DB, range));

      const { limit, cursor } = parseKeysetPagination(
        c.req.query(),
        transactionPageCursorSchema,
        100,
      );
      const page = await getBankPage(c.env.DB, limit, cursor);
      setKeysetPaginationHeaders((name, value) => c.header(name, value), {
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && page.last
            ? encodePageCursor({
                effectiveDate: page.last.effectiveDate,
                updatedAt: page.last.updatedAt,
                id: page.last.id,
              })
            : undefined,
      });
      return c.json({
        accounts: page.accounts,
        transactions: page.transactions,
      });
    },
  );

  api.get(
    "/bank/bills",
    zValidator(
      "query",
      monthRangeQuerySchema,
      validationHook("INVALID_REQUEST", "Invalid month range."),
    ),
    async (c) => {
      const range = resolveMonthDateRange(c.req.valid("query"));
      if (range) return c.json(await getCreditCardBillsRange(c.env.DB, range));

      const { limit, cursor } = parseKeysetPagination(
        c.req.query(),
        creditCardBillPageCursorSchema,
        50,
      );
      const page = await getCreditCardBillPage(c.env.DB, limit, cursor);
      setKeysetPaginationHeaders((name, value) => c.header(name, value), {
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && page.last
            ? encodePageCursor({
                billingPeriod: page.last.billingPeriod,
                accountId: page.last.accountId,
                id: page.last.id,
              })
            : undefined,
      });
      return c.json(page.bills);
    },
  );
}
