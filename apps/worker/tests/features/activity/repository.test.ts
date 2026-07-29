import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { findMappingTransaction } from "../../../src/features/activity/repository";

class SqliteQueryStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    return (
      (this.database.prepare(this.sql).get(...(this.values as never[])) as T) ??
      null
    );
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("activity repository", () => {
  it("loads a mapping transaction with SQLite-compatible aliases", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE bank_accounts (
        id TEXT PRIMARY KEY,
        account_type TEXT
      );
      CREATE TABLE bank_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        posted_date TEXT,
        authorized_at TEXT,
        amount REAL NOT NULL,
        currency TEXT NOT NULL
      );
      INSERT INTO bank_accounts (id, account_type)
      VALUES ('card-1', 'credit');
      INSERT INTO bank_transactions
        (id, account_id, posted_date, amount, currency)
      VALUES
        ('transaction-1', 'card-1', '2026-07-13', -35, 'TWD');
    `);
    const db = {
      prepare(sql: string) {
        return new SqliteQueryStatement(database, sql);
      },
    } as unknown as D1Database;

    await expect(findMappingTransaction(db, "transaction-1")).resolves.toEqual({
      id: "transaction-1",
      postedDate: "2026-07-13",
      authorizedAt: null,
      amount: -35,
      currency: "TWD",
      accountType: "credit",
    });
  });
});
