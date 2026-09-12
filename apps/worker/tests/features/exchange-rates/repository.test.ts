import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listExchangeRates,
  replaceExchangeRates,
} from "../../../src/features/exchange-rates/repository";
import { createTestD1 } from "../../../../../packages/db/testing/d1";

describe("exchange-rates repository", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;

  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await harness.binding.prepare("DELETE FROM exchange_rates").run();
  });

  it("lists supported currencies in USD, JPY, EUR order", async () => {
    await replaceExchangeRates(
      harness.binding,
      [
        { currency: "EUR", rate: 37 },
        { currency: "USD", rate: 32 },
        { currency: "JPY", rate: 0.2 },
      ],
      "2026-09-12T00:00:00.000Z",
    );
    await harness.binding
      .prepare(
        `INSERT INTO exchange_rates (currency, rate_to_twd, updated_at)
         VALUES ('GBP', 40, '2026-09-12T00:00:00.000Z')`,
      )
      .run();

    await expect(listExchangeRates(harness.binding)).resolves.toEqual([
      {
        currency: "USD",
        rateTwd: 32,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
      {
        currency: "JPY",
        rateTwd: 0.2,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
      {
        currency: "EUR",
        rateTwd: 37,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ]);
  });

  it("replaces the full rate set in one batch", async () => {
    await replaceExchangeRates(
      harness.binding,
      [{ currency: "USD", rate: 30 }],
      "2026-09-11T00:00:00.000Z",
    );
    await replaceExchangeRates(
      harness.binding,
      [
        { currency: "USD", rate: 32 },
        { currency: "JPY", rate: 0.2 },
        { currency: "EUR", rate: 37 },
      ],
      "2026-09-12T00:00:00.000Z",
    );

    await expect(listExchangeRates(harness.binding)).resolves.toEqual([
      {
        currency: "USD",
        rateTwd: 32,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
      {
        currency: "JPY",
        rateTwd: 0.2,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
      {
        currency: "EUR",
        rateTwd: 37,
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ]);
  });

  it("keeps previous rows when a later insert in the replace batch fails", async () => {
    await replaceExchangeRates(
      harness.binding,
      [{ currency: "USD", rate: 30 }],
      "2026-09-11T00:00:00.000Z",
    );

    await expect(
      replaceExchangeRates(
        harness.binding,
        [
          { currency: "JPY", rate: 0.2 },
          { currency: "USD", rate: 32 },
          { currency: "USD", rate: 33 },
        ],
        "2026-09-12T00:00:00.000Z",
      ),
    ).rejects.toThrow();

    await expect(listExchangeRates(harness.binding)).resolves.toEqual([
      {
        currency: "USD",
        rateTwd: 30,
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ]);
  });

  it("deletes cached rates when asked to replace with an empty list", async () => {
    await replaceExchangeRates(
      harness.binding,
      [{ currency: "USD", rate: 30 }],
      "2026-09-11T00:00:00.000Z",
    );
    await replaceExchangeRates(harness.binding, [], "2026-09-12T00:00:00.000Z");
    await expect(listExchangeRates(harness.binding)).resolves.toEqual([]);
  });
});
