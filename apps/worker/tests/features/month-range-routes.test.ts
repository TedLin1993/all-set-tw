import { describe, expect, it } from "vitest";
import type { Env } from "../../src/platform/env";
import { bankRoutes } from "../../src/features/bank/route";
import { invoiceRoutes } from "../../src/features/invoices/route";
import { investmentRoutes } from "../../src/features/investments/route";

function createDb() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          calls.push({ sql, values });
          return statement;
        },
        async all() {
          if (!values.length) calls.push({ sql, values });
          return { results: [] };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe("month-filtered resource APIs", () => {
  it("filters bank transactions by a single month without pagination", async () => {
    const { db, calls } = createDb();
    const response = await bankRoutes.request("/bank?month=2026-07", {}, {
      DB: db,
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accounts: [],
      transactions: [],
    });
    expect(
      calls.some(({ sql }) => sql.includes("COALESCE(txn.authorized_at")),
    ).toBe(true);
    expect(
      calls.some(({ values }) => values.join(",") === "2026-07-01,2026-08-01"),
    ).toBe(true);
  });

  it("filters credit-card bills by the same month boundary", async () => {
    const { db, calls } = createDb();
    const response = await bankRoutes.request("/bank/bills?month=2026-07", {}, {
      DB: db,
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(calls.some(({ sql }) => sql.includes("b.billing_period >="))).toBe(
      true,
    );
    expect(
      calls.some(({ values }) => values.join(",") === "2026-07-01,2026-08-01"),
    ).toBe(true);
  });

  it("accepts a bounded month range for invoices and investments", async () => {
    const invoiceDb = createDb();
    const invoiceResponse = await invoiceRoutes.request(
      "/invoices?from=2026-02&to=2026-07",
      {},
      { DB: invoiceDb.db } as Env,
    );
    expect(invoiceResponse.status).toBe(200);
    await expect(invoiceResponse.json()).resolves.toEqual([]);
    expect(
      invoiceDb.calls.some(
        ({ values }) => values.join(",") === "2026-02-01,2026-08-01",
      ),
    ).toBe(true);

    const investmentDb = createDb();
    const investmentResponse = await investmentRoutes.request(
      "/investment-transactions?from=2026-02&to=2026-07",
      {},
      { DB: investmentDb.db } as Env,
    );
    expect(investmentResponse.status).toBe(200);
    await expect(investmentResponse.json()).resolves.toEqual([]);
    expect(
      investmentDb.calls.some(
        ({ values }) => values.join(",") === "2026-02-01,2026-08-01",
      ),
    ).toBe(true);
  });

  it("rejects malformed or overly broad month ranges", async () => {
    const { db } = createDb();
    const malformed = await bankRoutes.request("/bank?month=2026-13", {}, {
      DB: db,
    } as Env);
    expect(malformed.status).toBe(400);

    const broad = await invoiceRoutes.request(
      "/invoices?from=2025-01&to=2026-07",
      {},
      { DB: db } as Env,
    );
    expect(broad.status).toBe(400);
  });
});
