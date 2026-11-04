import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { reconcileEsunLifecycleShadowStatements } from "../../../src/sources/esun/repository";
import { reconcileSinopacLegacyTransactionStatements } from "../../../src/sources/sinopac/repository";
import { reconcileHncbLegacyTransactionStatements } from "../../../src/sources/hncb/repository";

describe("legacy transaction merges on D1", () => {
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
        "invoices",
        "bank_accounts",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    );
  });
  async function transaction(
    id: string,
    source: string,
    connector = "sinopac",
  ) {
    await db
      .prepare(
        "INSERT INTO bank_transactions (id, connector_id, account_id, source_id, amount, posted_date, authorized_at, created_at, updated_at) VALUES (?, ?, 'account', ?, 100, '2026-09-13', '2026-09-13', 't', 't')",
      )
      .bind(id, connector, source)
      .run();
  }
  async function invoice(
    id: string,
    target: string | null,
    decision = "linked",
  ) {
    await db.batch([
      db
        .prepare(
          "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-09-13', 100, 't', 't')",
        )
        .bind(id, id),
      db
        .prepare(
          "INSERT INTO invoice_transaction_preferences VALUES (?, ?, ?, 'created', 'updated')",
        )
        .bind(id, target, decision),
    ]);
  }
  async function fixture(
    connector = "sinopac",
    oldSource = "sinopac:card:tx:1",
    newSource = "sinopac:card:tx:v2:1",
  ) {
    await db
      .prepare(
        "INSERT INTO bank_accounts (id, connector_id, source_id, created_at, updated_at) VALUES ('account', ?, 'account', 't', 't')",
      )
      .bind(connector)
      .run();
    await transaction("old", oldSource, connector);
    await transaction("new", newSource, connector);
    await invoice("invoice", "old");
    await db.batch([
      db.prepare(
        "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES ('old', 1, 'created', 'updated')",
      ),
      db.prepare(
        "INSERT INTO classification_overrides VALUES ('category', 'bank_transaction', 'old', 'shopping', 'created', 'updated')",
      ),
      db.prepare(
        "UPDATE bank_transaction_preferences SET note = '已還100' WHERE transaction_id = 'old'",
      ),
    ]);
  }
  async function snapshot() {
    const tables = [
      "bank_transactions",
      "invoice_transaction_preferences",
      "bank_transaction_preferences",
      "classification_overrides",
    ];
    return Promise.all(
      tables.map(
        async (t) =>
          (await db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).results,
      ),
    );
  }
  it.each([
    ["esun", "card:已入帳:1", "card:1", reconcileEsunLifecycleShadowStatements],
    [
      "sinopac",
      "sinopac:card:tx:1",
      "sinopac:card:tx:v2:1",
      reconcileSinopacLegacyTransactionStatements,
    ],
    [
      "hncb",
      "hncb:card:tx:1",
      "hncb:card:tx:v2:1",
      reconcileHncbLegacyTransactionStatements,
    ],
  ] as const)(
    "moves %s references and preferences before deleting the old transaction",
    async (connector, oldSource, newSource, reconcile) => {
      await fixture(connector, oldSource, newSource);
      await invoice("separate", null, "separate");
      await invoice("separate-with-reference", "old", "separate");
      await transaction("peer", "unrelated", connector);
      await db
        .prepare(
          "UPDATE bank_transactions SET matched_transaction_id = 'old', transfer_peer_id = 'old' WHERE id = 'peer'",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO bank_transaction_preferences (transaction_id, note, created_at, updated_at) VALUES ('new', '已還1000', 'created', 'later')",
        )
        .run();
      await db.batch(reconcile(db));
      expect(
        await db
          .prepare("SELECT id FROM bank_transactions WHERE id = 'old'")
          .first(),
      ).toBeNull();
      expect(
        await db
          .prepare(
            "SELECT * FROM invoice_transaction_preferences WHERE invoice_id = 'invoice'",
          )
          .first(),
      ).toEqual({
        invoice_id: "invoice",
        transaction_id: "new",
        decision: "linked",
        created_at: "created",
        updated_at: "updated",
      });
      expect(
        await db
          .prepare(
            "SELECT transaction_id, decision FROM invoice_transaction_preferences WHERE invoice_id = 'separate'",
          )
          .first(),
      ).toEqual({ transaction_id: null, decision: "separate" });
      expect(
        await db
          .prepare(
            "SELECT transaction_id, decision FROM invoice_transaction_preferences WHERE invoice_id = 'separate-with-reference'",
          )
          .first(),
      ).toEqual({ transaction_id: "new", decision: "separate" });
      // 只有備註的列沒有計算選擇，不阻擋合併並補上舊交易的排除設定；
      // 備註以完整內容比對，一段是另一段的子字串時也都保留。
      expect(
        await db.prepare("SELECT * FROM bank_transaction_preferences").first(),
      ).toEqual({
        transaction_id: "new",
        excluded_from_calculation: 1,
        created_at: "created",
        updated_at: "updated",
        note: "已還1000\n已還100",
      });
      expect(
        await db
          .prepare(
            "SELECT target_id, category_id, created_at, updated_at FROM classification_overrides",
          )
          .first(),
      ).toEqual({
        target_id: "new",
        category_id: "shopping",
        created_at: "created",
        updated_at: "updated",
      });
      expect(
        await db
          .prepare(
            "SELECT matched_transaction_id, transfer_peer_id FROM bank_transactions WHERE id = 'peer'",
          )
          .first(),
      ).toEqual({ matched_transaction_id: "new", transfer_peer_id: "new" });
      const after = await snapshot();
      await db.batch(reconcile(db));
      expect(await snapshot()).toEqual(after);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    },
  );
  it.each(["one-to-many", "many-to-one", "invoice", "calculation", "category"])(
    "preserves both transactions and decisions for %s ambiguity or conflict",
    async (conflict) => {
      await fixture();
      if (conflict === "one-to-many")
        await transaction("extra", "sinopac:card:tx:v2:2");
      if (conflict === "many-to-one")
        await transaction("extra", "sinopac:card:tx:2");
      if (conflict === "invoice") await invoice("other", "new");
      if (conflict === "calculation")
        await db
          .prepare(
            "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES ('new', 0, 'other', 'other')",
          )
          .run();
      if (conflict === "category")
        await db
          .prepare(
            "INSERT INTO classification_overrides VALUES ('other', 'bank_transaction', 'new', 'food', 'other', 'other')",
          )
          .run();
      const before = await snapshot();
      await db.batch(reconcileSinopacLegacyTransactionStatements(db));
      expect(await snapshot()).toEqual(before);
    },
  );
  it("rolls back all moves when a later statement fails", async () => {
    await fixture();
    const before = await snapshot();
    await expect(
      db.batch([
        ...reconcileSinopacLegacyTransactionStatements(db),
        db.prepare(
          "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES ('missing', 0, 't', 't')",
        ),
      ]),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
