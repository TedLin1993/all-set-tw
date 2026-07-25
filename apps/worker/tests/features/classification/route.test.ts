import { describe, expect, it } from "vitest";
import type { Env } from "../../../src/platform/env";
import { classificationRoutes } from "../../../src/features/classification/route";

function createDb(options: { existingLabel?: boolean } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          calls.push({ sql, values });
          return this;
        },
        async first() {
          if (sql.includes("WHERE label = ?")) {
            return options.existingLabel ? { id: "travel" } : null;
          }
          if (sql.includes("MAX(sort_order)")) return { sortOrder: 15 };
          if (sql.includes("WHERE id = ?")) return { id: values[0] };
          return null;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
    },
  } as unknown as D1Database;
  return { calls, db };
}

function createReorderDb(ruleIds = ["user:rule-1", "user:rule-2"]) {
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
          return { results: ruleIds.map((id) => ({ id })) };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
  return { calls, db };
}

describe("classification categories", () => {
  it("creates a trimmed user category after the existing sort order", async () => {
    const { calls, db } = createDb();
    const response = await classificationRoutes.request(
      "/classification/categories",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "  旅遊  " }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      label: "旅遊",
      sortOrder: 15,
      isSystem: false,
    });
    const insert = calls.find(({ sql }) =>
      sql.includes("INSERT INTO classification_categories"),
    );
    expect(insert?.values[1]).toBe("旅遊");
    expect(insert?.values[2]).toBe(15);
  });

  it("rejects duplicate category labels", async () => {
    const response = await classificationRoutes.request(
      "/classification/categories",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "旅遊" }),
      },
      { DB: createDb({ existingLabel: true }).db } as Env,
    );

    expect(response.status).toBe(409);
  });
});

describe("classification rule actions", () => {
  it("persists the calculation exclusion action with a new rule", async () => {
    const { calls, db } = createDb();
    const response = await classificationRoutes.request(
      "/classification/rules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: "transfer",
          targetType: "bank_transaction",
          field: "any_text",
          operator: "contains",
          pattern: "卡費",
          excludedFromCalculation: true,
        }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(200);
    const insert = calls.find(({ sql }) =>
      sql.includes("INSERT INTO classification_rules"),
    );
    expect(insert?.sql).toContain("excluded_from_calculation");
    expect(insert?.values[8]).toBe(1);
  });

  it("updates an editable rule's category, condition, keyword, and calculation action", async () => {
    const { calls, db } = createDb();
    const response = await classificationRoutes.request(
      "/classification/rules/user:rule-1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: "investment",
          operator: "equals",
          pattern: "定期買股",
          excludedFromCalculation: false,
        }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(200);
    const update = calls.find(({ sql }) =>
      sql.includes("UPDATE classification_rules"),
    );
    expect(update?.sql).toContain("category_id = ?");
    expect(update?.sql).toContain("operator = ?");
    expect(update?.sql).toContain("pattern = ?");
    expect(update?.sql).toContain("excluded_from_calculation = ?");
    expect(update?.sql).toContain("is_system = 0");
    expect(update?.values).toContain("equals");
    expect(update?.values).toContain(0);
  });

  it("persists the order of editable rules", async () => {
    const { calls, db } = createReorderDb();
    const response = await classificationRoutes.request(
      "/classification/rules/order",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleIds: ["user:rule-2", "user:rule-1"] }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(200);
    const updates = calls.filter(({ sql }) =>
      sql.includes("UPDATE classification_rules"),
    );
    expect(updates.map(({ values }) => values[0])).toEqual([1002, 1001]);
    expect(updates.map(({ values }) => values[2])).toEqual([
      "user:rule-2",
      "user:rule-1",
    ]);
  });

  it("rejects an order that does not contain the current editable rules", async () => {
    const { db } = createReorderDb();
    const response = await classificationRoutes.request(
      "/classification/rules/order",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleIds: ["user:rule-1"] }),
      },
      { DB: db } as Env,
    );

    expect(response.status).toBe(400);
  });
});
