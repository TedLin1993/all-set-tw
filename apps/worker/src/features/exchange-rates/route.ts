import type { Hono } from "hono";
import type { AppBindings } from "../../platform/env";
import { honoFactory } from "../../platform/hono";
import { jsonError } from "../../platform/http";
import {
  ExchangeRateProviderError,
  getExchangeRateCurrencies,
  getExchangeRates,
  refreshExchangeRates,
} from "./service";

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
    try {
      return c.json(await refreshExchangeRates(c.env.DB));
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
