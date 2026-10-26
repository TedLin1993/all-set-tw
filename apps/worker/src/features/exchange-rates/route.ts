import type { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import {
  ExchangeRateProviderError,
  getExchangeRateCurrencies,
  getExchangeRates,
  refreshExchangeRates,
} from "./service";

const refreshBodySchema = z.object({
  currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .max(10)
    .optional(),
});

export const exchangeRateRoutes = honoFactory.createApp();
registerExchangeRateRoutes(exchangeRateRoutes);

function registerExchangeRateRoutes(api: Hono<AppBindings>) {
  api.get("/exchange-rates", async (c) =>
    c.json(await getExchangeRates(c.env.DB)),
  );

  api.get("/exchange-rates/currencies", async (c) =>
    c.json(await getExchangeRateCurrencies(c.env.DB)),
  );

  api.post("/exchange-rates/refresh", async (c) => {
    // body 為選用：沒帶（或空字串）時與原本行為相同。
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        return jsonError("INVALID_REQUEST_BODY", "Request body is not JSON.");
      }
    }
    const parsed = refreshBodySchema.safeParse(body);
    if (!parsed.success)
      return jsonError(
        "INVALID_REQUEST",
        "Exchange rate refresh request is invalid.",
      );
    try {
      return c.json(
        await refreshExchangeRates(c.env.DB, fetch, parsed.data.currencies),
      );
    } catch (error) {
      if (error instanceof ExchangeRateProviderError) {
        return jsonError(
          "EXCHANGE_RATE_PROVIDER_UNAVAILABLE",
          "匯率資料來源暫時無法取得，請稍後再試。",
          502,
        );
      }
      throw error;
    }
  });
}
