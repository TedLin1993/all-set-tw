import { describe, expect, it, vi } from "vitest";
import {
  EXCHANGE_RATE_API_URL,
  ExchangeRateProviderError,
  refreshExchangeRates,
} from "../../../src/features/exchange-rates/service";

function createDb(results: unknown[] = []) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const batches: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return statement;
        },
        async all() {
          return { results };
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
      return [];
    },
  } as unknown as D1Database;
  return { db, calls, batches };
}

const providerPayload = {
  result: "success",
  base_code: "TWD",
  time_last_update_unix: 1_785_628_951,
  rates: {
    USD: 0.030952,
    JPY: 4.915215,
    EUR: 0.026897,
  },
};

describe("refreshExchangeRates", () => {
  it("converts the TWD-base response into the app's TWD rates", async () => {
    const { db, calls, batches } = createDb([
      {
        currency: "USD",
        rateTwd: 32.3076,
        updatedAt: "2026-08-02T00:02:31.000Z",
      },
      {
        currency: "JPY",
        rateTwd: 0.20345,
        updatedAt: "2026-08-02T00:02:31.000Z",
      },
      {
        currency: "EUR",
        rateTwd: 37.1796,
        updatedAt: "2026-08-02T00:02:31.000Z",
      },
    ]);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(providerPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await refreshExchangeRates(db, fetcher);

    expect(fetcher).toHaveBeenCalledWith(
      EXCHANGE_RATE_API_URL,
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(batches).toHaveLength(1);
    expect(
      calls
        .filter(({ sql }) => sql.includes("INSERT INTO exchange_rates"))
        .map(({ values }) => values.slice(0, 2)),
    ).toEqual([
      ["USD", 1 / providerPayload.rates.USD],
      ["JPY", 1 / providerPayload.rates.JPY],
      ["EUR", 1 / providerPayload.rates.EUR],
    ]);
    expect(calls[0]?.values[2]).toBe("2026-08-02T00:02:31.000Z");
  });

  it("does not write partial data when a required currency is missing", async () => {
    const { db, batches } = createDb();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...providerPayload,
          rates: {
            USD: providerPayload.rates.USD,
            JPY: providerPayload.rates.JPY,
          },
        }),
        { status: 200 },
      ),
    );

    await expect(refreshExchangeRates(db, fetcher)).rejects.toBeInstanceOf(
      ExchangeRateProviderError,
    );
    expect(batches).toHaveLength(0);
  });

  it("turns provider HTTP failures into a provider error", async () => {
    const { db, batches } = createDb();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 429 }));

    await expect(refreshExchangeRates(db, fetcher)).rejects.toBeInstanceOf(
      ExchangeRateProviderError,
    );
    expect(batches).toHaveLength(0);
  });
});
