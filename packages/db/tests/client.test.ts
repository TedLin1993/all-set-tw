import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../src/client";
import { connectorSettings, exchangeRates } from "../src/schema";
import { createTestD1 } from "../testing/d1";

describe("Drizzle D1 client", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;

  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  beforeEach(async () => {
    await harness.binding.batch([
      harness.binding.prepare("DELETE FROM exchange_rates"),
      harness.binding.prepare("DELETE FROM connector_settings"),
    ]);
  });

  it("selects aliases, preserves nulls, and upserts a row", async () => {
    const db = createDb(harness.binding);
    await db.insert(connectorSettings).values({
      id: "settings-1",
      connectorId: "einvoice",
      encryptedConfig: "encrypted",
      publicConfig: null,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
    await db
      .insert(exchangeRates)
      .values({
        currency: "USD",
        rateToTwd: 30,
        updatedAt: "2026-09-12T00:00:00.000Z",
      })
      .onConflictDoUpdate({
        target: exchangeRates.currency,
        set: {
          rateToTwd: 32,
          updatedAt: "2026-09-12T01:00:00.000Z",
        },
      });
    await db
      .insert(exchangeRates)
      .values({
        currency: "USD",
        rateToTwd: 31,
        updatedAt: "2026-09-12T00:30:00.000Z",
      })
      .onConflictDoUpdate({
        target: exchangeRates.currency,
        set: {
          rateToTwd: 32,
          updatedAt: "2026-09-12T01:00:00.000Z",
        },
      });

    const [settings] = await db
      .select({
        connector: connectorSettings.connectorId,
        publicConfig: connectorSettings.publicConfig,
      })
      .from(connectorSettings)
      .where(eq(connectorSettings.connectorId, "einvoice"))
      .all();
    const [rate] = await db
      .select({
        code: sql<string>`${exchangeRates.currency}`,
        rateTwd: exchangeRates.rateToTwd,
        updatedAt: exchangeRates.updatedAt,
      })
      .from(exchangeRates)
      .all();

    expect(settings).toEqual({
      connector: "einvoice",
      publicConfig: null,
    });
    expect(rate).toEqual({
      code: "USD",
      rateTwd: 32,
      updatedAt: "2026-09-12T01:00:00.000Z",
    });
  });

  it("rolls back a D1 batch when a later statement fails", async () => {
    const db = createDb(harness.binding);
    await db.insert(exchangeRates).values({
      currency: "USD",
      rateToTwd: 30,
      updatedAt: "2026-09-12T00:00:00.000Z",
    });

    await expect(
      db.batch([
        db.insert(exchangeRates).values({
          currency: "JPY",
          rateToTwd: 0.2,
          updatedAt: "2026-09-12T00:00:00.000Z",
        }),
        db.insert(exchangeRates).values({
          currency: "USD",
          rateToTwd: 31,
          updatedAt: "2026-09-12T00:00:00.000Z",
        }),
      ]),
    ).rejects.toThrow();

    const rows = await db
      .select({
        currency: sql<string>`${exchangeRates.currency}`,
        rateTwd: exchangeRates.rateToTwd,
      })
      .from(exchangeRates)
      .all();
    expect(rows).toEqual([{ currency: "USD", rateTwd: 30 }]);
  });
});
