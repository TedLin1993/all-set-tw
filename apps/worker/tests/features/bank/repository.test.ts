import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBankAccounts,
  listBankTransactions,
  listBankTransactionsForTransferMatching,
  listBankTransactionsInRange,
  listCreditCardBills,
  listCreditCardBillsInRange,
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
      async raw() {
        return (
          this.database.prepare(sql).all(...(values as never[])) as Record<
            string,
            unknown
          >[]
        ).map((row) => Object.values(row));
      },
      async first<T>() {
        return (
          (this.database.prepare(sql).get(...(values as never[])) as T) ?? null
        );
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

describe("bank list and detail queries", () => {
  it("joins the latest balance and hides canonical or inactive accounts", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, institution_name, account_name, account_type,
         currency, canonical_account_id, inactive_at, opened_date, maturity_date,
         created_at, updated_at)
      VALUES
        ('canonical', 'tdcc', 'canonical', '測試銀行', '別名', 'savings', 'TWD',
         'account-a', NULL, NULL, NULL, '2026-08-22', '2026-08-22'),
        ('inactive', 'tdcc', 'inactive', '測試銀行', '停用', 'savings', 'TWD',
         NULL, '2026-08-01', NULL, NULL, '2026-08-22', '2026-08-22');
      INSERT INTO bank_balance_snapshots
        (id, connector_id, account_id, source_id, balance, currency, as_of_at,
         created_at, updated_at)
      VALUES
        ('old', 'tdcc', 'account-a', 'old', 100, 'TWD', '2026-08-01', '2026-08-01', '2026-08-01'),
        ('new', 'tdcc', 'account-a', 'new', 250, 'TWD', '2026-08-22', '2026-08-22', '2026-08-22');
    `);
    const rows = await listBankAccounts(db as unknown as D1Database);
    expect(rows.map((row) => row.id).sort()).toEqual([
      "account-a",
      "account-b",
      "account-c",
    ]);
    expect(rows.find((row) => row.id === "account-a")).toMatchObject({
      balance: 250,
      openedDate: null,
      maturityDate: null,
    });
    expect(rows.find((row) => row.id === "account-b")).toMatchObject({
      balance: null,
      availableBalance: null,
      asOfAt: null,
    });
  });

  it("hides matched pending rows and keeps unmatched pending plus user prefs", async () => {
    const db = createDb();
    db.database.exec(`
      UPDATE bank_transactions SET matched_transaction_id = 'out' WHERE id = 'pending';
      INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, amount, currency,
         status, created_at, updated_at)
      VALUES
        ('open-pending', 'tdcc', 'account-a', 'open-pending', '2026-08-21', -50, 'TWD',
         'pending', '2026-08-21', '2026-08-21');
      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('out', 1, '2026-08-22', '2026-08-22');
    `);
    const rows = await listBankTransactions(db as unknown as D1Database, 20);
    expect(rows.map((row) => row.id)).toEqual([
      "other-day",
      "late",
      "out",
      "in",
      "open-pending",
    ]);
    expect(rows.find((row) => row.id === "out")).toMatchObject({
      status: "posted",
      calculationPreference: 1,
    });
    expect(rows.find((row) => row.id === "open-pending")).toMatchObject({
      status: "pending",
      calculationPreference: null,
    });
    expect(rows.some((row) => row.id === "pending")).toBe(false);
    const next = await listBankTransactions(db as unknown as D1Database, 2, {
      effectiveDate: "2026-08-22",
      updatedAt: "2026-08-22",
      id: "out",
    });
    expect(next.map((row) => row.id)).toEqual(["in", "open-pending"]);
  });

  it("pages credit-card bills and filters by YYYY-MM TEXT boundaries", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO credit_card_bills (
        id, connector_id, account_id, source_id, billing_period, currency,
        created_at, updated_at
      ) VALUES
        ('jul', 'tdcc', 'account-a', 'jul', '2026-07', 'TWD', '2026-07-01', '2026-07-01'),
        ('aug-b', 'tdcc', 'account-b', 'aug-b', '2026-08', 'TWD', '2026-08-01', '2026-08-01'),
        ('aug-a', 'tdcc', 'account-a', 'aug-a', '2026-08', 'TWD', '2026-08-01', '2026-08-01');
    `);
    const first = await listCreditCardBills(db as unknown as D1Database, 2);
    expect(first.map((row) => row.id)).toEqual(["aug-a", "aug-b"]);
    const next = await listCreditCardBills(db as unknown as D1Database, 2, {
      billingPeriod: first[1].billingPeriod,
      accountId: first[1].accountId,
      id: first[1].id,
    });
    expect(next.map((row) => row.id)).toEqual(["jul"]);
    expect(
      (
        await listCreditCardBillsInRange(db as unknown as D1Database, {
          from: "2026-08-01",
          to: "2026-09-01",
        })
      ).map((row) => row.id),
    ).toEqual(["aug-a", "aug-b"]);
  });
});
