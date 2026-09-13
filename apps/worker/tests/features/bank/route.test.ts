import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/platform/env";
import { bankCalculationRoutes } from "../../../src/features/bank/calculation-route";
import {
  isDefaultCalculationExcluded,
  resolveCalculationExclusion,
} from "../../../src/features/bank/calculation-service";

function createDb(transactionExists = true) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(query: string) {
      const sql = query.replaceAll('"', "").toUpperCase();
      let values: unknown[] = [];
      return {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          calls.push({ sql, values });
          return this;
        },
        async raw() {
          const row = await this.first();
          return row ? [Object.values(row)] : [];
        },
        async first() {
          return transactionExists ? { id: values[0] } : null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return { calls, db };
}

describe("bank transaction calculation preferences", () => {
  it("persists an excluded transaction independently from synced data", async () => {
    const { calls, db } = createDb();
    const response = await bankCalculationRoutes.request(
      "/bank/transactions/txn-1/calculation",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedFromCalculation: true }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      excludedFromCalculation: true,
    });
    expect(
      calls.some(({ sql }) =>
        sql.includes("INSERT INTO BANK_TRANSACTION_PREFERENCES"),
      ),
    ).toBe(true);
  });

  it("persists an include override when default calculation is restored", async () => {
    const { calls, db } = createDb();
    const response = await bankCalculationRoutes.request(
      "/bank/transactions/txn-1/calculation",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedFromCalculation: false }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(200);
    const preferenceWrite = calls.find(({ sql }) =>
      sql.includes("INSERT INTO BANK_TRANSACTION_PREFERENCES"),
    );
    expect(preferenceWrite?.values[1]).toBe(0);
  });

  it("rejects invalid bodies and unknown transactions", async () => {
    const invalid = await bankCalculationRoutes.request(
      "/bank/transactions/txn-1/calculation",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedFromCalculation: "yes" }),
      },
      { DB: createDb().db } as Env,
    );
    expect(invalid.status).toBe(400);

    const missing = await bankCalculationRoutes.request(
      "/bank/transactions/missing/calculation",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedFromCalculation: true }),
      },
      { DB: createDb(false).db } as Env,
    );
    expect(missing.status).toBe(404);
  });
});

describe("default calculation exclusions", () => {
  it.each([
    "台新卡費林子鑑",
    "信用卡繳款",
    "繳信用卡",
    "繳卡款",
    "信用卡還款",
    "信用卡自扣",
    "信用卡自動扣繳",
    "信用卡扣款",
    "CARD PAYMENT",
    "Credit Card Payment",
  ])("excludes high-confidence card payment text: %s", (description) => {
    expect(isDefaultCalculationExcluded({ description })).toBe(true);
  });

  it.each(["繳款入帳", "自扣已入帳", "PAYMENT RECEIVED"])(
    "only applies card-account payment text to credit accounts: %s",
    (description) => {
      expect(
        isDefaultCalculationExcluded({ accountType: "credit", description }),
      ).toBe(true);
      expect(
        isDefaultCalculationExcluded({ accountType: "checking", description }),
      ).toBe(false);
    },
  );

  it.each([
    "水費自扣",
    "電費扣款",
    "一般繳費",
    "帳單",
    "轉帳",
    "轉出",
    "DISCARD PAYMENT",
  ])("keeps broad payment text included: %s", (description) => {
    expect(isDefaultCalculationExcluded({ description })).toBe(false);
  });

  it("lets explicit user preferences override the defaults", () => {
    expect(
      resolveCalculationExclusion({
        description: "信用卡繳款",
        calculationPreference: 0,
      }),
    ).toBe(false);
    expect(
      resolveCalculationExclusion({
        description: "一般消費",
        calculationPreference: 1,
      }),
    ).toBe(true);
  });

  it("applies rule exclusions unless the transaction has an explicit preference", () => {
    expect(
      resolveCalculationExclusion({
        description: "永豐自扣已入帳，謝謝！",
        classificationExcludedFromCalculation: true,
      }),
    ).toBe(true);
    expect(
      resolveCalculationExclusion({
        description: "永豐自扣已入帳，謝謝！",
        classificationExcludedFromCalculation: true,
        calculationPreference: 0,
      }),
    ).toBe(false);
  });
});
