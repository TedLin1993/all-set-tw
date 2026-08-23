import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../../../../packages/db/migrations/", import.meta.url),
);
const migrationFile = "0032_tdcc_bank_transaction_identity_cleanup.sql";
const staleIdentityMigrationFile = "0033_tdcc_stale_identity_cleanup.sql";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(beforeMigration = migrationFile) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql") && name < beforeMigration)
    .sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${file}`, "utf8"));
  }
  database
    .prepare(
      `INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, created_at, updated_at)
       VALUES
         ('account-a', 'tdcc', 'settlement:bank-a:account-a:TWD',
          'settlement_cash', 'TWD', ?, ?),
         ('account-b', 'tdcc', 'settlement:bank-b:account-b:TWD',
          'settlement_cash', 'TWD', ?, ?),
         ('account-external', 'ctbc', 'bank:external',
          'savings', 'TWD', ?, ?)`,
    )
    .run(
      "2026-04-01",
      "2026-04-01",
      "2026-04-01",
      "2026-04-01",
      "2026-04-01",
      "2026-04-01",
    );
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
    accountId?: string;
    connectorId?: string;
    currency?: string;
  },
) {
  const occurredAt = input.occurredAt ?? "2026-04-15T08:30:45";
  const amount = input.amount ?? 375;
  database
    .prepare(
      `INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, amount, currency,
         description, raw_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.connectorId ?? "tdcc",
      input.accountId ?? "account-a",
      input.sourceId,
      occurredAt,
      amount,
      input.currency ?? "TWD",
      input.memo ?? "Provider adjustment",
      JSON.stringify({
        txnId: input.txnId,
        occurredAt,
        amount: String(amount),
        memo: input.memo ?? "Provider adjustment",
      }),
      "2026-04-01",
      "2026-04-16",
    );
}

function applyMigration(database: DatabaseSync, migration = migrationFile) {
  database.exec(readFileSync(`${migrationsDirectory}/${migration}`, "utf8"));
}

