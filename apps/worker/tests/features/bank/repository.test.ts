import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBankTransactionsForTransferMatching,
  type BankTransactionPageRow,
} from "../../../src/features/bank/repository";

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");

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
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
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
