import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../../../../../packages/db/migrations/", import.meta.url),
);
const migrationFile = "0037_activity_time_precision.sql";
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

  const accounts = [
    ["account-esun", "esun"],
    ["account-cathay", "cathaybk"],
    ["account-ctbc", "ctbc"],
    ["account-tdcc", "tdcc"],
    ["account-firstbank", "firstbank"],
  ] as const;
  const insertAccount = database.prepare(
    `INSERT INTO bank_accounts
      (id, connector_id, source_id, account_type, currency, created_at, updated_at)
     VALUES (?, ?, ?, 'savings', 'TWD', '2026-01-01', '2026-01-01')`,
  );
  for (const [id, connectorId] of accounts) {
    insertAccount.run(id, connectorId, `${connectorId}:source`);
  }

  databases.push(database);
  return database;
}

function insertTransaction(
  database: DatabaseSync,
  input: {
    id: string;
    connectorId: string;
    accountId: string;
    sourceId: string;
    postedDate: string;
    authorizedAt?: string | null;
    amount?: number;
    rawPayload: string;
  },
) {
  database
    .prepare(
      `INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, authorized_at,
         amount, currency, description, raw_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'TWD', 'fixture', ?, '2026-01-01', '2026-01-02')`,
    )
    .run(
      input.id,
      input.connectorId,
      input.accountId,
      input.sourceId,
      input.postedDate,
      input.authorizedAt ?? null,
      input.amount ?? -252,
      input.rawPayload,
    );
}

function insertInvoice(
  database: DatabaseSync,
  input: {
    id: string;
    sourceId: string;
    invoiceDate: string;
    rawPayload: string;
  },
) {
  database
    .prepare(
      `INSERT INTO invoices
        (id, connector_id, source_id, invoice_number, invoice_date, amount,
         raw_payload, created_at, updated_at)
       VALUES (?, 'einvoice', ?, ?, ?, 100, ?, '2026-01-01', '2026-01-01')`,
    )
    .run(
      input.id,
      input.sourceId,
      input.id,
      input.invoiceDate,
      input.rawPayload,
    );
}

function applyMigration(database: DatabaseSync) {
  database.exec(
    readFileSync(`${migrationsDirectory}/${migrationFile}`, "utf8"),
  );
}

function insertFixtures(database: DatabaseSync) {
  insertTransaction(database, {
    id: "esun-card-fake-midnight",
    connectorId: "esun",
    accountId: "account-esun",
    sourceId: "esun-card-fake",
    postedDate: "2026-07-05T00:00:00.000Z",
    authorizedAt: "2026-07-05T00:00:00.000Z",
    rawPayload: JSON.stringify({ consumerDt: "07/05" }),
  });
  insertTransaction(database, {
    id: "esun-deposit-full",
    connectorId: "esun",
    accountId: "account-esun",
    sourceId: "esun-deposit-full",
    postedDate: "2026-07-05T00:00:00.000Z",
    rawPayload: JSON.stringify({ txDate: "2026/07/05", txTime: "13:14:15" }),
  });
  insertTransaction(database, {
    id: "esun-deposit-no-time",
    connectorId: "esun",
    accountId: "account-esun",
    sourceId: "esun-deposit-no-time",
    postedDate: "2026-07-06T00:00:00.000Z",
    rawPayload: JSON.stringify({ txDate: "2026/07/06" }),
  });
  insertTransaction(database, {
    id: "cathay-full",
    connectorId: "cathaybk",
    accountId: "account-cathay",
    sourceId: "cathay-full",
    postedDate: "2026-07-05T12:34:56.000Z",
    rawPayload: JSON.stringify({ txnDateTime: "2026/07/05T12:34:56" }),
  });
  insertTransaction(database, {
    id: "cathay-no-time",
    connectorId: "cathaybk",
    accountId: "account-cathay",
    sourceId: "cathay-no-time",
    postedDate: "2026-07-06T00:00:00.000Z",
    rawPayload: JSON.stringify({ txnDateTime: "2026/07/06" }),
  });
  insertTransaction(database, {
    id: "cathay-bad-raw",
    connectorId: "cathaybk",
    accountId: "account-cathay",
    sourceId: "cathay-bad-raw",
    postedDate: "2026-07-07",
    rawPayload: "not-json",
  });
  insertTransaction(database, {
    id: "ctbc-full",
    connectorId: "ctbc",
    accountId: "account-ctbc",
    sourceId: "ctbc-full",
    postedDate: "2026-07-05",
    rawPayload: JSON.stringify({ txnDateTime: "2026/07/05 12:34:56" }),
  });
  insertTransaction(database, {
    id: "tdcc-true-midnight",
    connectorId: "tdcc",
    accountId: "account-tdcc",
    sourceId: "tdcc-true-midnight",
    postedDate: "2026-07-05",
    rawPayload: JSON.stringify({ occurredAt: "2026-07-05T00:00:00" }),
  });
  insertTransaction(database, {
    id: "tdcc-missing-time",
    connectorId: "tdcc",
    accountId: "account-tdcc",
    sourceId: "tdcc-missing-time",
    postedDate: "1970-01-01",
    rawPayload: JSON.stringify({ occurredAt: "1970-01-01T00:00:00" }),
  });
  insertTransaction(database, {
    id: "firstbank-full",
    connectorId: "firstbank",
    accountId: "account-firstbank",
    sourceId: "firstbank-full",
    postedDate: "2026-07-05",
    authorizedAt: "2026-07-05T12:34:56",
    rawPayload: "{}",
  });
  insertTransaction(database, {
    id: "firstbank-invalid-date",
    connectorId: "firstbank",
    accountId: "account-firstbank",
    sourceId: "firstbank-invalid-date",
    postedDate: "2026-02-30",
    authorizedAt: "2026-02-30T12:34:56",
    rawPayload: "{}",
  });

  insertInvoice(database, {
    id: "invoice-legacy-midnight",
    sourceId: "invoice-legacy-midnight",
    invoiceDate: "2026-07-05T00:00:00.000Z",
    rawPayload: JSON.stringify({ invoice: { invNum: "AA000001" } }),
  });
  insertInvoice(database, {
    id: "invoice-legacy-clock",
    sourceId: "invoice-legacy-clock",
    invoiceDate: "2026-07-05T12:34:56.000Z",
    rawPayload: JSON.stringify({
      invoice: { invNum: "AA000003", invDate: "2026-07-05T12:34:56.000Z" },
    }),
  });
  insertInvoice(database, {
    id: "invoice-new-midnight",
    sourceId: "invoice-new-midnight",
    invoiceDate: "2026-07-05T00:00:00.000Z",
    rawPayload: JSON.stringify({
      invoice: {
        invNum: "AA000002",
        invoiceDate: "2026-07-05T00:00:00+08:00",
      },
    }),
  });

  database.exec(`
    INSERT INTO bank_transaction_preferences
      (transaction_id, excluded_from_calculation, created_at, updated_at)
    VALUES ('esun-deposit-full', 1, '2026-01-01', '2026-01-02');
    INSERT INTO classification_overrides
      (id, target_type, target_id, category_id, created_at, updated_at)
    VALUES ('override-esun-full', 'bank_transaction', 'esun-deposit-full',
            'salary', '2026-01-01', '2026-01-02');
    INSERT INTO invoice_transaction_preferences
      (invoice_id, transaction_id, decision, created_at, updated_at)
    VALUES ('invoice-legacy-midnight', 'esun-deposit-full', 'linked',
            '2026-01-01', '2026-01-02');
  `);
}

