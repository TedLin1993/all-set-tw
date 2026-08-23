import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../../../../packages/db/migrations/", import.meta.url),
);
const migrationFile = "0032_tdcc_bank_transaction_identity_cleanup.sql";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < migrationFile)
    .sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${file}`, "utf8"));
  }
  database
    .prepare(
      `INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, created_at, updated_at)
       VALUES (?, 'tdcc', ?, 'settlement_cash', 'TWD', ?, ?)`,
    )
    .run("account-1", "settlement:004:test:TWD", "2026-08-20", "2026-08-20");
  databases.push(database);
  return database;
}

function insertTransaction(
  database: DatabaseSync,
  input: {
    id: string;
    sourceId: string;
    txnId: string;
    occurredAt?: string;
    amount?: number;
    memo?: string;
  },
) {
  const occurredAt = input.occurredAt ?? "2026-08-21T00:00:00";
  const amount = input.amount ?? 102;
  database
    .prepare(
      `INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, amount, currency,
         description, raw_payload, created_at, updated_at)
       VALUES (?, 'tdcc', 'account-1', ?, ?, ?, 'TWD', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.sourceId,
      occurredAt,
      amount,
      input.memo ?? "利息102稅額0健保費0",
      JSON.stringify({
        txnId: input.txnId,
        occurredAt,
        amount: String(amount),
        memo: input.memo ?? "利息102稅額0健保費0",
      }),
      "2026-08-20",
      "2026-08-23",
    );
}

function applyMigration(database: DatabaseSync) {
  database.exec(
    readFileSync(`${migrationsDirectory}/${migrationFile}`, "utf8"),
  );
}

describe("TDCC bank transaction identity migration", () => {
  it("merges uniquely matched legacy rows and preserves user preferences", () => {
    const database = createDatabase();
    const canonicalSourceId = "00000:2026-08-21T00:00:00:102.0:0.0";
    insertTransaction(database, {
      id: "canonical",
      sourceId: canonicalSourceId,
      txnId: canonicalSourceId,
    });
    insertTransaction(database, {
      id: "legacy-1",
      sourceId: "settlement:004:test:TWD:2026-08-21:102:TWD:interest-a",
      txnId: "",
      memo: "利息 102稅額 0健保費 0",
    });
    insertTransaction(database, {
      id: "legacy-2",
      sourceId: "settlement:004:test:TWD:2026-08-21:102:TWD:interest-b",
      txnId: " ",
    });
    database.exec(`
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES
        ('canonical', 0, '2026-08-23', '2026-08-23'),
        ('legacy-1', 1, '2026-08-20', '2026-08-21');
      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES
        ('legacy-override', 'bank_transaction', 'legacy-2', 'insurance',
         '2026-08-20', '2026-08-21');
      INSERT INTO invoice_transaction_preferences
        (invoice_id, transaction_id, decision, created_at, updated_at)
      VALUES ('invoice-1', 'legacy-1', 'linked', '2026-08-20', '2026-08-21');
    `);

    applyMigration(database);

    expect(
      database
        .prepare("SELECT id FROM bank_transactions ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["canonical"]);
    expect(
      database
        .prepare(
          "SELECT excluded_from_calculation FROM bank_transaction_preferences WHERE transaction_id = 'canonical'",
        )
        .get(),
    ).toEqual({ excluded_from_calculation: 1 });
    expect(
      database
        .prepare(
          "SELECT target_id, category_id FROM classification_overrides WHERE target_type = 'bank_transaction'",
        )
        .get(),
    ).toEqual({ target_id: "canonical", category_id: "insurance" });
    expect(
      database
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'invoice-1'",
        )
        .get(),
    ).toEqual({ transaction_id: "canonical" });

    applyMigration(database);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_transactions").get(),
    ).toEqual({ count: 1 });
  });

  it("keeps ambiguous matches and conflicting user decisions untouched", () => {
    const database = createDatabase();
    insertTransaction(database, {
      id: "ambiguous-legacy",
      sourceId: "settlement:004:test:TWD:ambiguous",
      txnId: "",
    });
    insertTransaction(database, {
      id: "ambiguous-canonical-1",
      sourceId: "canonical-1",
      txnId: "canonical-1",
    });
    insertTransaction(database, {
      id: "ambiguous-canonical-2",
      sourceId: "canonical-2",
      txnId: "canonical-2",
    });

    insertTransaction(database, {
      id: "invoice-legacy",
      sourceId: "settlement:004:test:TWD:invoice",
      txnId: "",
      occurredAt: "2026-08-22T00:00:00",
    });
    insertTransaction(database, {
      id: "invoice-canonical",
      sourceId: "invoice-canonical-id",
      txnId: "invoice-canonical-id",
      occurredAt: "2026-08-22T00:00:00",
    });
    database.exec(`
      INSERT INTO invoice_transaction_preferences
        (invoice_id, transaction_id, decision, created_at, updated_at)
      VALUES
        ('invoice-legacy-pref', 'invoice-legacy', 'linked', '2026-08-20', '2026-08-20'),
        ('invoice-canonical-pref', 'invoice-canonical', 'linked', '2026-08-20', '2026-08-20');
    `);

    insertTransaction(database, {
      id: "classification-legacy",
      sourceId: "settlement:004:test:TWD:classification",
      txnId: "",
      occurredAt: "2026-08-23T00:00:00",
    });
    insertTransaction(database, {
      id: "classification-canonical",
      sourceId: "classification-canonical-id",
      txnId: "classification-canonical-id",
      occurredAt: "2026-08-23T00:00:00",
    });
    database.exec(`
      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES
        ('classification-legacy-override', 'bank_transaction',
         'classification-legacy', 'tax', '2026-08-20', '2026-08-20'),
        ('classification-canonical-override', 'bank_transaction',
         'classification-canonical', 'insurance', '2026-08-20', '2026-08-20');
    `);

    applyMigration(database);

    expect(
      database
        .prepare(
          `SELECT id FROM bank_transactions
           WHERE id IN ('ambiguous-legacy', 'invoice-legacy', 'classification-legacy')
           ORDER BY id`,
        )
        .all()
        .map((row) => row.id),
    ).toEqual(["ambiguous-legacy", "classification-legacy", "invoice-legacy"]);
  });

  it("re-keys an empty durable source id without changing its transaction id", () => {
    const database = createDatabase();
    insertTransaction(database, {
      id: "empty-source-id",
      sourceId: "",
      txnId: "",
      memo: "利息 102稅額 0健保費 0",
    });
    database.exec(`
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('empty-source-id', 1, '2026-08-20', '2026-08-20');
    `);

    applyMigration(database);

    expect(
      database
        .prepare(
          "SELECT id, source_id FROM bank_transactions WHERE id = 'empty-source-id'",
        )
        .get(),
    ).toEqual({
      id: "empty-source-id",
      source_id: "missing:2026-08-21T00:00:00:102:利息102稅額0健保費0",
    });
    expect(
      database
        .prepare(
          "SELECT transaction_id FROM bank_transaction_preferences WHERE transaction_id = 'empty-source-id'",
        )
        .get(),
    ).toEqual({ transaction_id: "empty-source-id" });
  });
});
