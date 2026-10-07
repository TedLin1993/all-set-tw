import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { reconcileSinopacCardPaymentStatements } from "../../../src/sources/sinopac/repository";

const PAYMENT = "測試自扣已入帳";

describe("永豐信用卡繳款舊列合併（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await db.batch(
      [
        "invoice_transaction_preferences",
        "bank_transaction_preferences",
        "classification_overrides",
        "bank_transactions",
        "bank_accounts",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    );
    await db
      .prepare(
        "INSERT INTO bank_accounts (id, connector_id, source_id, created_at, updated_at) VALUES ('card-account', 'sinopac', 'card-account', 't', 't')",
      )
      .run();
  });

  async function transaction(
    id: string,
    card: string,
    createdAt: string,
    { amount = 5000, description = PAYMENT } = {},
  ) {
    await db
      .prepare(
        `INSERT INTO bank_transactions
          (id, connector_id, account_id, source_id, amount, currency, description,
           posted_date, authorized_at, status, created_at, updated_at)
         VALUES (?, 'sinopac', 'card-account', ?, ?, 'TWD', ?, '2026-09-24',
           '2026-09-24', 'posted', ?, ?)`,
      )
      .bind(
        id,
        `sinopac:card:tx:v2:TWD:2026-09-24:${amount}:${card}:1`,
        amount,
        description,
        createdAt,
        createdAt,
      )
      .run();
  }

  async function ids() {
    const rows = await db
      .prepare("SELECT id FROM bank_transactions ORDER BY id")
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  it("同一筆繳款掛在不同卡下的多筆舊列（含尚無摘要雜湊的 payment 列），全部併入新版列並帶走使用者分類", async () => {
    await transaction("legacy-a", "payment", "2026-09-25");
    await transaction("legacy-b", "2222", "2026-10-01");
    await transaction("legacy-c", "3333", "2026-10-03");
    await transaction("canonical", "payment-0a1b2c3d", "2026-10-08");
    await db
      .prepare(
        "INSERT INTO classification_overrides VALUES ('override:bank_transaction:legacy-b', 'bank_transaction', 'legacy-b', 'transfer', 't', 't')",
      )
      .run();

    await db.batch(reconcileSinopacCardPaymentStatements(db));

    expect(await ids()).toEqual(["canonical"]);
    const override = await db
      .prepare(
        "SELECT target_id, category_id FROM classification_overrides WHERE target_type = 'bank_transaction'",
      )
      .all();
    expect(override.results).toEqual([
      { target_id: "canonical", category_id: "transfer" },
    ]);
  });

  it("金額、摘要不同或不是繳款（退款）時不合併", async () => {
    await transaction("other-amount", "1111", "2026-09-25", { amount: 4999 });
    await transaction("refund", "2222", "2026-09-25", {
      description: "測試退款",
    });
    await transaction("purchase", "3333", "2026-09-25", { amount: -5000 });
    await transaction("canonical", "payment-0a1b2c3d", "2026-10-08");

    await db.batch(reconcileSinopacCardPaymentStatements(db));

    expect(await ids()).toEqual([
      "canonical",
      "other-amount",
      "purchase",
      "refund",
    ]);
  });

  it("還沒有新版 payment 列時，舊列維持原樣", async () => {
    await transaction("legacy-a", "1111", "2026-09-25");
    await transaction("legacy-b", "2222", "2026-10-01");

    await db.batch(reconcileSinopacCardPaymentStatements(db));

    expect(await ids()).toEqual(["legacy-a", "legacy-b"]);
  });
});
