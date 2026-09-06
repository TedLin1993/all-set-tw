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

const otherIncomeRule = {
  id: "system:bank:other-income-keywords",
  category_id: "other-income",
  label: "其他收入",
  target_type: "bank_transaction",
  field: "any_text",
  operator: "contains",
  pattern: "利息",
  is_system: 1,
  excluded_from_calculation: 0,
};

function createClassificationDb(
  rules: Array<typeof otherIncomeRule> = [otherIncomeRule],
  overrides: Array<{
    target_id: string;
    category_id: string;
    label: string;
  }> = [],
) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async all() {
          return {
            results: sql.includes("classification_overrides")
              ? overrides
              : rules,
          };
        },
      };
    },
  } as unknown as D1Database;
}

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

  it("applies the other-income system rule only to positive amounts", async () => {
    const result = await resolveClassifications(createClassificationDb(), [
      {
        ...transaction,
        id: "tx-interest-positive",
        description: "外幣存款利息",
        amount: 18,
      },
    ]);

    expect(result.get("tx-interest-positive")).toMatchObject({
      categoryId: "other-income",
      label: "其他收入",
      source: "system_rule",
      ruleId: "system:bank:other-income-keywords",
    });
  });

  it("falls back when an other-income transaction is non-positive or missing an amount", async () => {
    const cases = [
      { id: "tx-interest-negative", amount: -18 },
      { id: "tx-interest-zero", amount: 0 },
      { id: "tx-interest-missing" },
    ] as const;

    for (const input of cases) {
      const result = await resolveClassifications(createClassificationDb(), [
        {
          ...transaction,
          id: input.id,
          description: "外幣存款利息",
          ...("amount" in input ? { amount: input.amount } : {}),
        },
      ]);

      expect(result.get(input.id), input.id).toEqual({
        categoryId: "other",
        label: "未分類",
        source: "fallback",
      });
    }
  });

  it("keeps an explicit override before the other-income amount guard", async () => {
    const result = await resolveClassifications(
      createClassificationDb(
        [otherIncomeRule],
        [
          {
            target_id: "tx-interest-negative",
            category_id: "fee",
            label: "手續費",
          },
        ],
      ),
      [
        {
          ...transaction,
          id: "tx-interest-negative",
          description: "外幣存款利息",
          amount: -18,
        },
      ],
    );

    expect(result.get("tx-interest-negative")).toMatchObject({
      categoryId: "fee",
      label: "手續費",
      source: "override",
    });
  });
});
