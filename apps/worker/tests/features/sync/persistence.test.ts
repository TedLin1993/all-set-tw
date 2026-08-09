import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  persistStagedSyncWrite,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";
import {
  linkCanonicalBankAccountsStatement,
  reconcileEsunLifecycleShadowStatements,
  reconcileEsunSingleCardSummaryAccountStatements,
  reconcileSinopacLegacyTransactionStatements,
} from "../../../src/features/sync/repository";

class SqliteStatement {
  private values: unknown[] = [];

  constructor(
    private readonly owner: SqliteD1,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    return this.execute();
  }

  execute() {
    this.owner.executedSql.push(this.sql);
    const result = this.owner.database
      .prepare(this.sql)
      .run(...(this.values as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes) },
      results: [],
    };
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  readonly executedSql: string[] = [];

  constructor() {
    this.database.exec("PRAGMA foreign_keys = ON");
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
    return new SqliteStatement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) =>
        (statement as unknown as SqliteStatement).execute(),
      );
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

const databases: SqliteD1[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb() {
  const db = new SqliteD1();
  databases.push(db);
  db.database
    .prepare(
      `INSERT INTO connector_settings
      (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at)
     VALUES ('tdcc-settings', 'tdcc', 'encrypted', 'old-cursor', '2026-01-01', '2026-01-01')`,
    )
    .run();
  return db;
}

function bankAccountRecord(index: number): SyncWriteRecord {
  const id = `tdcc:account-${index}`;
  return {
    entityType: "bank_account",
    recordKey: id,
    payload: {
      id,
      connector_id: "tdcc",
      source_id: `account-${index}`,
      institution_name: "測試銀行",
      account_name: `測試帳戶 ${index}`,
      account_type: "savings",
      currency: "TWD",
      credit_limit: null,
      bank_code: "004",
      account_last4: String(index).padStart(4, "0").slice(-4),
      raw_payload: "{}",
      created_at: "2026-07-19T00:00:00.000Z",
      updated_at: "2026-07-19T00:00:00.000Z",
    },
  };
}

function bankTransactionRecord(
  sourceId: string,
  status: "pending" | "posted",
  dates: { authorizedAt: string; postedDate?: string },
): SyncWriteRecord {
  const id = `tdcc:account-0:${sourceId}`;
  return {
    entityType: "bank_transaction",
    recordKey: id,
    payload: {
      id,
      connector_id: "tdcc",
      account_id: "tdcc:account-0",
      source_id: sourceId,
      posted_date: dates.postedDate ?? null,
      authorized_at: dates.authorizedAt,
      amount: -252,
      currency: "TWD",
      description: "全支付﹘全聯",
      counterparty: "全支付﹘全聯",
      status,
      raw_payload: JSON.stringify({ status }),
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: dates.postedDate ?? dates.authorizedAt,
    },
  };
}

function creditCardBillRecord(
  paidAmount: number | null,
  isPaid: 0 | 1 | null,
): SyncWriteRecord {
  return {
    entityType: "credit_card_bill",
    recordKey: "tdcc:account-0:2026-07",
    payload: {
      id: "tdcc:account-0:2026-07",
      connector_id: "tdcc",
      account_id: "tdcc:account-0",
      source_id: "statement-2026-07",
      billing_period: "2026-07",
      statement_amount: 1000,
      minimum_payment: 100,
      paid_amount: paidAmount,
      is_paid: isPaid,
      payment_due_date: "2026-08-08",
      statement_closing_date: "2026-07-23",
      currency: "TWD",
      raw_payload: "{}",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-08-08T00:00:00.000Z",
    },
  };
}

describe("staged sync persistence", () => {
  it("seeds a disabled CTBC all-scope sync job", () => {
    const db = createDb();

    expect(
      db.database
        .prepare(
          `SELECT connector_id AS connectorId, scope, enabled, interval_minutes AS intervalMinutes
           FROM sync_jobs WHERE id = 'ctbc:all'`,
        )
        .get(),
    ).toEqual({
      connectorId: "ctbc",
      scope: "all",
      enabled: 0,
      intervalMinutes: 1440,
    });
  });

  it("links TDCC bank 822 records to the direct CTBC account", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, institution_name, account_name, account_type,
         currency, bank_code, account_last4, raw_payload, created_at, updated_at)
      VALUES
        ('ctbc:bank:ctbc:12345', 'ctbc', 'bank:ctbc:12345', '中國信託銀行',
         '末五碼 12345', 'savings', 'TWD', '822', '2345', '{}', '2026-07-29', '2026-07-29'),
        ('tdcc:settlement:822:12345', 'tdcc', 'settlement:822:12345', '中國信託銀行',
         '交割帳戶', 'settlement_cash', 'TWD', '822', '2345', '{}', '2026-07-29', '2026-07-29');
    `);

    await db.batch([
      linkCanonicalBankAccountsStatement(
        db as unknown as D1Database,
      ) as unknown as D1PreparedStatement,
    ]);

    expect(
      db.database
        .prepare(
          `SELECT canonical_account_id AS canonicalAccountId
           FROM bank_accounts WHERE connector_id = 'tdcc' AND bank_code = '822'`,
        )
        .get(),
    ).toEqual({ canonicalAccountId: "ctbc:bank:ctbc:12345" });
  });

  it("migrates preferences and removes E.SUN lifecycle shadow transactions", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('esun:credit:esun:1204', 'esun', 'credit:esun:1204', 'credit', 'TWD', '{}', '2026-07-01', '2026-07-01');

      INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, amount, currency, description, raw_payload, created_at, updated_at)
      VALUES
        ('shadow-posted', 'esun', 'esun:credit:esun:1204', '2026-07-05:credit:esun:1204:全聯:252:TWD:已入帳:1', '2026-07-05', 252, 'TWD', '全聯', '{}', '2026-07-05', '2026-07-05'),
        ('shadow-pending', 'esun', 'esun:credit:esun:1204', '2026-07-05:credit:esun:1204:全聯:252:TWD:未入帳:1', '2026-07-05', 252, 'TWD', '全聯', '{}', '2026-07-05', '2026-07-05'),
        ('canonical', 'esun', 'esun:credit:esun:1204', '2026-07-05:credit:esun:1204:全聯:252:TWD:1', '2026-07-05', 252, 'TWD', '全聯', '{}', '2026-07-05', '2026-07-05');

      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('shadow-posted', 1, '2026-07-05', '2026-07-05');

      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES ('old-override', 'bank_transaction', 'shadow-posted', 'shopping', '2026-07-05', '2026-07-05');
    `);

    await db.batch(
      reconcileEsunLifecycleShadowStatements(db as unknown as D1Database),
    );

    expect(
      db.database
        .prepare("SELECT id FROM bank_transactions ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["canonical"]);
    expect(
      db.database
        .prepare(
          "SELECT transaction_id, excluded_from_calculation FROM bank_transaction_preferences",
        )
        .get(),
    ).toEqual({ transaction_id: "canonical", excluded_from_calculation: 1 });
    expect(
      db.database
        .prepare("SELECT target_id, category_id FROM classification_overrides")
        .get(),
    ).toEqual({ target_id: "canonical", category_id: "shopping" });
  });

  it("merges the E.SUN single-card summary account into the physical card", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, institution_name, account_name, account_type,
         currency, raw_payload, created_at, updated_at)
      VALUES
        ('esun-main', 'esun', 'credit:esun:main', '玉山銀行', '玉山信用卡',
         'credit', 'TWD', '{}', '2026-07-01', '2026-08-09'),
        ('esun-1204', 'esun', 'credit:esun:1204', '玉山銀行', '玉山 Unicard',
         'credit', 'TWD', '{}', '2026-07-01', '2026-08-09');

      INSERT INTO bank_balance_snapshots
        (id, connector_id, account_id, source_id, balance, currency, as_of_at,
         raw_payload, created_at, updated_at)
      VALUES
        ('old-balance', 'esun', 'esun-main', 'credit:esun:main:2026-08-08',
         -14510, 'TWD', '2026-08-08', '{}', '2026-08-08', '2026-08-08'),
        ('new-balance', 'esun', 'esun-1204', 'credit:esun:1204:2026-08-09',
         -14510, 'TWD', '2026-08-09', '{}', '2026-08-09', '2026-08-09');

      INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, amount, currency,
         description, status, raw_payload, created_at, updated_at)
      VALUES
        ('main-transaction', 'esun', 'esun-main', 'fallback-transaction',
         '2026-07-20', -500, 'TWD', '測試交易', 'posted', '{}',
         '2026-07-20', '2026-07-20');

      INSERT INTO credit_card_bills
        (id, connector_id, account_id, source_id, billing_period,
         statement_amount, currency, raw_payload, created_at, updated_at)
      VALUES
        ('old-june', 'esun', 'esun-main', 'main:bill:2026-06', '2026-06',
         5000, 'TWD', '{}', '2026-06-23', '2026-06-23'),
        ('old-july', 'esun', 'esun-main', 'main:bill:2026-07', '2026-07',
         14000, 'TWD', '{}', '2026-07-23', '2026-07-23'),
        ('new-july', 'esun', 'esun-1204', '1204:bill:2026-07', '2026-07',
         14510, 'TWD', '{}', '2026-08-09', '2026-08-09');
    `);

    await db.batch(
      reconcileEsunSingleCardSummaryAccountStatements(
        db as unknown as D1Database,
      ),
    );

    expect(
      db.database
        .prepare(
          "SELECT source_id AS sourceId FROM bank_accounts WHERE connector_id = 'esun'",
        )
        .all(),
    ).toEqual([{ sourceId: "credit:esun:1204" }]);
    expect(
      db.database
        .prepare(
          "SELECT DISTINCT account_id AS accountId FROM bank_balance_snapshots WHERE connector_id = 'esun'",
        )
        .all(),
    ).toEqual([{ accountId: "esun-1204" }]);
    expect(
      db.database
        .prepare(
          "SELECT account_id AS accountId FROM bank_transactions WHERE connector_id = 'esun'",
        )
        .get(),
    ).toEqual({ accountId: "esun-1204" });
    expect(
      db.database
        .prepare(
          `SELECT billing_period AS billingPeriod, statement_amount AS statementAmount,
                  account_id AS accountId
           FROM credit_card_bills WHERE connector_id = 'esun'
           ORDER BY billing_period`,
        )
        .all(),
    ).toEqual([
      {
        billingPeriod: "2026-06",
        statementAmount: 5000,
        accountId: "esun-1204",
      },
      {
        billingPeriod: "2026-07",
        statementAmount: 14510,
        accountId: "esun-1204",
      },
    ]);
  });

  it("keeps the E.SUN summary account when multiple physical cards exist", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload,
         created_at, updated_at)
      VALUES
        ('esun-main', 'esun', 'credit:esun:main', 'credit', 'TWD', '{}',
         '2026-07-01', '2026-08-09'),
        ('esun-1204', 'esun', 'credit:esun:1204', 'credit', 'TWD', '{}',
         '2026-07-01', '2026-08-09'),
        ('esun-9876', 'esun', 'credit:esun:9876', 'credit', 'TWD', '{}',
         '2026-07-01', '2026-08-09');
    `);

    await db.batch(
      reconcileEsunSingleCardSummaryAccountStatements(
        db as unknown as D1Database,
      ),
    );

    expect(
      db.database
        .prepare(
          "SELECT COUNT(*) AS count FROM bank_accounts WHERE connector_id = 'esun'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("migrates preferences and removes matching legacy Sinopac transaction ids", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('sinopac:credit:sinopac:main', 'sinopac', 'credit:sinopac:main', 'credit', 'TWD', '{}', '2026-07-01', '2026-07-01');

      INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, status, raw_payload, created_at, updated_at)
      VALUES
        ('sinopac-legacy', 'sinopac', 'sinopac:credit:sinopac:main', 'sinopac:card:tx:TWD:legacy', '2026-07-19', NULL, -260, 'TWD', '連支＊餐廳', 'posted', '{}', '2026-07-19', '2026-07-19'),
        ('sinopac-canonical', 'sinopac', 'sinopac:credit:sinopac:main', 'sinopac:card:tx:v2:TWD:2026-07-19:-260:8000:1', '2026-07-22', '2026-07-19', -260, 'TWD', '連支＊餐廳', 'posted', '{}', '2026-07-22', '2026-07-22');

      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('sinopac-legacy', 1, '2026-07-19', '2026-07-19');

      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES ('sinopac-legacy-override', 'bank_transaction', 'sinopac-legacy', 'shopping', '2026-07-19', '2026-07-19');
    `);

    await db.batch(
      reconcileSinopacLegacyTransactionStatements(db as unknown as D1Database),
    );

    expect(
      db.database
        .prepare("SELECT id FROM bank_transactions ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["sinopac-canonical"]);
    expect(
      db.database
        .prepare(
          "SELECT transaction_id AS transactionId FROM bank_transaction_preferences",
        )
        .get(),
    ).toEqual({ transactionId: "sinopac-canonical" });
    expect(
      db.database
        .prepare("SELECT target_id AS targetId FROM classification_overrides")
        .get(),
    ).toEqual({ targetId: "sinopac-canonical" });
  });

  it("stages records in bounded JSON chunks and advances the cursor only after promotion", async () => {
    const db = createDb();
    const records = Array.from({ length: 205 }, (_, index) =>
      bankAccountRecord(index),
    );
    records.push({
      entityType: "bank_transaction",
      recordKey: "tdcc:account-0:transaction-1",
      payload: {
        id: "tdcc:account-0:transaction-1",
        connector_id: "tdcc",
        account_id: "tdcc:account-0",
        source_id: "transaction-1",
        posted_date: "2026-07-19",
        authorized_at: null,
        amount: 100,
        currency: "TWD",
        description: null,
        counterparty: null,
        status: "posted",
        raw_payload: "{}",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
      },
    });

    await persistStagedSyncWrite(db as unknown as D1Database, {
      records,
      finalizeStatements: [
        db
          .prepare(
            "UPDATE connector_settings SET sync_cursor = ? WHERE connector_id = ?",
          )
          .bind("new-cursor", "tdcc") as unknown as D1PreparedStatement,
      ],
    });

    expect(
      db.executedSql.filter((sql) =>
        sql.includes("INSERT INTO sync_write_staging"),
      ),
    ).toHaveLength(3);
    expect(
      db.database.prepare("SELECT COUNT(*) AS count FROM bank_accounts").get(),
    ).toMatchObject({ count: 205 });
    expect(
      db.database
        .prepare(
          "SELECT effective_date AS effectiveDate FROM bank_transactions",
        )
        .get(),
    ).toMatchObject({ effectiveDate: "2026-07-19" });
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM sync_write_staging")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      db.database
        .prepare(
          "SELECT sync_cursor AS cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .get(),
    ).toMatchObject({ cursor: "new-cursor" });
  });

  it("upgrades pending to posted in place and never downgrades posted history", async () => {
    const db = createDb();
    const pending = bankTransactionRecord("purchase-1", "pending", {
      authorizedAt: "2026-07-05T00:00:00.000Z",
    });

    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [bankAccountRecord(0), pending],
    });
    db.database
      .prepare(
        `INSERT INTO bank_transaction_preferences
         (transaction_id, excluded_from_calculation, created_at, updated_at)
         VALUES (?, 1, '2026-07-05', '2026-07-05')`,
      )
      .run(pending.recordKey);

    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [
        bankTransactionRecord("purchase-1", "posted", {
          authorizedAt: "2026-07-05",
          postedDate: "2026-07-07T00:00:00.000Z",
        }),
      ],
    });
    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [pending],
    });

    expect(
      db.database
        .prepare(
          `SELECT id, status, authorized_at AS authorizedAt,
                  posted_date AS postedDate,
                  json_extract(raw_payload, '$.status') AS rawStatus
           FROM bank_transactions WHERE source_id = 'purchase-1'`,
        )
        .get(),
    ).toEqual({
      id: pending.recordKey,
      status: "posted",
      authorizedAt: "2026-07-05T00:00:00.000Z",
      postedDate: "2026-07-07T00:00:00.000Z",
      rawStatus: "posted",
    });
    expect(
      db.database
        .prepare(
          "SELECT excluded_from_calculation AS excluded FROM bank_transaction_preferences WHERE transaction_id = ?",
        )
        .get(pending.recordKey),
    ).toEqual({ excluded: 1 });

    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [
        bankTransactionRecord("purchase-2", "pending", {
          authorizedAt: "2026-07-08T00:00:00.000Z",
        }),
      ],
    });
    await persistStagedSyncWrite(db as unknown as D1Database, { records: [] });
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM bank_transactions")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("preserves confirmed credit card payment data when a later sync omits it", async () => {
    const db = createDb();

    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [bankAccountRecord(0), creditCardBillRecord(1000, 1)],
    });
    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [creditCardBillRecord(null, null)],
    });

    expect(
      db.database
        .prepare(
          `SELECT paid_amount AS paidAmount, is_paid AS isPaid
           FROM credit_card_bills WHERE billing_period = '2026-07'`,
        )
        .get(),
    ).toEqual({ paidAmount: 1000, isPaid: 1 });
  });

  it("rolls back promotion and leaves the cursor unchanged when a staged record is invalid", async () => {
    const db = createDb();
    const invalidTransaction: SyncWriteRecord = {
      entityType: "bank_transaction",
      recordKey: "missing-account:transaction",
      payload: {
        id: "missing-account:transaction",
        connector_id: "tdcc",
        account_id: "missing-account",
        source_id: "transaction",
        posted_date: "2026-07-19",
        authorized_at: null,
        amount: 100,
        currency: "TWD",
        description: null,
        counterparty: null,
        status: "posted",
        raw_payload: "{}",
        created_at: "2026-07-19T00:00:00.000Z",
        updated_at: "2026-07-19T00:00:00.000Z",
      },
    };

    await expect(
      persistStagedSyncWrite(db as unknown as D1Database, {
        records: [invalidTransaction],
        finalizeStatements: [
          db
            .prepare(
              "UPDATE connector_settings SET sync_cursor = ? WHERE connector_id = ?",
            )
            .bind("new-cursor", "tdcc") as unknown as D1PreparedStatement,
        ],
      }),
    ).rejects.toThrow();

    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM bank_transactions")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      db.database
        .prepare("SELECT COUNT(*) AS count FROM sync_write_staging")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      db.database
        .prepare(
          "SELECT sync_cursor AS cursor FROM connector_settings WHERE connector_id = 'tdcc'",
        )
        .get(),
    ).toMatchObject({ cursor: "old-cursor" });
  });
});
