import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { activityRoutes } from "../../../src/features/activity/route";
import { searchActivity } from "../../../src/features/activity/search-service";
import { findActivitySearchDays } from "../../../src/features/activity/search-repository";
import { honoFactory } from "../../../src/platform/hono";
import { apiErrorResponse } from "../../../src/platform/http";
import type { Env } from "../../../src/platform/env";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const directory = fileURLToPath(
    new URL("../../../../../packages/db/migrations/", import.meta.url),
  );
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    database.exec(readFileSync(`${directory}/${file}`, "utf8"));
  database.exec(`
    INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
    VALUES ('card', 'ctbc', 'card', 'credit', 'TWD', '2026-01-01', '2026-01-01');
    INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, authorized_at, description, amount, currency, status, created_at, updated_at)
    VALUES ('recent', 'ctbc', 'card', 'recent', '2026-09-01', '2026-08-31T16:30:00Z', 'AIRBNB', -1000, 'TWD', 'posted', '2026-09-01', '2026-09-01'),
    ('old', 'ctbc', 'card', 'old', '2024-06-15', NULL, 'Airbnb stay', -1000, 'TWD', 'posted', '2024-06-15', '2024-06-15'),
    ('paired', 'ctbc', 'card', 'paired', '2023-02-12', NULL, 'Payment provider', -2000, 'TWD', 'posted', '2023-02-12', '2023-02-12');
    INSERT INTO invoices (id, connector_id, source_id, invoice_date, seller_name, amount, created_at, updated_at)
    VALUES ('invoice', 'einvoice', 'invoice', '2023-02-12', 'Airbnb invoice', 2000, '2023-02-12', '2023-02-12');
  `);
  const queries: string[] = [];
  const db = {
    prepare(sql: string) {
      queries.push(sql);
      let values: unknown[] = [];
      const result = {
        bind(...args: unknown[]) {
          values = args;
          return result;
        },
        async all() {
          return { results: database.prepare(sql).all(...(values as never[])) };
        },
        async first() {
          return database.prepare(sql).get(...(values as never[])) ?? null;
        },
      };
      return result;
    },
  } as unknown as D1Database;
  return { db, database, queries };
}

describe("global activity search", () => {
  it("returns cross-year matched activities in a single batch and preserves pairing", async () => {
    const { db, queries } = fixture();
    const page = await searchActivity(db, { q: "airbnb" });
    expect(page.items.map((i) => i.id)).toEqual(["recent", "old", "paired"]);
    expect(page.items.at(-1)?.invoiceId).toBe("invoice");
    expect(page.nextCursor).toBeNull();
    expect(
      queries.filter((sql) => sql.includes("WITH candidates")),
    ).toHaveLength(1);
    expect(
      queries.filter((sql) => sql.includes("LEFT JOIN bank_balance_snapshots")),
    ).toHaveLength(1);
    const invoiceOnly = await searchActivity(db, {
      q: "airbnb",
      source: "invoice",
    });
    expect(invoiceOnly.items.map((i) => i.id)).toEqual(["paired"]);
    const incomeOnly = await searchActivity(db, {
      q: "airbnb",
      flow: "income",
    });
    expect(incomeOnly.items).toEqual([]);
  });
  it("pages 65 same-day matches without duplicates and filters before pagination", async () => {
    const { db, database } = fixture();
    const insert = database.prepare(
      `INSERT INTO bank_transactions (id,connector_id,account_id,source_id,posted_date,description,amount,currency,status,created_at,updated_at) VALUES (?, 'ctbc','card',?,'2026-04-28','全國加油站昌平站',-131,'TWD','posted','2026-04-28','2026-04-28')`,
    );
    for (let i = 0; i < 65; i++)
      insert.run(`gas-${String(i).padStart(3, "0")}`, `gas-${i}`);
    const api = honoFactory.createApp();
    api.route("/", activityRoutes);
    api.onError(apiErrorResponse);
    let cursor: string | null = null;
    const ids: string[] = [];
    for (const count of [30, 30, 5]) {
      const params = new URLSearchParams({
        q: "加油",
        source: "card",
        flow: "expense",
      });
      if (cursor) params.set("cursor", cursor);
      const response = await api.request(`/activity/search?${params}`, {}, {
        DB: db,
      } as Env);
      expect(response.status).toBe(200);
      const page = (await response.json()) as Awaited<
        ReturnType<typeof searchActivity>
      >;
      expect(page.items).toHaveLength(count);
      ids.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(ids).size).toBe(65);
  });
  it("uses Taipei dates and treats SQL wildcards as literal search text", async () => {
    const { db } = fixture();
    expect(
      await findActivitySearchDays(db, {
        q: "airbnb",
        from: "2026-09-01",
        to: "2026-09-01",
      }),
    ).toEqual(["2026-09-01"]);
    expect(
      await findActivitySearchDays(db, { q: "airbnb", to: "2026-08-31" }),
    ).toEqual(["2024-06-15", "2023-02-12"]);
    expect(await findActivitySearchDays(db, { q: "%_" })).toEqual([]);
  });
  it("validates requests before querying and returns an explicit empty page", async () => {
    const { db } = fixture();
    for (const query of [
      "q=",
      "q=a&from=2026-02-30",
      "q=a&from=2026-09-01&to=2026-08-01",
      "q=a&source=bad",
    ]) {
      const res = await activityRoutes.request(
        `/activity/search?${query}`,
        {},
        { DB: db } as Env,
      );
      expect(res.status).toBe(400);
    }
    const res = await activityRoutes.request(
      "/activity/search?q=unmatched",
      {},
      { DB: db } as Env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [],
      bank: { transactions: [] },
      invoices: [],
      trades: [],
      nextCursor: null,
    });
  });
});
