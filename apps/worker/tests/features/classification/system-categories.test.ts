import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../../helpers/d1";
import { resolveClassifications } from "../../../src/features/classification/service";

const migrations = readMigrations();
const categoryMigration = migrations.findIndex((sql) =>
  sql.includes("system:bank:reward-keywords"),
);

describe("回饋與捐款系統分類（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    // Start before the migration with a user-created 回饋 category in use.
    harness = await createTestD1(
      undefined,
      migrations.slice(0, categoryMigration),
    );
    db = harness.binding;
    const now = "2026-10-01T00:00:00.000Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO classification_categories (id, label, sort_order, is_system, created_at, updated_at)
           VALUES ('user:reward', '回饋', 18, 0, ?, ?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
           VALUES ('override-1', 'bank_transaction', 'card-cashback', 'user:reward', ?, ?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO classification_rules (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, created_at, updated_at)
           VALUES ('user-rule-1', 'user:reward', 'bank_transaction', 'description', 'contains', '幣倍卡', 1000, 1, 0, 'user', ?, ?)`,
        )
        .bind(now, now),
    ]);
    for (const sql of migrations.slice(categoryMigration)) {
      const statements = unstable_splitSqlQuery(sql)
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement));
      await db.batch(statements);
    }
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("自訂「回饋」併入系統分類，保留分類覆寫與規則", async () => {
    const categories = await db
      .prepare(
        "SELECT id, label, is_system FROM classification_categories WHERE label IN ('回饋', '捐款') ORDER BY id",
      )
      .all();
    expect(categories.results).toEqual([
      { id: "donation", label: "捐款", is_system: 1 },
      { id: "reward", label: "回饋", is_system: 1 },
    ]);
    expect(
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE id = 'override-1'",
        )
        .first("category_id"),
    ).toBe("reward");
    expect(
      await db
        .prepare(
          "SELECT category_id, priority FROM classification_rules WHERE id = 'user-rule-1'",
        )
        .first(),
    ).toEqual({ category_id: "reward", priority: 1000 });
  });

  it("系統規則分出繳款入帳、折抵回饋、電子支付儲值、Uber Eats 與超商", async () => {
    const cases: Array<[id: string, description: string, amount: number]> = [
      ["payment", "信用卡繳款入帳", 1_000],
      ["discount", "信用卡消費折抵_範例電信", 50],
      ["withdraw", "一卡通Money提領", 300],
      ["topUp", "全支付儲值", -500],
      ["eats", "UBER *EATS", -250],
      // Rides keep the existing transport keyword.
      ["ride", "UBER *TRIP", -300],
      ["donation", "範例基金會捐款", -1_000],
      // Paying a merchant through an e-wallet is not a top-up.
      ["walletPayment", "全支付﹘範例商行", -200],
      // A station name in the store name must not win over the store.
      ["stationStore", "全家便利商店－範例台鐵站", -60],
      ["hiLife", "萊爾富－範例店", -60],
      ["supermarket", "範例超市", -300],
    ];
    const result = await resolveClassifications(
      db,
      cases.map(([id, description, amount]) => ({
        id,
        description,
        counterparty: description,
        sourceId: "card",
        amount,
      })),
    );

    expect(
      Object.fromEntries(cases.map(([id]) => [id, result.get(id)?.categoryId])),
    ).toEqual({
      payment: "transfer",
      discount: "reward",
      withdraw: "transfer",
      topUp: "transfer",
      eats: "food",
      ride: "transport",
      donation: "donation",
      walletPayment: "other",
      stationStore: "shopping",
      hiLife: "shopping",
      supermarket: "shopping",
    });
    expect(result.get("payment")?.excludedFromCalculation).toBe(true);
  });
});
