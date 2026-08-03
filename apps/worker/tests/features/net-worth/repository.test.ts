import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listNetWorthChartHistory } from "../../../src/features/net-worth/repository";

class SqliteQueryStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
  ) {}

  async all<T>() {
    return { results: this.database.prepare(this.sql).all() as T[] };
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("net worth repository", () => {
  it("converts manual asset history from its original currency to TWD", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE manual_assets (
        id TEXT PRIMARY KEY,
        currency TEXT NOT NULL
      );
      CREATE TABLE exchange_rates (
        currency TEXT PRIMARY KEY,
        rate_to_twd REAL NOT NULL
      );
      CREATE TABLE net_worth_history (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        net_worth REAL NOT NULL,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL
      );
      INSERT INTO manual_assets (id, currency)
      VALUES ('manual:usd-policy', 'USD'), ('manual:home', 'TWD');
      INSERT INTO exchange_rates (currency, rate_to_twd) VALUES ('USD', 32);
      INSERT INTO net_worth_history
        (id, date, net_worth, asset_type, source)
      VALUES
        ('usd', '2026-08-01', 100, 'manual:usd-policy', 'manual'),
        ('twd', '2026-08-01', 5000, 'manual:home', 'manual');
    `);
    const db = {
      prepare(sql: string) {
        return new SqliteQueryStatement(database, sql);
      },
    } as unknown as D1Database;

    await expect(listNetWorthChartHistory(db)).resolves.toEqual([
      {
        date: "2026-08-01",
        netWorth: 5000,
        assetType: "manual:home",
        source: "manual",
      },
      {
        date: "2026-08-01",
        netWorth: 3200,
        assetType: "manual:usd-policy",
        source: "manual",
      },
    ]);
  });
});
