import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { getBankRange } from "../../../src/features/bank/service";

describe("自動互轉配對（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const now = "2026-10-15T00:00:00Z";
    await db.batch([
      ...["account-a", "account-b"].map((id) =>
        db
          .prepare(
            `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
             VALUES (?, 'taishin', ?, 'checking', 'TWD', ?, ?)`,
          )
          .bind(id, id, now, now),
      ),
      ...[
        ["own-out", "account-a", "2026-10-05", -12_000, "範例轉出"],
        ["own-in", "account-b", "2026-10-05", 12_000, "範例轉入"],
        ["kept-out", "account-a", "2026-10-06", -3_000, "範例代付"],
        ["kept-in", "account-b", "2026-10-06", 3_000, "範例收款"],
      ].map(([id, accountId, day, amount, description]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
             VALUES (?, 'taishin', ?, ?, ?, ?, 'TWD', ?, ?, ?, ?)`,
          )
          .bind(
            id,
            accountId,
            id,
            day,
            amount,
            description,
            description,
            now,
            now,
          ),
      ),
      ...[
        ["user:own-transfer", "帳戶互轉"],
        ["user:counted", "範例分類"],
      ].map(([id, label], index) =>
        db
          .prepare(
            `INSERT INTO classification_categories (id, label, sort_order, is_system, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .bind(id, label, 100 + index, now, now),
      ),
      ...[
        ["rule-own-transfer", "user:own-transfer", "範例轉出", 1],
        ["rule-counted", "user:counted", "範例代付", 0],
      ].map(([id, categoryId, pattern, excluded]) =>
        db
          .prepare(
            `INSERT INTO classification_rules (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, excluded_from_calculation, created_at, updated_at)
             VALUES (?, ?, 'bank_transaction', 'description', 'contains', ?, 200, 1, 0, 'user', ?, ?, ?)`,
          )
          .bind(id, categoryId, pattern, excluded, now, now),
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  async function loadById() {
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    return new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );
  }

  it("不計入統計的使用者規則命中的一邊仍可當配對對象，另一邊被認成帳戶互轉", async () => {
    const byId = await loadById();

    expect(byId.get("own-in")).toMatchObject({
      excludedFromCalculation: true,
      classification: { source: "auto_transfer" },
    });
    expect(byId.get("own-out")).toMatchObject({
      excludedFromCalculation: true,
      classification: { source: "user_rule", label: "帳戶互轉" },
    });
  });

  it("仍計入統計的使用者規則不當配對對象，對方維持原本分類與計算", async () => {
    const byId = await loadById();

    expect(byId.get("kept-in")).toMatchObject({
      excludedFromCalculation: false,
      classification: { source: "fallback" },
    });
    expect(byId.get("kept-out")).toMatchObject({
      excludedFromCalculation: false,
      classification: { source: "user_rule", label: "範例分類" },
    });
  });
});