describe("activity time precision migration", () => {
  it("recovers only proven source times and preserves row identity and links", () => {
    const database = createDatabase();
    insertFixtures(database);

    const beforeTransactions = database
      .prepare(
        `SELECT id, source_id, posted_date, amount, raw_payload
         FROM bank_transactions ORDER BY id`,
      )
      .all();
    const beforeCount = database
      .prepare("SELECT COUNT(*) AS count FROM bank_transactions")
      .get();

    expect(() => applyMigration(database)).not.toThrow();

    expect(
      database
        .prepare(
          `SELECT id, source_id, posted_date, amount, raw_payload
           FROM bank_transactions ORDER BY id`,
        )
        .all(),
    ).toEqual(beforeTransactions);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_transactions").get(),
    ).toEqual(beforeCount);

    expect(
      database
        .prepare(
          `SELECT id, authorized_at AS authorizedAt
           FROM bank_transactions ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "cathay-bad-raw", authorizedAt: null },
      {
        id: "cathay-full",
        authorizedAt: "2026-07-05T12:34:56+08:00",
      },
      { id: "cathay-no-time", authorizedAt: "2026-07-06" },
      {
        id: "ctbc-full",
        authorizedAt: "2026-07-05T12:34:56+08:00",
      },
      {
        id: "esun-card-fake-midnight",
        authorizedAt: "2026-07-05",
      },
      {
        id: "esun-deposit-full",
        authorizedAt: "2026-07-05T13:14:15+08:00",
      },
      { id: "esun-deposit-no-time", authorizedAt: "2026-07-06" },
      {
        id: "firstbank-full",
        authorizedAt: "2026-07-05T12:34:56+08:00",
      },
      {
        id: "firstbank-invalid-date",
        authorizedAt: "2026-02-30T12:34:56",
      },
      {
        id: "tdcc-missing-time",
        authorizedAt: "1970-01-01",
      },
      {
        id: "tdcc-true-midnight",
        authorizedAt: "2026-07-05T00:00:00+08:00",
      },
    ]);

    expect(
      database
        .prepare(
          `SELECT id, invoice_date AS invoiceDate
           FROM invoices ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "invoice-legacy-clock", invoiceDate: "2026-07-05" },
      { id: "invoice-legacy-midnight", invoiceDate: "2026-07-05" },
      {
        id: "invoice-new-midnight",
        invoiceDate: "2026-07-05T00:00:00.000Z",
      },
    ]);

    expect(
      database
        .prepare(
          `SELECT transaction_id AS transactionId, excluded_from_calculation AS excluded
           FROM bank_transaction_preferences`,
        )
        .all(),
    ).toEqual([{ transactionId: "esun-deposit-full", excluded: 1 }]);
    expect(
      database
        .prepare(
          `SELECT target_id AS targetId, category_id AS categoryId
           FROM classification_overrides`,
        )
        .all(),
    ).toEqual([{ targetId: "esun-deposit-full", categoryId: "salary" }]);
    expect(
      database
        .prepare(
          `SELECT invoice_id AS invoiceId, transaction_id AS transactionId
           FROM invoice_transaction_preferences`,
        )
        .all(),
    ).toEqual([
      {
        invoiceId: "invoice-legacy-midnight",
        transactionId: "esun-deposit-full",
      },
    ]);

    applyMigration(database);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM bank_transactions").get(),
    ).toEqual(beforeCount);
    expect(
      database
        .prepare("SELECT authorized_at FROM bank_transactions WHERE id = ?")
        .get("esun-deposit-full"),
    ).toEqual({ authorized_at: "2026-07-05T13:14:15+08:00" });
  });
});
