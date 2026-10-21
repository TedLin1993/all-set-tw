import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  bankAccountRecord,
  creditCardBillRecord,
} from "../../../src/features/sync/record-mapper";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";

const mocks = vi.hoisted(() => ({ createCathaybkConnector: vi.fn() }));

vi.mock("../../../src/sources/cathaybk/connector", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/sources/cathaybk/connector")
  >("../../../src/sources/cathaybk/connector");
  return {
    ...actual,
    createCathaybkConnector: mocks.createCathaybkConnector,
  };
});

import { syncCathaybk } from "../../../src/sources/cathaybk/sync";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const createdAt = "2026-10-09T00:00:00.000Z";
const depositSourceId = "deposit:cathaybk:checking:1234";
const visibleLoanSourceId = "loan:cathaybk:0000000000000002";
const missingLoanSourceId = "loan:cathaybk:0000000000000001";

function account(
  sourceId: string,
  accountType: "savings" | "loan",
): Parameters<typeof bankAccountRecord>[1] {
  return {
    sourceId,
    institutionName: "國泰世華銀行",
    accountName: accountType === "loan" ? "房屋貸款" : "活期存款",
    accountType,
    ...(accountType === "loan" ? { loanCategory: "housing" as const } : {}),
    currency: "TWD",
    raw: {},
  };
}

function connectorResult(
  loanOverviewComplete: boolean,
  creditCardBills: ReturnType<typeof bill>[] = [],
) {
  return {
    records: [],
    loanOverviewComplete,
    bankAccounts: [
      account(depositSourceId, "savings"),
      account(visibleLoanSourceId, "loan"),
    ],
    bankBalanceSnapshots: [
      {
        accountId: depositSourceId,
        sourceId: `${depositSourceId}:${createdAt}`,
        balance: 250_000,
        currency: "TWD",
        asOfAt: createdAt,
        raw: {},
      },
      {
        accountId: visibleLoanSourceId,
        sourceId: `${visibleLoanSourceId}:${createdAt}`,
        balance: -1_000_000,
        currency: "TWD",
        asOfAt: createdAt,
        raw: {},
      },
    ],
    bankTransactions: [],
    creditCardBills,
  };
}

function bill(
  billingPeriod: string,
  overrides: Partial<{
    isPaid: boolean;
    raw: unknown;
    statementAmount: number;
    minimumPayment: number;
    paidAmount: number;
    sourceId: string;
    omitAmounts: boolean;
  }> = {},
) {
  return {
    accountId: "card:1",
    sourceId: overrides.sourceId ?? `seed:${billingPeriod}`,
    billingPeriod,
    ...(overrides.omitAmounts
      ? {}
      : {
          statementAmount: overrides.statementAmount ?? 100,
          minimumPayment: overrides.minimumPayment ?? 10,
          paidAmount: overrides.paidAmount ?? 100,
        }),
    isPaid: overrides.isPaid,
    currency: "TWD",
    raw: overrides.raw,
  };
}

async function seedPreviouslyKnownLoan() {
  await persistStagedSyncWrite(env.DB, {
    records: [
      bankAccountRecord(
        "cathaybk",
        account(missingLoanSourceId, "loan"),
        createdAt,
      ),
    ],
  });
}

async function runSync(
  loanOverviewComplete: boolean,
  creditCardBills: ReturnType<typeof bill>[] = [],
) {
  mocks.createCathaybkConnector.mockReturnValue({
    sync: vi
      .fn()
      .mockResolvedValue(
        connectorResult(loanOverviewComplete, creditCardBills),
      ),
  });
  return syncCathaybk(env, "manual");
}

async function bankAccountState(sourceId: string) {
  return env.DB.prepare(
    "SELECT source_id AS sourceId, account_type AS accountType, inactive_at AS inactiveAt FROM bank_accounts WHERE source_id = ?",
  )
    .bind(sourceId)
    .first<{
      sourceId: string;
      accountType: string;
      inactiveAt: string | null;
    }>();
}

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  const encrypted = await encryptJson(
    { userId: "A123456789", account: "syntheticacct", password: "synthetic" },
    key,
  );
  await env.DB.prepare(
    "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind("cathaybk", "cathaybk", encrypted, createdAt, createdAt)
    .run();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 60_000);

