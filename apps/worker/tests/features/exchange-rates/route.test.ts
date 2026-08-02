import { describe, expect, it, vi } from "vitest";
import { exchangeRateRoutes } from "../../../src/features/exchange-rates/route";
import type { Env } from "../../../src/platform/env";

function envWithDb() {
  const db = {
    prepare() {
      const statement = {
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { DB: db } as Env;
}

describe("exchange rate routes", () => {
  it("returns the cached supported exchange rates", async () => {
    const response = await exchangeRateRoutes.request(
      "/exchange-rates",
      {},
      envWithDb(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
  });

  it("returns a provider error when a manual refresh cannot fetch rates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable")),
    );

    try {
      const response = await exchangeRateRoutes.request(
        "/exchange-rates/refresh",
        { method: "POST" },
        envWithDb(),
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "EXCHANGE_RATE_PROVIDER_UNAVAILABLE" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
