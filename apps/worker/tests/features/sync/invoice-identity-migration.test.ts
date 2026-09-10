import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { matchInvoicesToTransactions } from "../../../../../packages/core/src/activity-matching";

const directory = fileURLToPath(
  new URL("../../../../../packages/db/migrations/", import.meta.url),
);
const filename = "0043_merge_legacy_invoice_duplicates.sql";
const sql = readFileSync(`${directory}/${filename}`, "utf8");
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const oldSource = "BF11773035:2026-06-29T12:45:52";
const newSource = "BF11773035:2026-06-29T04:45:52.000Z";
const oldId = `einvoice:${oldSource}`;
const newId = `einvoice:${newSource}`;
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql") && f < filename)
    .sort())
    db.exec(readFileSync(`${directory}/${file}`, "utf8"));
  const insert = db.prepare(
    `INSERT INTO invoices (id,connector_id,source_id,invoice_number,invoice_date,seller_name,amount,created_at,updated_at) VALUES (?,'einvoice',?,'BF11773035','2026-06-29','茶坊',35,'2026-07-01','2026-07-01')`,
  );
  for (const source of [oldSource, newSource])
    insert.run(`einvoice:${source}`, source);
  return db;
}
function preference(
  db: DatabaseSync,
  id: string,
  decision: string,
  transaction: string | null = null,
) {
  db.prepare(
    "INSERT INTO invoice_transaction_preferences VALUES (?,?,?,'2026-07-01','2026-07-01')",
  ).run(id, transaction, decision);
}
function line(db: DatabaseSync, source: string, key: string, amount = 35) {
  db.prepare(
    `INSERT INTO invoice_line_items (id,invoice_id,connector_id,invoice_source_id,source_id,line_number,description,quantity,unit_price,amount,created_at,updated_at) VALUES (?,?,'einvoice',?,?,1,'茶',1,35,?,'2026-07-01','2026-07-01')`,
  ).run(
    `einvoice:${source}:item:${key}`,
    `einvoice:${source}`,
    source,
    key,
    amount,
  );
}
describe("legacy invoice identity migration", () => {
  it.each([oldId, newId])(
    "preserves separation from %s and is repeatable",
    (id) => {
      const db = fixture();
      preference(db, id, "separate");
      line(db, oldSource, "1");
      line(db, newSource, "1");
      line(db, oldSource, "2");
      db.exec(sql);
      db.exec(sql);
      expect(db.prepare("SELECT id FROM invoices").all()).toEqual([
        { id: newId },
      ]);
      expect(
        db
          .prepare(
            "SELECT invoice_id,decision FROM invoice_transaction_preferences",
          )
          .all(),
      ).toEqual([{ invoice_id: newId, decision: "separate" }]);
      expect(
        db
          .prepare(
            "SELECT invoice_id,source_id FROM invoice_line_items ORDER BY source_id",
          )
          .all(),
      ).toEqual([
        { invoice_id: newId, source_id: "1" },
        { invoice_id: newId, source_id: "2" },
      ]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const invoices = [{ id: newId, invoiceDate: "2026-06-29", amount: 35 }];
      const transactions = [
        {
          id: "card",
          connectorId: "sinopac",
          sourceId: "card",
          accountType: "credit",
          amount: -35,
          currency: "TWD",
          postedDate: "2026-06-29",
        },
      ];
      expect(
        matchInvoicesToTransactions(transactions, invoices, [
          { invoiceId: newId, transactionId: null, decision: "separate" },
        ]).invoiceToTransactionId.size,
      ).toBe(0);
      expect(
        matchInvoicesToTransactions(transactions, invoices)
          .invoiceToTransactionId.size,
      ).toBe(1);
      // Subsequent writes with the v2 identity update the survivor, not a new row.
      db.prepare(
        `INSERT INTO invoices (id,connector_id,source_id,invoice_date,amount,created_at,updated_at) VALUES (?,'einvoice',?,'2026-06-29',35,'now','now') ON CONFLICT(connector_id,source_id) DO UPDATE SET updated_at=excluded.updated_at`,
      ).run(newId, newSource);
      expect(
        db.prepare("SELECT count(*) AS count FROM invoices").get(),
      ).toEqual({ count: 1 });
    },
  );
  it("matches invoice numbers despite changed merchant, amount and timestamp", () => {
    const db = fixture();
    db.prepare(
      "UPDATE invoices SET amount=36, seller_name='舊名稱', source_id='legacy-different-time' WHERE id=?",
    ).run(oldId);
    db.exec(sql);
    expect(
      db.prepare("SELECT id,amount,seller_name FROM invoices").all(),
    ).toEqual([{ id: newId, amount: 35, seller_name: "茶坊" }]);
  });
  it("moves a manual link without violating the unique transaction index", () => {
    const db = fixture();
    preference(db, oldId, "linked", "card");
    db.exec(sql);
    expect(
      db
        .prepare(
          "SELECT invoice_id,transaction_id FROM invoice_transaction_preferences",
        )
        .all(),
    ).toEqual([{ invoice_id: newId, transaction_id: "card" }]);
  });
  it("keeps the canonical preference when both copies have decisions", () => {
    const db = fixture();
    preference(db, oldId, "separate");
    preference(db, newId, "linked", "card");
    db.exec(sql);
    expect(db.prepare("SELECT count(*) AS count FROM invoices").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(
          "SELECT invoice_id,decision,transaction_id FROM invoice_transaction_preferences",
        )
        .all(),
    ).toEqual([
      { invoice_id: newId, decision: "linked", transaction_id: "card" },
    ]);
  });
  it("keeps the canonical line when duplicate line content differs", () => {
    const db = fixture();
    line(db, oldSource, "1", 34);
    line(db, newSource, "1");
    db.exec(sql);
    expect(db.prepare("SELECT count(*) AS count FROM invoices").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT invoice_id,source_id,amount FROM invoice_line_items")
        .all(),
    ).toEqual([{ invoice_id: newId, source_id: "1", amount: 35 }]);
  });
});
