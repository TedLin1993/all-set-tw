import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
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

function connectorResult(loanOverviewComplete: boolean) {
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
    creditCardBills: [],
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

async function runSync(loanOverviewComplete: boolean) {
  mocks.createCathaybkConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue(connectorResult(loanOverviewComplete)),
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