describe("Cathay incomplete loan overview persistence", () => {
  it("saves deposits and visible loans but preserves previously known loans", async () => {
    await seedPreviouslyKnownLoan();

    const outcome = await runSync(false);

    expect(outcome.success).toBe(true);
    expect(await bankAccountState(depositSourceId)).toMatchObject({
      accountType: "savings",
      inactiveAt: null,
    });
    expect(await bankAccountState(visibleLoanSourceId)).toMatchObject({
      accountType: "loan",
      inactiveAt: null,
    });
    expect(await bankAccountState(missingLoanSourceId)).toMatchObject({
      accountType: "loan",
      inactiveAt: null,
    });
    const summary = vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .find((message) => message.startsWith("[sync] cathaybk/all: accounts="));
    expect(summary).toContain(
      "accounts=2 loans=1 snapshots=2 loan_snapshots=1 transactions=0 bills=0 loan_overview=incomplete",
    );
    const serializedLogs = vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .join("\n");
    expect(serializedLogs).not.toContain('"event":"cathaybk_loan_stage"');
    expect(serializedLogs).not.toContain(
      '"event":"cathaybk_loan_parse_success"',
    );
    expect(
      await env.DB.prepare(
        "SELECT balance FROM bank_balance_snapshots WHERE source_id = ?",
      )
        .bind(`${depositSourceId}:${createdAt}`)
        .first("balance"),
    ).toBe(250_000);
    expect(
      await env.DB.prepare(
        "SELECT balance FROM bank_balance_snapshots WHERE source_id = ?",
      )
        .bind(`${visibleLoanSourceId}:${createdAt}`)
        .first("balance"),
    ).toBe(-1_000_000);
  });

  it("deactivates missing loans only when the overview is complete", async () => {
    await seedPreviouslyKnownLoan();

    await runSync(true);

    expect(await bankAccountState(missingLoanSourceId)).toMatchObject({
      accountType: "loan",
      inactiveAt: expect.any(String),
    });
  });
});

describe("Cathay current unpaid bill reconciliation", () => {
  it("repairs only explicit current unpaid bills and preserves zero values", async () => {
    const periods = ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05"];
    await persistStagedSyncWrite(env.DB, {
      records: [
        bankAccountRecord(
          "cathaybk",
          {
            sourceId: "card:1",
            institutionName: "國泰世華銀行",
            accountName: "信用卡",
            accountType: "credit",
            currency: "TWD",
            raw: {},
          },
          createdAt,
        ),
        ...periods.map((period) =>
          creditCardBillRecord(
            "cathaybk",
            bill(period, { isPaid: true }),
            createdAt,
          ),
        ),
      ],
    });

    const firstBills = [
      bill("2026-09", {
        isPaid: false,
        raw: { source: "C_BILL_Q_RecentBillInfo" },
        statementAmount: 0,
        minimumPayment: 0,
        paidAmount: 0,
        sourceId: "current-source",
      }),
      bill("2026-08", { raw: { source: "C_BILL_Q_RecentBillInfo" } }),
      bill("2026-07", {
        isPaid: true,
        raw: { source: "C_BILL_Q_RecentBillInfo" },
      }),
      bill("2026-06", { isPaid: false, raw: { source: "history" } }),
      bill("2026-05", { isPaid: false }),
    ];
    await runSync(false, firstBills);

    const rows = await env.DB.prepare(
      "SELECT id, billing_period, source_id, statement_amount, minimum_payment, paid_amount, is_paid FROM credit_card_bills ORDER BY billing_period DESC",
    ).all<{
      id: string;
      billing_period: string;
      source_id: string;
      statement_amount: number | null;
      minimum_payment: number | null;
      paid_amount: number | null;
      is_paid: number | null;
    }>();
    expect(rows.results).toEqual([
      {
        id: "cathaybk:card:1:2026-09",
        billing_period: "2026-09",
        source_id: "current-source",
        statement_amount: 0,
        minimum_payment: 0,
        paid_amount: 0,
        is_paid: 0,
      },
      expect.objectContaining({ billing_period: "2026-08", is_paid: 1 }),
      expect.objectContaining({ billing_period: "2026-07", is_paid: 1 }),
      expect.objectContaining({ billing_period: "2026-06", is_paid: 1 }),
      expect.objectContaining({ billing_period: "2026-05", is_paid: 1 }),
    ]);

    await runSync(false, [
      bill("2026-09", {
        sourceId: "current-source-again",
        raw: { source: "C_BILL_Q_RecentBillInfo" },
        omitAmounts: true,
      }),
    ]);

    expect(
      await env.DB.prepare(
        "SELECT source_id, statement_amount, minimum_payment, paid_amount, is_paid FROM credit_card_bills WHERE id = ?",
      )
        .bind("cathaybk:card:1:2026-09")
        .first(),
    ).toEqual({
      source_id: "current-source-again",
      statement_amount: 0,
      minimum_payment: 0,
      paid_amount: 0,
      is_paid: 0,
    });
  });
});
