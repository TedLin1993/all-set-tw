import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import * as repository from "../../../src/features/classification/repository";

const now = "2026-09-12T00:00:00.000Z";
const later = "2026-09-12T01:00:00.000Z";

describe("classification repository", () => {
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
      db.prepare("DROP TRIGGER IF EXISTS fail_rule"),
      db.prepare("DELETE FROM classification_overrides"),
      db.prepare("DELETE FROM classification_rules"),
      db.prepare("DELETE FROM classification_categories"),
    ]);
  });
  async function category(id = "food", sortOrder = 1) {
    await repository.insertClassificationCategory(harness.binding, {
      id,
      label: id,
      sortOrder,
      now,
    });
  }
  async function rule(id: string, priority = 100, timestamp = now) {
    await repository.insertClassificationRule(harness.binding, {
      id,
      categoryId: "food",
      targetType: null,
      field: "any_text",
      operator: "contains",
      pattern: "coffee",
      priority,
      description: "test",
      excludedFromCalculation: true,
      now: timestamp,
    });
  }

  it("preserves NOCASE uniqueness, category ordering and missing-row results", async () => {
    const db = harness.binding;
    await expect(repository.nextCategorySortOrder(db)).resolves.toBe(1);
    await expect(
      repository.findCategoryByLabel(db, "missing"),
    ).resolves.toBeNull();
    await expect(
      repository.classificationCategoryExists(db, "missing"),
    ).resolves.toBe(false);
    await category("Food", 5);
    await category("a", 2);
    await category("b", 2);
    await expect(repository.findCategoryByLabel(db, "fOOD")).resolves.toEqual({
      id: "Food",
    });
    await expect(
      repository.classificationCategoryExists(db, "Food"),
    ).resolves.toBe(true);
    await expect(repository.nextCategorySortOrder(db)).resolves.toBe(6);
    expect(
      (await repository.listClassificationCategories(db)).map((row) => row.id),
    ).toEqual(["a", "b", "Food"]);
    await expect(
      repository.insertClassificationCategory(db, {
        id: "duplicate",
        label: "FOOD",
        sortOrder: 6,
        now,
      }),
    ).rejects.toThrow();
  });

  it("preserves rule precedence, nullable fields, partial updates and system-rule protection", async () => {
    const db = harness.binding;
    await category();
    await rule("b");
    await rule("a");
    await rule("recent", 100, later);
    await rule("system", 200);
    await db
      .prepare(
        "UPDATE classification_rules SET is_system = 1 WHERE id = 'system'",
      )
      .run();
    expect(
      (await repository.listEnabledClassificationRules(db)).map(
        (row) => row.id,
      ),
    ).toEqual(["system", "recent", "a", "b"]);
    await expect(
      repository.listEditableClassificationRuleIds(db),
    ).resolves.toEqual(["recent", "a", "b"]);
    await expect(
      repository.updateClassificationRule(
        db,
        "a",
        {
          priority: 0,
          enabled: false,
          description: null,
          excludedFromCalculation: false,
        },
        later,
      ),
    ).resolves.toBe(true);
    expect(
      (await repository.listClassificationRules(db)).find(
        (row) => row.id === "a",
      ),
    ).toMatchObject({
      targetType: null,
      pattern: "coffee",
      priority: 0,
      enabled: 0,
      description: null,
      excludedFromCalculation: 0,
    });
    expect(
      (await repository.listEnabledClassificationRules(db)).map(
        (row) => row.id,
      ),
    ).not.toContain("a");
    await expect(
      repository.updateClassificationRule(
        db,
        "system",
        { pattern: "changed" },
        later,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.deleteClassificationRule(db, "system"),
    ).resolves.toBe(false);
    await expect(
      repository.updateClassificationRule(db, "missing", {}, later),
    ).resolves.toBe(false);
    await expect(
      repository.deleteClassificationRule(db, "missing"),
    ).resolves.toBe(false);
    await expect(repository.deleteClassificationRule(db, "b")).resolves.toBe(
      true,
    );
  });

  it("reorders editable rules in one atomic batch and rolls back earlier writes on failure", async () => {
    const db = harness.binding;
    await category();
    await rule("a");
    await rule("b");
    await rule("system", 200);
    await db
      .prepare(
        "UPDATE classification_rules SET is_system = 1 WHERE id = 'system'",
      )
      .run();
    await repository.updateClassificationRuleOrder(db, [], later);
    await repository.updateClassificationRuleOrder(
      db,
      ["b", "system", "a"],
      later,
    );
    expect(
      (await repository.listClassificationRules(db)).map((row) => [
        row.id,
        row.priority,
      ]),
    ).toEqual([
      ["b", 1003],
      ["a", 1001],
      ["system", 200],
    ]);
    await db
      .prepare(
        "CREATE TRIGGER fail_rule BEFORE UPDATE ON classification_rules WHEN OLD.id = 'b' BEGIN SELECT RAISE(ABORT, 'test reorder failure'); END",
      )
      .run();
    await expect(
      repository.updateClassificationRuleOrder(db, ["a", "b"], now),
    ).rejects.toThrow();
    expect(
      (await repository.listClassificationRules(db)).map((row) => [
        row.id,
        row.priority,
      ]),
    ).toEqual([
      ["b", 1003],
      ["a", 1001],
      ["system", 200],
    ]);
  });

  it("upserts overrides by target type and id, preserves identity and creation time, and supports large JSON lookups", async () => {
    const db = harness.binding;
    await category();
    await category("travel");
    const input = {
      targetType: "bank_transaction",
      targetId: "tx:299",
      categoryId: "food",
      now,
    };
    await repository.upsertClassificationOverride(db, input);
    await db
      .prepare("UPDATE classification_overrides SET id = 'legacy-id'")
      .run();
    await repository.upsertClassificationOverride(db, {
      ...input,
      categoryId: "travel",
      now: later,
    });
    await repository.upsertClassificationOverride(db, {
      ...input,
      targetType: "invoice",
    });
    await expect(
      db
        .prepare(
          "SELECT id, created_at, updated_at FROM classification_overrides WHERE target_type = 'bank_transaction'",
        )
        .first(),
    ).resolves.toEqual({ id: "legacy-id", created_at: now, updated_at: later });
    await expect(
      repository.listClassificationOverrides(
        db,
        Array.from({ length: 300 }, (_, i) => "tx:" + i),
      ),
    ).resolves.toEqual([
      { target_id: "tx:299", category_id: "travel", label: "travel" },
    ]);
    await expect(
      repository.listClassificationOverrides(db, []),
    ).resolves.toEqual([]);
    await repository.deleteClassificationOverride(
      db,
      "bank_transaction",
      "tx:299",
    );
    await expect(
      repository.listClassificationOverrides(db, ["tx:299"]),
    ).resolves.toEqual([]);
    await expect(
      db.prepare("SELECT target_type FROM classification_overrides").first(),
    ).resolves.toEqual({ target_type: "invoice" });
  });
});
