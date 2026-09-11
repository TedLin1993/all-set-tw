import { prepareCtbcAuthorizationWrite } from "../../../src/features/sync/ctbc-authorizations";
import { findActivitySearchDays } from "../../../src/features/activity/search-repository";
import { resolveClassifications } from "../../../src/features/classification/service";
import { prepareSinopacAuthorizationWrite } from "../../../src/features/sync/sinopac-authorizations";
import { prepareObankTimeDepositWrite } from "../../../src/features/sync/obank-time-deposits";
import {
  bankAccountRecord as mapAccount,
  bankBalanceSnapshotRecord as mapBalance,
} from "../../../src/features/sync/record-mapper";
import {
  listBankAccounts,
  listBankTransactions,
  listBankTransactionsInRange,
} from "../../../src/features/bank/repository";
import { calculateBankDepositValue } from "../../../src/features/net-worth/repository";
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
  reconcileHncbLegacyTransactionStatements,
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

  async all<T>() {
    return this.execute() as unknown as { results: T[] };
  }

  async first<T>() {
    this.owner.executedSql.push(this.sql);
    return (
      (this.owner.database
        .prepare(this.sql)
        .get(...(this.values as never[])) as T) ?? null
    );
  }

  execute() {
    this.owner.executedSql.push(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      return {
        success: true,
        meta: { changes: 0 },
        results: this.owner.database
          .prepare(this.sql)
          .all(...(this.values as never[])),
      };
    }
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

  it("seeds a disabled SKBank all-scope sync job", () => {
    const db = createDb();

    expect(
      db.database
        .prepare(
          `SELECT connector_id AS connectorId, scope, enabled, interval_minutes AS intervalMinutes
           FROM sync_jobs WHERE id = 'skbank:all'`,
        )
        .get(),
    ).toEqual({
      connectorId: "skbank",
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

  it("links TDCC bank 008 records to the direct HNCB account", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, institution_name, account_name, account_type,
         currency, bank_code, account_last4, raw_payload, created_at, updated_at)
      VALUES
        ('hncb:bank:hncb:777201604933', 'hncb', 'bank:hncb:777201604933', '華南銀行',
         '末五碼 04933', 'savings', 'TWD', '008', '4933', '{}', '2026-08-19', '2026-08-19'),
        ('tdcc:settlement:008:777201604933', 'tdcc', 'settlement:008:777201604933', '華南銀行',
         '交割帳戶', 'settlement_cash', 'TWD', '008', '4933', '{}', '2026-08-19', '2026-08-19');
    `);

    await db.batch([
      linkCanonicalBankAccountsStatement(
        db as unknown as D1Database,
      ) as unknown as D1PreparedStatement,
    ]);

    expect(
      db.database
        .prepare(
          `SELECT connector_id AS connectorId, canonical_account_id AS canonicalAccountId
           FROM bank_accounts WHERE bank_code = '008' ORDER BY connector_id`,
        )
        .all(),
    ).toEqual([
      { connectorId: "hncb", canonicalAccountId: null },
      {
        connectorId: "tdcc",
        canonicalAccountId: "hncb:bank:hncb:777201604933",
      },
    ]);
  });

  it("links TDCC bank 103 records to the direct SKBank account", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, institution_name, account_name, account_type,
         currency, bank_code, account_last4, raw_payload, created_at, updated_at)
      VALUES
        ('skbank-direct', 'skbank', 'bank:skbank:4321:hash', '新光銀行',
         '末四碼 4321', 'savings', 'TWD', '103', '4321', '{}', '2026-08-23', '2026-08-23'),
        ('tdcc-settlement', 'tdcc', 'settlement:103:987654321', '新光銀行',
         '交割帳戶', 'settlement_cash', 'TWD', '103', '4321', '{}', '2026-08-23', '2026-08-23');
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
           FROM bank_accounts WHERE id = 'tdcc-settlement'`,
        )
        .get(),
    ).toEqual({ canonicalAccountId: "skbank-direct" });
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

  it("repairs CTBC date-less IDs, links saved authorizations atomically and preserves preferences", async () => {
    const db = createDb();
    const d1 = db as unknown as D1Database;
    const make = (
      key: string,
      status: "pending" | "posted",
      date: string | null,
      metadata: Record<string, unknown> = {},
    ) => {
      const r = bankTransactionRecord(`ctbc:card:tx:${key}:1`, status, {
        authorizedAt: date ?? "",
        postedDate: date ? "2026-09-07" : undefined,
      });
      Object.assign(r.payload, {
        connector_id: "ctbc",
        authorized_at: date,
        raw_payload: JSON.stringify({
          cardLast4: "1234",
          authorizationHash: "ctbc-auth",
          ...metadata,
        }),
      });
      return r;
    };
    const legacy = make("legacy", "posted", null);
    const pending = make("pending", "pending", "2026-09-02T10:20:00+08:00");
    await persistStagedSyncWrite(d1, {
      records: [bankAccountRecord(0), legacy, pending],
    });
    db.database
      .prepare(
        "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES (?, 1, '2026-09-01', '2026-09-01')",
      )
      .run(pending.recordKey);
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('ctbc-category', 'bank_transaction', ?, 'shopping', 'now', 'now')",
      )
      .run(pending.recordKey);
    db.database
      .prepare(
        "INSERT INTO invoice_transaction_preferences VALUES ('ctbc-invoice', ?, 'linked', 'now', 'now')",
      )
      .run(pending.recordKey);
    const incoming = make("corrected", "posted", "2026-09-02", {
      legacySourceId: legacy.payload.source_id,
    });
    const write = await prepareCtbcAuthorizationWrite(d1, [incoming]);
    expect(write.records[0]!.recordKey).toBe(legacy.recordKey);
    await expect(
      persistStagedSyncWrite(d1, {
        ...write,
        finalizeStatements: [
          d1.prepare("INSERT INTO missing_table VALUES (1)"),
        ],
      }),
    ).rejects.toThrow();
    expect(
      db.database
        .prepare("SELECT authorized_at FROM bank_transactions WHERE id = ?")
        .get(legacy.recordKey)?.authorized_at,
    ).toBeNull();
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [incoming]),
    );
    expect(
      db.database.prepare("SELECT count(*) AS n FROM bank_transactions").get()
        ?.n,
    ).toBe(1);
    expect(
      db.database
        .prepare(
          "SELECT id, status, description, authorized_at, matched_transaction_id FROM bank_transactions",
        )
        .get(),
    ).toEqual({
      id: pending.recordKey,
      status: "posted",
      description: "全支付﹘全聯",
      authorized_at: "2026-09-02T10:20:00+08:00",
      matched_transaction_id: null,
    });
    expect(
      db.database
        .prepare(
          "SELECT excluded_from_calculation FROM bank_transaction_preferences WHERE transaction_id = ?",
        )
        .get(pending.recordKey)?.excluded_from_calculation,
    ).toBe(1);
    expect(
      db.database
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .get(pending.recordKey)?.category_id,
    ).toBe("shopping");
    expect(
      db.database
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'ctbc-invoice'",
        )
        .get()?.transaction_id,
    ).toBe(pending.recordKey);
    // Repeated sync and a changed feed identity still update the original row.
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [incoming]),
    );
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [
        make("next-feed", "posted", "2026-09-02"),
      ]),
    );
    expect(
      db.database.prepare("SELECT count(*) AS n FROM bank_transactions").get()
        ?.n,
    ).toBe(1);
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [
        make("pending", "posted", "2026-09-02", {
          legacySourceId: legacy.payload.source_id,
        }),
      ]),
    );
    expect(
      db.database
        .prepare("SELECT status FROM bank_transactions WHERE id = ?")
        .get(pending.recordKey)?.status,
    ).toBe("posted");
    expect(
      db.database.prepare("SELECT count(*) AS n FROM bank_transactions").get()
        ?.n,
    ).toBe(1);
    expect(await listBankTransactions(d1, 100)).toHaveLength(1);
  });

  it.each(["pending", "posted"] as const)(
    "merges a CTBC authorization already promoted by the connector (stored %s)",
    async (status) => {
      const db = createDb();
      const d1 = db as unknown as D1Database;
      const make = (key: string, state: "pending" | "posted", date: string) => {
        const record = bankTransactionRecord(`ctbc:card:tx:${key}:1`, state, {
          authorizedAt: date,
          postedDate: state === "posted" ? "2026-09-10" : undefined,
        });
        Object.assign(record.payload, {
          connector_id: "ctbc",
          raw_payload: JSON.stringify({ authorizationHash: "same-auth" }),
        });
        return record;
      };
      const authorization = make(
        "authorization",
        status,
        "2026-09-09T19:02:00+08:00",
      );
      const posted = make("posted", "posted", "2026-09-09");
      await persistStagedSyncWrite(d1, {
        records: [bankAccountRecord(0), authorization, posted],
      });
      db.database
        .prepare(
          "INSERT INTO invoice_transaction_preferences VALUES ('retained-invoice', ?, 'linked', 'now', 'now')",
        )
        .run(authorization.recordKey);
      const reconciled = make(
        "authorization",
        "posted",
        "2026-09-09T19:02:00+08:00",
      );
      // Existing broken data must also heal without the bank returning it again.
      await persistStagedSyncWrite(
        d1,
        await prepareCtbcAuthorizationWrite(
          d1,
          status === "pending" ? [reconciled] : [],
        ),
      );
      expect(
        db.database
          .prepare("SELECT id, status, authorized_at FROM bank_transactions")
          .all(),
      ).toEqual([
        {
          id: authorization.recordKey,
          status: "posted",
          authorized_at: "2026-09-09T19:02:00+08:00",
        },
      ]);
      // Either feed identity on later syncs must keep the same single activity.
      for (const incoming of [posted, reconciled, posted]) {
        await persistStagedSyncWrite(
          d1,
          await prepareCtbcAuthorizationWrite(d1, [incoming]),
        );
        expect(await listBankTransactions(d1, 100)).toHaveLength(1);
      }
      expect(
        db.database
          .prepare(
            "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'retained-invoice'",
          )
          .get()?.transaction_id,
      ).toBe(authorization.recordKey);
    },
  );

  it.each(["pending", "posted"] as const)(
    "does not pair ambiguous CTBC authorizations (%s) or downgrade posted rows",
    async (status) => {
      const db = createDb();
      const d1 = db as unknown as D1Database;
      const make = (key: string, status: "posted" | "pending") => {
        const r = bankTransactionRecord(`ctbc:card:tx:${key}:1`, status, {
          authorizedAt:
            key === "posted" ? "2026-09-02" : "2026-09-02T19:02:00+08:00",
          postedDate: status === "posted" ? "2026-09-07" : undefined,
        });
        Object.assign(r.payload, {
          connector_id: "ctbc",
          raw_payload: JSON.stringify({ authorizationHash: "ctbc-auth" }),
        });
        return r;
      };
      const posted = make("posted", "posted");
      await persistStagedSyncWrite(d1, {
        records: [
          bankAccountRecord(0),
          posted,
          make("a", status),
          make("b", status),
        ],
      });
      await persistStagedSyncWrite(
        d1,
        await prepareCtbcAuthorizationWrite(d1, [make("posted", "pending")]),
      );
      expect(await listBankTransactions(d1, 100)).toHaveLength(3);
      expect(
        db.database
          .prepare("SELECT status FROM bank_transactions WHERE id = ?")
          .get(posted.recordKey)?.status,
      ).toBe("posted");
      expect(
        db.database
          .prepare(
            "SELECT count(*) AS n FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
          )
          .get()?.n,
      ).toBe(0);
    },
  );

  it("promotes a unique CTBC authorization over a date-less posted row", async () => {
    const db = createDb();
    const d1 = db as unknown as D1Database;
    const make = (
      key: string,
      status: "posted" | "pending",
      date: string | null,
    ) => {
      const r = bankTransactionRecord(`ctbc:card:tx:${key}:1`, status, {
        authorizedAt: date ?? "",
        postedDate: date && status === "posted" ? "2026-07-10" : undefined,
      });
      Object.assign(r.payload, {
        connector_id: "ctbc",
        authorized_at: date,
        posted_date: date && status === "posted" ? "2026-07-10" : null,
        description: status === "posted" ? "全支付﹘全聯" : "全支付 全聯",
        counterparty: status === "posted" ? "全支付﹘全聯" : "全支付 全聯",
        raw_payload: JSON.stringify({
          cardLast4: status === "posted" ? undefined : "1234",
          authorizationHash: "ctbc-auth",
        }),
      });
      return r;
    };
    const posted = make("posted", "posted", null);
    const pending = make("pending", "pending", "2026-07-08T12:00:00+08:00");
    await persistStagedSyncWrite(d1, {
      records: [bankAccountRecord(0), posted],
    });
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('ctbc-posted', 'bank_transaction', ?, 'food', 'now', 'now')",
      )
      .run(posted.recordKey);
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('ctbc-pending', 'bank_transaction', ?, 'shopping', 'now', 'now')",
      )
      .run(pending.recordKey);
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [pending]),
    );
    expect(
      db.database
        .prepare(
          "SELECT id, status, description, counterparty, authorized_at, matched_transaction_id FROM bank_transactions",
        )
        .get(),
    ).toEqual({
      id: pending.recordKey,
      status: "posted",
      description: "全支付﹘全聯",
      counterparty: "全支付﹘全聯",
      authorized_at: "2026-07-08T12:00:00+08:00",
      matched_transaction_id: null,
    });
    expect(
      db.database
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .get(pending.recordKey)?.category_id,
    ).toBe("shopping");
    expect(await listBankTransactions(d1, 100)).toHaveLength(1);
  });

  it("keeps the posted CTBC classification when the authorization is unclassified", async () => {
    const db = createDb();
    const d1 = db as unknown as D1Database;
    const make = (key: string, status: "posted" | "pending") => {
      const r = bankTransactionRecord(`ctbc:card:tx:${key}:1`, status, {
        authorizedAt: status === "pending" ? "2026-07-08T12:00:00+08:00" : "",
        postedDate: undefined,
      });
      Object.assign(r.payload, {
        connector_id: "ctbc",
        authorized_at:
          status === "pending" ? "2026-07-08T12:00:00+08:00" : null,
        raw_payload: JSON.stringify({ authorizationHash: "ctbc-auth" }),
      });
      return r;
    };
    const posted = make("posted", "posted");
    const pending = make("pending", "pending");
    await persistStagedSyncWrite(d1, {
      records: [bankAccountRecord(0), posted],
    });
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('ctbc-posted-keep', 'bank_transaction', ?, 'food', 'now', 'now')",
      )
      .run(posted.recordKey);
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('ctbc-pending-other', 'bank_transaction', ?, 'other', 'now', 'now')",
      )
      .run(pending.recordKey);
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, [pending]),
    );
    expect(
      db.database
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .get(pending.recordKey)?.category_id,
    ).toBe("food");
    expect(
      db.database.prepare("SELECT id, status FROM bank_transactions").get(),
    ).toEqual({ id: pending.recordKey, status: "posted" });
  });

  it("promotes a previously hidden CTBC authorization in place", async () => {
    const db = createDb();
    const d1 = db as unknown as D1Database;
    const posted = bankTransactionRecord("ctbc:card:tx:posted:1", "posted", {
      authorizedAt: "",
      postedDate: "2026-07-10",
    });
    const pending = bankTransactionRecord("ctbc:card:tx:pending:1", "pending", {
      authorizedAt: "2026-07-08T12:00:00+08:00",
    });
    Object.assign(posted.payload, {
      connector_id: "ctbc",
      description: "全支付﹘全聯",
      counterparty: "全支付﹘全聯",
      raw_payload: JSON.stringify({ authorizationHash: "ctbc-auth" }),
    });
    Object.assign(pending.payload, {
      connector_id: "ctbc",
      description: "全支付 全聯",
      counterparty: "全支付 全聯",
      raw_payload: JSON.stringify({ authorizationHash: "ctbc-auth" }),
    });
    await persistStagedSyncWrite(d1, {
      records: [bankAccountRecord(0), posted, pending],
    });
    db.database
      .prepare(
        "UPDATE bank_transactions SET matched_transaction_id = ? WHERE id = ?",
      )
      .run(posted.recordKey, pending.recordKey);
    await persistStagedSyncWrite(
      d1,
      await prepareCtbcAuthorizationWrite(d1, []),
    );
    expect(
      db.database
        .prepare(
          "SELECT id, status, description, authorized_at FROM bank_transactions",
        )
        .get(),
    ).toEqual({
      id: pending.recordKey,
      status: "posted",
      description: "全支付﹘全聯",
      authorized_at: "2026-07-08T12:00:00+08:00",
    });
  });

  it("retains unmatched authorizations and later restores time without duplicate spending", async () => {
    const db = createDb();
    const d1 = db as unknown as D1Database;
    const make = (
      currency: string,
      amount: number,
      status: "pending" | "posted",
    ) => {
      const record = bankTransactionRecord(
        `sinopac:card:tx:v2:${currency}:2026-09-04:${amount}:4303:1`,
        status,
        {
          authorizedAt:
            status === "pending" ? "2026-09-04T18:57:25+08:00" : "2026-09-04",
          postedDate: status === "posted" ? "2026-09-08" : undefined,
        },
      );
      Object.assign(record.payload, {
        connector_id: "sinopac",
        amount,
        currency,
        description:
          status === "pending"
            ? "餐廳/UNAGISHIKISHIMA"
            : "A- UNAGISHIKISHIMA OKINAWA JP",
      });
      return record;
    };
    const pending = make("TWD", -1096, "pending");
    await persistStagedSyncWrite(d1, {
      records: [bankAccountRecord(0), pending],
    });
    const apply = async (
      incoming: SyncWriteRecord[],
      authorizations: SyncWriteRecord[],
      fail = false,
    ) => {
      const write = await prepareSinopacAuthorizationWrite(
        d1,
        incoming,
        authorizations,
      );
      await persistStagedSyncWrite(d1, {
        ...write,
        afterPromoteStatements: [...write.afterPromoteStatements],
        finalizeStatements: fail
          ? [d1.prepare("INSERT INTO missing_table VALUES (1)")]
          : [],
      });
    };
    await expect(apply([], [], true)).rejects.toThrow();
    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
        )
        .all(),
    ).toHaveLength(0);
    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .all(),
    ).toHaveLength(1);
    await apply([], []);
    expect(await listBankTransactions(d1, 100)).toHaveLength(1);
    expect(
      await listBankTransactionsInRange(d1, {
        from: "2026-09-01",
        to: "2026-10-01",
      }),
    ).toHaveLength(1);
    expect(await findActivitySearchDays(d1, { q: "UNAGISHIKISHIMA" })).toEqual([
      "2026-09-04",
    ]);
    expect(
      db.database.prepare("SELECT * FROM bank_transactions").all(),
    ).toHaveLength(1);

    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      db.database
        .prepare(
          "SELECT authorized_at FROM bank_transactions WHERE status = 'pending'",
        )
        .get()?.authorized_at,
    ).toBe("2026-09-04T18:57:25+08:00");
    const posted = make("JPY", -5500, "posted");
    await expect(apply([posted], [], true)).rejects.toThrow();
    expect(
      db.database
        .prepare(
          "SELECT matched_transaction_id FROM bank_transactions WHERE status = 'pending'",
        )
        .get()?.matched_transaction_id,
    ).toBeNull();
    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .all(),
    ).toHaveLength(1);
    await apply([posted], []);
    const expectFoodName = async (id: string) => {
      const row = (await listBankTransactions(d1, 100)).find(
        (transaction) => transaction.id === id,
      )!;
      expect(row).toMatchObject({
        description: "餐廳/UNAGISHIKISHIMA",
        counterparty: "餐廳/UNAGISHIKISHIMA",
        status: "posted",
      });
      expect((await resolveClassifications(d1, [row])).get(id)).toMatchObject({
        categoryId: "food",
        source: "system_rule",
      });
    };
    await expectFoodName(posted.recordKey);
    expect(await findActivitySearchDays(d1, { q: "餐廳" })).toEqual([
      "2026-09-04",
    ]);
    // Existing matches from the previous version are repaired even when both
    // transactions have disappeared from the bank's current response.
    db.database
      .prepare(
        "UPDATE bank_transactions SET description = ?, counterparty = ? WHERE id = ?",
      )
      .run(
        String(posted.payload.description),
        String(posted.payload.description),
        posted.recordKey,
      );
    await apply([], []);
    await expectFoodName(posted.recordKey);
    // Repeated posted-only syncs must not overwrite the restored name.
    await apply([posted], []);
    await expectFoodName(posted.recordKey);
    expect(await listBankTransactions(d1, 100)).toHaveLength(1);
    expect(
      await listBankTransactionsInRange(d1, {
        from: "2026-09-01",
        to: "2026-10-01",
      }),
    ).toHaveLength(1);
    expect(await findActivitySearchDays(d1, { q: "UNAGISHIKISHIMA" })).toEqual([
      "2026-09-04",
    ]);
    expect(
      db.database.prepare("SELECT * FROM bank_transactions").all(),
    ).toHaveLength(2);

    expect(
      db.database
        .prepare(
          "SELECT amount, currency, authorized_at FROM bank_transactions WHERE (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .get(),
    ).toMatchObject({
      amount: -5500,
      currency: "JPY",
      authorized_at: "2026-09-04T18:57:25+08:00",
    });
    // A reappearing pending response cannot reintroduce a duplicate or steal a saved match.
    await apply([pending, posted], [pending]);
    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .all(),
    ).toHaveLength(1);
    expect(
      db.database
        .prepare(
          "SELECT matched_transaction_id FROM bank_transactions WHERE status = 'pending'",
        )
        .get()?.matched_transaction_id,
    ).toBe(posted.recordKey);
    const domesticPending = make("TWD", -300, "pending");
    const domesticPosted = make("TWD", -300, "posted");
    await persistStagedSyncWrite(d1, { records: [domesticPending] });
    await apply([domesticPosted], [domesticPending]);
    await expectFoodName(domesticPosted.recordKey);
    await apply([domesticPosted], []);
    await expectFoodName(domesticPosted.recordKey);
    expect(
      (await listBankTransactions(d1, 100)).find(
        (row) => row.id === domesticPosted.recordKey,
      )?.status,
    ).toBe("posted");
    expect(
      db.database
        .prepare(
          "SELECT matched_transaction_id FROM bank_transactions WHERE id = ?",
        )
        .get(domesticPosted.recordKey)?.matched_transaction_id,
    ).toBe(domesticPosted.recordKey);
    const nextPending = make("TWD", -200, "pending");
    const nextPosted = make("JPY", -1000, "posted");
    await persistStagedSyncWrite(d1, { records: [nextPending] });
    db.database
      .prepare(
        "INSERT INTO bank_transaction_preferences VALUES (?, 1, 'now', 'now')",
      )
      .run(nextPending.recordKey);
    db.database
      .prepare(
        "INSERT INTO classification_overrides VALUES ('next', 'bank_transaction', ?, 'shopping', 'now', 'now')",
      )
      .run(nextPending.recordKey);
    db.database
      .prepare(
        "INSERT INTO invoice_transaction_preferences VALUES ('invoice-next', ?, 'linked', 'now', 'now')",
      )
      .run(nextPending.recordKey);
    await apply([nextPending, nextPosted], [nextPending]);
    const classifiedNext = (await listBankTransactions(d1, 100)).find(
      (row) => row.id === nextPosted.recordKey,
    )!;
    expect(
      (await resolveClassifications(d1, [classifiedNext])).get(
        nextPosted.recordKey,
      ),
    ).toMatchObject({ categoryId: "shopping", source: "override" });
    expect(
      db.database
        .prepare(
          "SELECT transaction_id FROM bank_transaction_preferences WHERE transaction_id = ?",
        )
        .get(nextPosted.recordKey)?.transaction_id,
    ).toBe(nextPosted.recordKey);
    expect(
      db.database
        .prepare(
          "SELECT target_id FROM classification_overrides WHERE target_id = ?",
        )
        .get(nextPosted.recordKey)?.target_id,
    ).toBe(nextPosted.recordKey);
    expect(
      db.database
        .prepare("SELECT transaction_id FROM invoice_transaction_preferences")
        .get()?.transaction_id,
    ).toBe(nextPosted.recordKey);
    expect(
      db.database
        .prepare(
          "SELECT * FROM bank_transactions WHERE status = 'pending' AND (status <> 'pending' OR matched_transaction_id IS NULL)",
        )
        .all(),
    ).toHaveLength(0);
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

  it("migrates preferences and removes garbled HNCB transaction ids", async () => {
    const db = createDb();
    db.database.exec(`
      INSERT INTO bank_accounts
        (id, connector_id, source_id, account_type, currency, raw_payload, created_at, updated_at)
      VALUES
        ('hncb:credit:hncb:8103', 'hncb', 'credit:hncb:8103', 'credit', 'TWD', '{}', '2026-07-01', '2026-07-01');

      INSERT INTO bank_transactions
        (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, status, raw_payload, created_at, updated_at)
      VALUES
        ('hncb-legacy', 'hncb', 'hncb:credit:hncb:8103', 'hncb:card:tx:8103:2026-07-22:230:abc123:1', '2026-07-27', '2026-07-22', -230, 'TWD', '????', 'posted', '{}', '2026-07-19', '2026-07-19'),
        ('hncb-orphan', 'hncb', 'hncb:credit:hncb:8103', 'hncb:card:tx:8103:2026-06-01:80:def456:1', '2026-06-01', '2026-06-01', -80, 'TWD', '????', 'posted', '{}', '2026-06-01', '2026-06-01'),
        ('hncb-canonical', 'hncb', 'hncb:credit:hncb:8103', 'hncb:card:tx:v2:8103:2026-07-22:230:1', '2026-07-27', '2026-07-22', -230, 'TWD', '連加＊餓肆', 'posted', '{}', '2026-07-22', '2026-07-22');

      INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
      VALUES ('hncb-legacy', 1, '2026-07-19', '2026-07-19');

      INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
      VALUES ('hncb-legacy-override', 'bank_transaction', 'hncb-legacy', 'shopping', '2026-07-19', '2026-07-19');
    `);

    await db.batch(
      reconcileHncbLegacyTransactionStatements(db as unknown as D1Database),
    );

    expect(
      db.database
        .prepare("SELECT id FROM bank_transactions ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["hncb-canonical"]);
    expect(
      db.database
        .prepare(
          "SELECT transaction_id AS transactionId FROM bank_transaction_preferences",
        )
        .get(),
    ).toEqual({ transactionId: "hncb-canonical" });
    expect(
      db.database
        .prepare("SELECT target_id AS targetId FROM classification_overrides")
        .get(),
    ).toEqual({ targetId: "hncb-canonical" });
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

    const firstWrite = await persistStagedSyncWrite(
      db as unknown as D1Database,
      {
        records,
        finalizeStatements: [
          db
            .prepare(
              "UPDATE connector_settings SET sync_cursor = ? WHERE connector_id = ?",
            )
            .bind("new-cursor", "tdcc") as unknown as D1PreparedStatement,
        ],
      },
    );

    expect(firstWrite).toEqual({
      invoices: 0,
      bankTransactions: 1,
      investmentTransactions: 0,
    });
    expect(
      db.database
        .prepare(
          "SELECT created_at AS createdAt FROM bank_transactions WHERE source_id = 'transaction-1'",
        )
        .get(),
    ).toEqual({ createdAt: "2026-07-19T00:00:00.000Z" });

    const repeatedWrite = await persistStagedSyncWrite(
      db as unknown as D1Database,
      {
        records: records.map((record) => ({
          ...record,
          payload: {
            ...record.payload,
            created_at: "2026-07-20T00:00:00.000Z",
            updated_at: "2026-07-20T00:00:00.000Z",
          },
        })),
      },
    );
    expect(repeatedWrite).toEqual({
      invoices: 0,
      bankTransactions: 0,
      investmentTransactions: 0,
    });
    expect(
      db.database
        .prepare(
          "SELECT created_at AS createdAt FROM bank_transactions WHERE source_id = 'transaction-1'",
        )
        .get(),
    ).toEqual({ createdAt: "2026-07-19T00:00:00.000Z" });

    expect(
      db.executedSql.filter((sql) =>
        sql.includes("INSERT INTO sync_write_staging"),
      ),
    ).toHaveLength(6);
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

  it("keeps source time through date-only refreshes and accepts newly available time", async () => {
    const db = createDb();
    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [
        bankAccountRecord(0),
        bankTransactionRecord("purchase-time", "posted", {
          authorizedAt: "2026-07-05T14:35:00+08:00",
          postedDate: "2026-07-07",
        }),
        bankTransactionRecord("purchase-date", "pending", {
          authorizedAt: "2026-07-05",
        }),
      ],
    });
    await persistStagedSyncWrite(db as unknown as D1Database, {
      records: [
        bankTransactionRecord("purchase-time", "posted", {
          authorizedAt: "2026-07-05",
          postedDate: "2026-07-07",
        }),
        bankTransactionRecord("purchase-date", "posted", {
          authorizedAt: "2026-07-05T00:00:00+08:00",
          postedDate: "2026-07-07",
        }),
      ],
    });
    expect(
      db.database
        .prepare(
          "SELECT source_id AS sourceId, authorized_at AS authorizedAt FROM bank_transactions ORDER BY source_id",
        )
        .all(),
    ).toEqual([
      { sourceId: "purchase-date", authorizedAt: "2026-07-05T00:00:00+08:00" },
      { sourceId: "purchase-time", authorizedAt: "2026-07-05T14:35:00+08:00" },
    ]);
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

describe("O-Bank complete deposit snapshots", () => {
  it("retires missing deposits atomically, preserves history and reactivates a returned account", async () => {
    const sqlite = createDb();
    const db = sqlite as unknown as D1Database;
    const before = "2026-09-01T02:06:05Z";
    const now = "2026-09-07T13:31:07Z";
    const account = {
      sourceId: "td",
      accountType: "time_deposit" as const,
      currency: "TWD",
      openedDate: "2026-01-01",
      maturityDate: "2026-09-05",
    };
    const balance = {
      accountId: "td",
      sourceId: "td:first",
      balance: 30550,
      currency: "TWD",
      asOfAt: before,
    };
    await persistStagedSyncWrite(db, {
      records: [
        mapAccount("obank", account, before),
        mapBalance("obank", balance, before),
      ],
    });
    const result = {
      records: [],
      bankAccounts: [],
      timeDepositsComplete: true as const,
    };
    const write = await prepareObankTimeDepositWrite(db, result, now);
    // A failure in the same batch must roll back both zero balances and status.
    await expect(
      persistStagedSyncWrite(db, {
        ...write,
        finalizeStatements: [
          db.prepare("INSERT INTO missing_table VALUES (1)"),
        ],
      }),
    ).rejects.toThrow();
    expect(await listBankAccounts(db)).toHaveLength(1);
    expect(await calculateBankDepositValue(db, "2026-09-07")).toBe(30550);
    await persistStagedSyncWrite(db, write);
    expect(await listBankAccounts(db)).toEqual([]);
    expect(await calculateBankDepositValue(db, "2026-09-01")).toBe(30550);
    expect(await calculateBankDepositValue(db, "2026-09-07")).toBe(0);
    expect(
      (await prepareObankTimeDepositWrite(db, result, now)).records,
    ).toEqual([]);
    await persistStagedSyncWrite(db, {
      records: [
        mapAccount("obank", account, now),
        mapBalance(
          "obank",
          {
            ...balance,
            sourceId: "td:returned",
            asOfAt: "2026-09-08T01:00:00Z",
          },
          now,
        ),
      ],
    });
    expect(await listBankAccounts(db)).toMatchObject([
      { openedDate: "2026-01-01", maturityDate: "2026-09-05", balance: 30550 },
    ]);
  });
});