describe("TDCC bank transaction identity migration", () => {
  it("merges generic legacy identities with one canonical transaction", () => {
    const database = createDatabase();
    const canonicalSourceId = "batch:2026-04-15T08:30:45:375.0:0.0";
    insertTransaction(database, {
      id: "canonical",
      sourceId: canonicalSourceId,
      txnId: canonicalSourceId,
    });
    insertTransaction(database, {
      id: "legacy-1",
      sourceId: "settlement:bank-a:account-a:TWD:legacy-a",
      txnId: "",
      memo: "Provider  adjustment",
    });
    insertTransaction(database, {
      id: "legacy-2",
      sourceId: "settlement:bank-a:account-a:TWD:legacy-b",
      txnId: " ",
    });
    database.exec(`
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES
        ('canonical', 0, '2026-04-16', '2026-04-16'),
        ('legacy-1', 1, '2026-04-01', '2026-04-15');
      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES
        ('legacy-override', 'bank_transaction', 'legacy-2', 'insurance',
         '2026-04-01', '2026-04-15');
      INSERT INTO invoice_transaction_preferences
        (invoice_id, transaction_id, decision, created_at, updated_at)
      VALUES ('invoice-1', 'legacy-1', 'linked', '2026-04-01', '2026-04-15');
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
      sourceId: "settlement:bank-a:account-a:TWD:ambiguous",
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
      sourceId: "settlement:bank-a:account-a:TWD:invoice",
      txnId: "",
      occurredAt: "2026-04-16T08:30:45",
    });
    insertTransaction(database, {
      id: "invoice-canonical",
      sourceId: "invoice-canonical-id",
      txnId: "invoice-canonical-id",
      occurredAt: "2026-04-16T08:30:45",
    });
    database.exec(`
      INSERT INTO invoice_transaction_preferences
        (invoice_id, transaction_id, decision, created_at, updated_at)
      VALUES
        ('invoice-legacy-pref', 'invoice-legacy', 'linked', '2026-04-01', '2026-04-01'),
        ('invoice-canonical-pref', 'invoice-canonical', 'linked', '2026-04-01', '2026-04-01');
    `);

    insertTransaction(database, {
      id: "classification-legacy",
      sourceId: "settlement:bank-a:account-a:TWD:classification",
      txnId: "",
      occurredAt: "2026-04-17T08:30:45",
    });
    insertTransaction(database, {
      id: "classification-canonical",
      sourceId: "classification-canonical-id",
      txnId: "classification-canonical-id",
      occurredAt: "2026-04-17T08:30:45",
    });
    database.exec(`
      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES
        ('classification-legacy-override', 'bank_transaction',
         'classification-legacy', 'tax', '2026-04-01', '2026-04-01'),
        ('classification-canonical-override', 'bank_transaction',
         'classification-canonical', 'insurance', '2026-04-01', '2026-04-01');
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
    expect(
      database
        .prepare(
          "SELECT invoice_id, transaction_id FROM invoice_transaction_preferences ORDER BY invoice_id",
        )
        .all(),
    ).toEqual([
      {
        invoice_id: "invoice-canonical-pref",
        transaction_id: "invoice-canonical",
      },
      {
        invoice_id: "invoice-legacy-pref",
        transaction_id: "invoice-legacy",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT target_id, category_id FROM classification_overrides
           WHERE target_id LIKE 'classification-%' ORDER BY target_id`,
        )
        .all(),
    ).toEqual([
      {
        target_id: "classification-canonical",
        category_id: "insurance",
      },
      { target_id: "classification-legacy", category_id: "tax" },
    ]);
  });

  it("does not cross account, connector, timestamp, memo, or valid provider ids", () => {
    const database = createDatabase();
    const canonicalSourceId = "batch:2026-04-15T08:30:45:375.0:0.0";
    insertTransaction(database, {
      id: "canonical",
      sourceId: canonicalSourceId,
      txnId: canonicalSourceId,
    });
    insertTransaction(database, {
      id: "other-account",
      accountId: "account-b",
      sourceId: "settlement:bank-b:account-b:TWD:legacy",
      txnId: "",
    });
    insertTransaction(database, {
      id: "other-connector",
      accountId: "account-external",
      connectorId: "ctbc",
      sourceId: "settlement:external:legacy",
      txnId: "",
    });
    insertTransaction(database, {
      id: "valid-provider-id",
      sourceId: "opaque-provider-id",
      txnId: "opaque-provider-id",
    });
    insertTransaction(database, {
      id: "different-time",
      sourceId: "settlement:bank-a:account-a:TWD:different-time",
      txnId: "",
      occurredAt: "2026-04-15T08:30:46",
    });
    insertTransaction(database, {
      id: "different-memo",
      sourceId: "settlement:bank-a:account-a:TWD:different-memo",
      txnId: "",
      memo: "Another adjustment",
    });

    applyMigration(database);

    expect(
      database
        .prepare("SELECT id FROM bank_transactions ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual([
      "canonical",
      "different-memo",
      "different-time",
      "other-account",
      "other-connector",
      "valid-provider-id",
    ]);
  });

  it("re-keys an empty durable source id without changing its transaction id", () => {
    const database = createDatabase();
    insertTransaction(database, {
      id: "empty-source-id",
      sourceId: "",
      txnId: "",
      memo: "Provider adjustment",
    });
    database.exec(`
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('empty-source-id', 1, '2026-04-01', '2026-04-01');
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
      source_id: "missing:2026-04-15T08:30:45:375:Provideradjustment",
    });
    expect(
      database
        .prepare(
          "SELECT transaction_id FROM bank_transaction_preferences WHERE transaction_id = 'empty-source-id'",
        )
        .get(),
    ).toEqual({ transaction_id: "empty-source-id" });
  });

  it("merges an older opaque provider id into a newer compound identity", () => {
    const database = createDatabase(staleIdentityMigrationFile);
    const canonicalSourceId = "batch:2026-04-15T08:30:45:375.0:0.0";
    insertTransaction(database, {
      id: "compound-canonical",
      sourceId: canonicalSourceId,
      txnId: canonicalSourceId,
    });
    insertTransaction(database, {
      id: "opaque-legacy",
      sourceId: "opaque-provider-id",
      txnId: "opaque-provider-id",
    });
    database.exec(`
      UPDATE bank_transactions
      SET created_at = CASE id
        WHEN 'opaque-legacy' THEN '2026-04-01T00:00:00.000Z'
        WHEN 'compound-canonical' THEN '2026-04-16T00:00:00.000Z'
      END
      WHERE id IN ('opaque-legacy', 'compound-canonical');
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('opaque-legacy', 1, '2026-04-01', '2026-04-15');
      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES ('opaque-legacy-override', 'bank_transaction', 'opaque-legacy',
              'other', '2026-04-01', '2026-04-15');
      INSERT INTO invoice_transaction_preferences
        (invoice_id, transaction_id, decision, created_at, updated_at)
      VALUES ('opaque-invoice', 'opaque-legacy', 'linked',
              '2026-04-01', '2026-04-15');
    `);

    applyMigration(database, staleIdentityMigrationFile);

    expect(
      database
        .prepare("SELECT id, source_id FROM bank_transactions ORDER BY id")
        .all(),
    ).toEqual([{ id: "compound-canonical", source_id: canonicalSourceId }]);
    expect(
      database
        .prepare(
          "SELECT transaction_id, excluded_from_calculation FROM bank_transaction_preferences",
        )
        .get(),
    ).toEqual({
      transaction_id: "compound-canonical",
      excluded_from_calculation: 1,
    });
    expect(
      database
        .prepare("SELECT target_id, category_id FROM classification_overrides")
        .get(),
    ).toEqual({ target_id: "compound-canonical", category_id: "other" });
    expect(
      database
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'opaque-invoice'",
        )
        .get(),
    ).toEqual({ transaction_id: "compound-canonical" });
  });
});
