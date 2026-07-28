import { describe, expect, it } from "vitest";
import {
  matchesClassificationRule,
  resolveClassifications,
} from "../../../src/features/classification/service";

const transaction = {
  id: "tx-1",
  sourceId: "source-1",
  description: "STARBUCKS TAIPEI",
  counterparty: "Coffee Shop",
};

describe("matchesClassificationRule", () => {
  it("supports field-specific and any-text matching", () => {
    expect(
      matchesClassificationRule(
        { field: "description", operator: "contains", pattern: "starbucks" },
        transaction,
      ),
    ).toBe(true);
    expect(
      matchesClassificationRule(
        { field: "any_text", operator: "contains", pattern: "coffee" },
        transaction,
      ),
    ).toBe(true);
  });

  it("treats invalid regular expressions as non-matches", () => {
    expect(
      matchesClassificationRule(
        { field: "any_text", operator: "regex", pattern: "[" },
        transaction,
      ),
    ).toBe(false);
  });
});

describe("resolveClassifications", () => {
  it("labels unmatched transactions as uncategorized", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: [] };
          },
        };
      },
    } as unknown as D1Database;

    const result = await resolveClassifications(db, [transaction]);

    expect(result.get(transaction.id)).toEqual({
      categoryId: "other",
      label: "未分類",
      source: "fallback",
    });
  });

  it("returns the calculation action from the first matching rule", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...bound: unknown[]) {
            values = bound;
            calls.push({ sql, values });
            return this;
          },
          async all() {
            if (sql.includes("classification_overrides"))
              return { results: [] };
            return {
              results: [
                {
                  id: "user:card-payment",
                  category_id: "transfer",
                  label: "轉帳",
                  target_type: "bank_transaction",
                  field: "any_text",
                  operator: "contains",
                  pattern: "卡費",
                  is_system: 0,
                  excluded_from_calculation: 1,
                },
              ],
            };
          },
        };
      },
    } as unknown as D1Database;

    const result = await resolveClassifications(db, [
      {
        id: "tx-card-payment",
        sourceId: "source-card-payment",
        description: "本月卡費",
      },
    ]);

    expect(result.get("tx-card-payment")).toMatchObject({
      categoryId: "transfer",
      excludedFromCalculation: true,
    });
    const overrideQuery = calls.find(({ sql }) =>
      sql.includes("classification_overrides"),
    );
    expect(overrideQuery?.sql).toContain("json_each(?)");
    expect(overrideQuery?.values).toEqual([
      JSON.stringify(["tx-card-payment"]),
    ]);
  });
});
