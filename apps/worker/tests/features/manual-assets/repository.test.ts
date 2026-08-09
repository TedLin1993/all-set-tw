import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  listManualAssetHistory,
  updateManualAsset,
} from "../../../src/features/manual-assets/repository";

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

  async run() {
    this.database.prepare(this.sql).run(...(this.values as never[]));
  }

  async all<T>() {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...(this.values as never[])) as T[],
    };
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("manual asset repository", () => {
  it("lists valuation history from oldest to newest", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE net_worth_history (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        net_worth REAL NOT NULL,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        snapshotted_at TEXT NOT NULL
      );
      INSERT INTO net_worth_history
        (id, date, net_worth, asset_type, source, snapshotted_at)
      VALUES
        ('new', '2026-08-03', 4790, 'manual:stock', 'manual', '2026-08-03T00:00:00.000Z'),
        ('old', '2025-03-03', 3031, 'manual:stock', 'manual', '2025-03-03T00:00:00.000Z');
    `);
    const db = {
      prepare(sql: string) {
        return new SqliteQueryStatement(database, sql);
      },
    } as unknown as D1Database;

    await expect(listManualAssetHistory(db, "manual:stock")).resolves.toEqual([
      { date: "2025-03-03", value: 3031 },
      { date: "2026-08-03", value: 4790 },
    ]);
  });

  it("updates asset metadata and its current valuation atomically", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE manual_assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        note TEXT,
        currency TEXT NOT NULL
      );
      CREATE TABLE net_worth_history (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        net_worth REAL NOT NULL,
        asset_type TEXT NOT NULL,
        source TEXT NOT NULL,
        snapshotted_at TEXT NOT NULL,
        UNIQUE(source, asset_type, date)
      );
      INSERT INTO manual_assets (id, name, category, note, currency)
      VALUES ('manual:home', '舊名稱', 'real_estate', '舊備註', 'TWD');
      INSERT INTO net_worth_history
        (id, date, net_worth, asset_type, source, snapshotted_at)
      VALUES
        ('manual:manual:home:2026-08-01', '2026-08-01', 100, 'manual:home', 'manual', '2026-08-01T00:00:00.000Z');
    `);
    const db = {
      prepare(sql: string) {
        return new SqliteQueryStatement(database, sql);
      },
      async batch(statements: SqliteQueryStatement[]) {
        for (const statement of statements) await statement.run();
      },
    } as unknown as D1Database;

    await updateManualAsset(
      db,
      "manual:home",
      {
        name: "新名稱",
        note: null,
        currency: "USD",
        value: 125,
        date: "2026-08-03",
      },
      "2026-08-03T12:00:00.000Z",
    );

    expect(database.prepare("SELECT * FROM manual_assets").get()).toMatchObject(
      {
        name: "新名稱",
        note: null,
        currency: "USD",
      },
    );
    expect(
      database
        .prepare(
          "SELECT date, net_worth, snapshotted_at FROM net_worth_history WHERE date = '2026-08-03'",
        )
        .get(),
    ).toEqual({
      date: "2026-08-03",
      net_worth: 125,
      snapshotted_at: "2026-08-03T12:00:00.000Z",
    });
  });
});
