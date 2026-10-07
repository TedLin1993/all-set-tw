import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { reconcileSinopacCardSignStatements } from "../../../src/sources/sinopac/repository";

describe("永豐信用卡錯號舊列合併（隔離 D1）", () => {
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
    amount: number,
    rawAmount: string,
    description = "測試回饋金入帳戶",
  ) {
    await db
      .prepare(
        `INSERT INTO bank_transactions
          (id, connector_id, account_id, source_id, amount, currency, description,
           posted_date, authorized_at, status, raw_payload, created_at, updated_at)
         VALUES (?, 'sinopac', 'card-account', ?, ?, 'USD', ?, '2026-10-01',
           '2026-10-01', 'posted', ?, 't', 't')`,
      )
      .bind(
        id,
        `sinopac:card:tx:v2:USD:2026-10-01:${amount}:1111:1`,
        amount,
        description,
        JSON.stringify({ AMT: rawAmount }),
      )
      .run();
  }

  async function ids() {
    const rows = await db
      .prepare("SELECT id FROM bank_transactions ORDER BY id")
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  it("同一筆明細記錯正負號的舊列併入與銀行正負號一致的新列，並帶走使用者分類", async () => {
    await transaction("wrong-sign", 2, "2.00");
    await transaction("correct", -2, "2.00");
    await db
      .prepare(
        "INSERT INTO classification_overrides VALUES ('override:bank_transaction:wrong-sign', 'bank_transaction', 'wrong-sign', 'transfer', 't', 't')",
      )
      .run();

    await db.batch(reconcileSinopacCardSignStatements(db));

    expect(await ids()).toEqual(["correct"]);
    const override = await db
      .prepare(
        "SELECT target_id, category_id FROM classification_overrides WHERE target_type = 'bank_transaction'",
      )
      .all();
    expect(override.results).toEqual([
      { target_id: "correct", category_id: "transfer" },
    ]);
  });

  it("消費與同額退款（原始金額正負不同）不合併", async () => {
    await transaction("purchase", -2, "2.00", "測試商店");
    await transaction("refund", 2, "-2.00", "測試商店");

    await db.batch(reconcileSinopacCardSignStatements(db));

    expect(await ids()).toEqual(["purchase", "refund"]);
  });

  it("只有錯號舊列、還沒有新列時維持原樣", async () => {
    await transaction("wrong-sign", 2, "2.00");

    await db.batch(reconcileSinopacCardSignStatements(db));

    expect(await ids()).toEqual(["wrong-sign"]);
  });
});
