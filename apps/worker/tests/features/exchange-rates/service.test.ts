import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  bankAccounts,
  bankBalanceSnapshots,
  createDrizzle,
  exchangeRates,
  investmentPositions,
  manualAssets,
  netWorthHistory,
} from "../../../src/db";
import {
  ExchangeRateProviderError,
  getExchangeRateCurrencies,
  getExchangeRates,
  refreshExchangeRates,
} from "../../../src/features/exchange-rates/service";

const now = "2026-10-08T00:00:00.000Z";
const providerUpdatedAt = "2026-10-08T01:00:00.000Z";

function providerFetcher(
  extraRates: Record<string, number> = {},
): typeof fetch {
  return async () =>
    Response.json({
      result: "success",
      base_code: "TWD",
      time_last_update_unix: Date.parse(providerUpdatedAt) / 1000,
      rates: { TWD: 1, USD: 1 / 32, JPY: 5, EUR: 1 / 36, ...extraRates },
    });
}

describe("資產幣別匯率與更新完整性（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    const db = harness.binding;
    await db.batch([
      db.prepare("DROP TRIGGER IF EXISTS fail_exchange_rate"),
      ...[
        "bank_balance_snapshots",
        "bank_accounts",
        "investment_positions",
        "net_worth_history",
        "manual_assets",
        "exchange_rates",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    ]);
  });

  async function seedBankBalance(currency: string, balance: number) {
    const database = createDrizzle(harness.binding);
    await database.batch([
      database.insert(bankAccounts).values({
        id: currency,
        connectorId: "test",
        sourceId: currency,
        currency,
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(bankBalanceSnapshots).values({
        id: currency,
        connectorId: "test",
        sourceId: currency,
        accountId: currency,
        currency,
        balance,
        asOfAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  }

  it("取得非零帳戶、目前投資及手動資產匯率，保留小數並排除零金額與無效幣別", async () => {
    const db = harness.binding;
    const database = createDrizzle(db);
    await database.batch([
      database.insert(bankAccounts).values(
        [
          { id: "hkd", currency: "HKD" },
          { id: "twd", currency: "TWD" },
          { id: "inactive", currency: "AUD", inactiveAt: now },
          { id: "duplicate", currency: "SGD", canonicalAccountId: "hkd" },
          { id: "fractional", currency: "CAD" },
          { id: "zero", currency: "NZD" },
          { id: "invalid", currency: "NAN" },
        ].map((account) => ({
          ...account,
          connectorId: "test",
          sourceId: account.id,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      database.insert(bankBalanceSnapshots).values(
        [
          { id: "hkd", currency: "HKD", balance: 100 },
          { id: "twd", currency: "TWD", balance: 100 },
          { id: "inactive", currency: "AUD", balance: 100 },
          { id: "duplicate", currency: "SGD", balance: 100 },
          { id: "fractional", currency: "CAD", balance: 0.03 },
          { id: "zero", currency: "NZD", balance: 0 },
          { id: "invalid", currency: "NAN", balance: 100 },
        ].map((balance) => ({
          ...balance,
          connectorId: "test",
          sourceId: balance.id,
          accountId: balance.id,
          asOfAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      database.insert(investmentPositions).values(
        [
          { id: "old", currency: "AUD", asOfDate: "2026-10-07" },
          { id: "current", currency: "CHF", asOfDate: "2026-10-08" },
        ].map((position) => ({
          ...position,
          connectorId: "test",
          sourceId: "position",
          assetType: "stock",
          name: "外幣持倉",
          marketValue: 50,
          createdAt: now,
          updatedAt: now,
        })),
      ),
      database.insert(manualAssets).values({
        id: "manual",
        name: "外幣資產",
        category: "other",
        currency: "GBP",
        createdAt: now,
      }),
      database.insert(netWorthHistory).values({
        id: "manual-value",
        source: "manual",
        assetType: "manual",
        netWorth: 10,
        date: "2026-10-08",
        snapshottedAt: now,
      }),
      database.insert(exchangeRates).values({
        currency: "CAD",
        rateToTwd: 23,
        updatedAt: now,
      }),
    ]);

    expect(await getExchangeRateCurrencies(db)).toEqual([
      "USD",
      "JPY",
      "EUR",
      "CAD",
      "CHF",
      "GBP",
      "HKD",
    ]);
    const rates = await refreshExchangeRates(
      db,
      providerFetcher({
        HKD: 0.25,
        CHF: 0.5,
        GBP: 0.025,
        CAD: 0.04,
        AUD: 0.1,
        SGD: 0.1,
        NAN: 0.25,
        NZD: 0.05,
      }),
    );
    expect(rates.map((rate) => rate.currency)).toEqual([
      "USD",
      "JPY",
      "EUR",
      "CAD",
      "CHF",
      "GBP",
      "HKD",
    ]);
    const rateValues = Object.fromEntries(
      rates.map((rate) => [rate.currency, rate.rateTwd]),
    );
    expect(rateValues).toEqual({
      USD: 32,
      JPY: 0.2,
      EUR: 36,
      CAD: 25,
      CHF: 2,
      GBP: 40,
      HKD: 4,
    });
    expect(
      100 * rateValues.HKD! + 50 * rateValues.CHF! + 10 * rateValues.GBP!,
    ).toBe(900);
    expect(rates.every((rate) => rate.updatedAt === providerUpdatedAt)).toBe(
      true,
    );
    expect(await getExchangeRates(db)).toEqual(rates);
  });

  it("來源未提供額外幣別時保留原匯率並繼續更新其他幣別", async () => {
    const db = harness.binding;
    const database = createDrizzle(db);
    await seedBankBalance("HKD", 100);
    await database.batch([
      database.insert(bankAccounts).values({
        id: "unsupported",
        connectorId: "test",
        sourceId: "unsupported",
        currency: "NAN",
        createdAt: now,
        updatedAt: now,
      }),
      database.insert(exchangeRates).values([
        { currency: "USD", rateToTwd: 30, updatedAt: now },
        { currency: "HKD", rateToTwd: 4, updatedAt: now },
      ]),
    ]);

    const rates = await refreshExchangeRates(db, providerFetcher());
    expect(rates.find((rate) => rate.currency === "USD")?.rateTwd).toBe(32);
    expect(rates.find((rate) => rate.currency === "HKD")).toEqual({
      currency: "HKD",
      rateTwd: 4,
      updatedAt: now,
    });
    expect(rates.some((rate) => rate.currency === "NAN")).toBe(false);
  });

  it("來源無效或匯率批次寫入失敗時保留整份原匯率", async () => {
    const db = harness.binding;
    await seedBankBalance("HKD", -100);
    await createDrizzle(db)
      .insert(exchangeRates)
      .values([
        { currency: "USD", rateToTwd: 30, updatedAt: now },
        { currency: "HKD", rateToTwd: 3, updatedAt: now },
      ]);
    const before = await getExchangeRates(db);
    await expect(
      refreshExchangeRates(db, providerFetcher({ HKD: 0 })),
    ).rejects.toBeInstanceOf(ExchangeRateProviderError);
    expect(await getExchangeRates(db)).toEqual(before);

    await db
      .prepare(
        "CREATE TRIGGER fail_exchange_rate BEFORE UPDATE ON exchange_rates WHEN NEW.currency = 'HKD' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      )
      .run();
    await expect(
      refreshExchangeRates(db, providerFetcher({ HKD: 0.25 })),
    ).rejects.toThrow();
    expect(await getExchangeRates(db)).toEqual(before);
  });
});
