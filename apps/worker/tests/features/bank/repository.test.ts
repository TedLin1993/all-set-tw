import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBankTransactionsForTransferMatching,
  listBankTransactionsInRange,
  type BankTransactionPageRow,
} from "../../../src/features/bank/repository";
import { listInvoicesInRange } from "../../../src/features/invoices/repository";

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  lastQuery?: { sql: string; values: unknown[] };

  constructor() {
    const migrationsDirectory = fileURLToPath(
      new URL("../../../../../packages/db/migrations/", import.meta.url),
    );
    for (const file of readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.database.exec(
        readFileSync(`${migrationsDirectory}/${file}`, "utf8"),
      );
    }
  }

  prepare(sql: string) {
    let values: unknown[] = [];
    this.lastQuery = { sql, values };
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        this.lastQuery = { sql, values };
        return statement;
      },
      async all<T>() {
        return {
          results: this.database
            .prepare(sql)
            .all(...(values as never[])) as T[],
        };
      },
      database: this.database,
    };
    return statement;
  }

  close() {
    this.database.close();
  }
}

const databases: SqliteD1[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDb() {
  const db = new SqliteD1();
  databases.push(db);
  db.database.exec(`
    INSERT INTO bank_accounts
      (id, connector_id, source_id, account_type, currency, created_at, updated_at)
    VALUES
      ('account-a', 'tdcc', 'account-a', 'savings', 'TWD', '2026-08-22', '2026-08-22'),
      ('account-b', 'tdcc', 'account-b', 'savings', 'TWD', '2026-08-22', '2026-08-22'),
      ('account-c', 'tdcc', 'account-c', 'savings', 'TWD', '2026-08-22', '2026-08-22');

    INSERT INTO bank_transactions
      (id, connector_id, account_id, source_id, posted_date, amount, currency,
       status, created_at, updated_at)
    VALUES
      ('out', 'tdcc', 'account-a', 'out', '2026-08-22', -10000, 'TWD', 'posted', '2026-08-22', '2026-08-22'),
      ('in', 'tdcc', 'account-b', 'in', '2026-08-22', 10000, 'TWD', 'posted', '2026-08-22', '2026-08-22'),
      ('late', 'tdcc', 'account-c', 'late', '2026-08-22T21:00:00.000Z', 10000, 'TWD', 'posted', '2026-08-22', '2026-08-22'),
      ('other-day', 'tdcc', 'account-c', 'other-day', '2026-08-23', 10000, 'TWD', 'posted', '2026-08-23', '2026-08-23'),
      ('pending', 'tdcc', 'account-c', 'pending', '2026-08-22', -10000, 'TWD', 'pending', '2026-08-22', '2026-08-22');
  `);
  return db;
}

describe("bank transaction transfer candidates", () => {
  it("uses the transaction day index for the range query", async () => {
    const db = createDb();
    await listBankTransactionsInRange(db as unknown as D1Database, {
      from: "2026-09-01",
      to: "2026-10-01",
    });
    const query = db.lastQuery;
    expect(query).toBeDefined();
    const plan = db.database
      .prepare(`EXPLAIN QUERY PLAN ${query?.sql ?? ""}`)
      .all(...((query?.values ?? []) as never[])) as Array<{
      detail: string;
    }>;
    expect(plan.map(({ detail }) => detail).join("\n")).toMatch(
      /SEARCH txn USING INDEX idx_bank_transactions_transaction_day/,
    );
  });

  it("uses Taipei dates for precise bank and invoice timestamps at month boundaries", async () => {
    const db = createDb();
    db.database.exec(`
      UPDATE bank_transactions SET authorized_at = '2026-08-31T16:30:00.000Z'
        WHERE id = 'out';
      UPDATE bank_transactions SET authorized_at = '2026-08-31T15:59:00.000Z'
        WHERE id = 'in';
      UPDATE bank_transactions
      SET authorized_at = NULL, posted_date = '2026-09-01T12:00:00.000Z', amount = 12345
      WHERE id = 'late';
      INSERT INTO invoices
        (id, connector_id, source_id, invoice_date, amount, created_at, updated_at)
      VALUES
        ('sep', 'einvoice', 'sep', '2026-08-31T16:30:00.000Z', 100, '2026-09-01', '2026-09-01'),
        ('aug', 'einvoice', 'aug', '2026-08-31T15:59:00.000Z', 100, '2026-09-01', '2026-09-01'),
        ('date', 'einvoice', 'date', '2026-09-01', 100, '2026-09-01', '2026-09-01');
    `);
    const range = { from: "2026-09-01", to: "2026-10-01" };
    expect(
      (
        await listBankTransactionsInRange(db as unknown as D1Database, range)
      ).map((row) => row.id),
    ).toEqual(["late", "out"]);
    expect(
      (await listInvoicesInRange(db as unknown as D1Database, range))
        .map((row) => row.id)
        .sort(),
    ).toEqual(["date", "sep"]);
    expect(
      (
        await listBankTransactionsForTransferMatching(
          db as unknown as D1Database,
          [{ amount: -10_000, currency: "TWD" }],
          ["2026-09-01"],
        )
      ).map((row) => row.id),
    ).toEqual(["out"]);
  });

  it("loads posted rows sharing a visible amount and currency", async () => {
    const db = createDb();
    const rows = await listBankTransactionsForTransferMatching(
      db as unknown as D1Database,
      [{ amount: -10_000, currency: "twd" }],
      ["2026-08-22"],
    );

    expect(rows.map(({ id }: BankTransactionPageRow) => id).sort()).toEqual([
      "in",
      "late",
      "out",
    ]);
  });

  it("does not query when there are no usable visible amounts", async () => {
    const db = createDb();
    const rows = await listBankTransactionsForTransferMatching(
      db as unknown as D1Database,
      [{ amount: 0, currency: "TWD" }],
    );

    expect(rows).toEqual([]);
  });
});
