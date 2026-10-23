import type { Hono } from "hono";
import type {
  BankAccountResponse,
  BankDataResponse,
  CreditCardBillResponse,
  PaymentAccountInput,
} from "@taiwan-fin-hub/shared";
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
  clearPaymentAccount,
  getBankAccounts,
  getBankPage,
  getBankRange,
  getCreditCardBillPage,
  getCreditCardBillsRange,
  setPaymentAccount,
} from "./service";
import {
  BankAccountNotFoundError,
  InvalidPaymentAccountError,
} from "./payment-accounts";

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

const paymentAccountSchema = z.object({
  paymentAccountId: z.string().min(1).max(256).nullable(),
});

function paymentAccountError(error: unknown) {
  if (error instanceof BankAccountNotFoundError)
    return jsonError("BANK_ACCOUNT_NOT_FOUND", "找不到信用卡或貸款帳戶。", 404);
  if (error instanceof InvalidPaymentAccountError)
    return jsonError(
      "INVALID_PAYMENT_ACCOUNT",
      "扣款帳戶須為同幣別或台幣的存款帳戶。",
      400,
    );
  throw error;
}

export const bankRoutes = honoFactory.createApp();
registerBankRoutes(bankRoutes);

function registerBankRoutes(api: Hono<AppBindings>) {
  // Pages that only show balances skip transaction classification.
  api.get("/bank/accounts", async (c) =>
    c.json((await getBankAccounts(c.env.DB)) satisfies BankAccountResponse[]),
  );

  api.put(
    "/bank/accounts/:id/payment-account",
    zValidator(
      "json",
      paymentAccountSchema,
      validationHook("INVALID_REQUEST", "Payment account is invalid."),
    ),
    async (c) => {
      try {
        const input = c.req.valid("json") satisfies PaymentAccountInput;
        await setPaymentAccount(
          c.env.DB,
          c.req.param("id"),
          input.paymentAccountId,
        );
        return c.json({ success: true });
      } catch (error) {
        return paymentAccountError(error);
      }
    },
  );

  api.delete("/bank/accounts/:id/payment-account", async (c) => {
    try {
      await clearPaymentAccount(c.env.DB, c.req.param("id"));
      return c.json({ success: true });
    } catch (error) {
      return paymentAccountError(error);
    }
  });

  api.get(
    "/bank",
    zValidator(
      "query",
      monthRangeQuerySchema,
      validationHook("INVALID_REQUEST", "Invalid month range."),
    ),
    async (c) => {
      const range = resolveMonthDateRange(c.req.valid("query"));
      if (range)
        return c.json(
          (await getBankRange(c.env.DB, range)) satisfies BankDataResponse,
        );

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
      } satisfies BankDataResponse);
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
      if (range)
        return c.json(
          (await getCreditCardBillsRange(
            c.env.DB,
            range,
          )) satisfies CreditCardBillResponse[],
        );

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
      return c.json(page.bills satisfies CreditCardBillResponse[]);
    },
  );
}
