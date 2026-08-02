import { z } from "zod";
import {
  listExchangeRates,
  SUPPORTED_EXCHANGE_CURRENCIES,
  upsertExchangeRates,
} from "./repository";

export const EXCHANGE_RATE_API_URL = "https://open.er-api.com/v6/latest/TWD";

const PROVIDER_TIMEOUT_MS = 10_000;

const providerResponseSchema = z.object({
  result: z.literal("success"),
  base_code: z.literal("TWD"),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.string(), z.number().finite()),
});

export class ExchangeRateProviderError extends Error {
  constructor(message = "Exchange rate provider is unavailable.") {
    super(message);
    this.name = "ExchangeRateProviderError";
  }
}

export function getExchangeRates(db: D1Database) {
  return listExchangeRates(db);
}

export async function refreshExchangeRates(
  db: D1Database,
  fetcher: typeof fetch = fetch,
) {
  const provider = await fetchProviderRates(fetcher);
  const rates = SUPPORTED_EXCHANGE_CURRENCIES.map((currency) => {
    const providerRate = provider.rates[currency];
    if (typeof providerRate !== "number" || !Number.isFinite(providerRate)) {
      throw new ExchangeRateProviderError(
        `Exchange rate provider did not return ${currency}.`,
      );
    }
    if (providerRate <= 0) {
      throw new ExchangeRateProviderError(
        `Exchange rate provider returned an invalid ${currency} rate.`,
      );
    }
    return { currency, rate: 1 / providerRate };
  });

  await upsertExchangeRates(
    db,
    rates,
    new Date(provider.timeLastUpdateUnix * 1000).toISOString(),
  );
  return listExchangeRates(db);
}

async function fetchProviderRates(fetcher: typeof fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(EXCHANGE_RATE_API_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      throw new ExchangeRateProviderError();
    }

    if (!response.ok) {
      throw new ExchangeRateProviderError(
        `Exchange rate provider returned HTTP ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ExchangeRateProviderError(
        "Exchange rate provider returned invalid JSON.",
      );
    }

    const parsed = providerResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExchangeRateProviderError(
        "Exchange rate provider returned an invalid response.",
      );
    }

    return {
      rates: parsed.data.rates,
      timeLastUpdateUnix: parsed.data.time_last_update_unix,
    };
  } finally {
    clearTimeout(timeout);
  }
}
