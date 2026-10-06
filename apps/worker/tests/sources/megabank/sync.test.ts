import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";

const mocks = vi.hoisted(() => ({ createMegabankConnector: vi.fn() }));

vi.mock("../../../src/sources/megabank/mobile-api", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/sources/megabank/mobile-api")
  >("../../../src/sources/megabank/mobile-api");
  return {
    ...actual,
    createMegabankConnector: mocks.createMegabankConnector,
  };
});

import { syncMegabank } from "../../../src/sources/megabank/sync";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
const NOW = "2026-09-27T00:00:00.000Z";
const ACCOUNT = "bank:megabank:2345:abcdef:TWD";
const P = "megabank:deposit:tx:";

const debit = {
  postedDate: "2026-09-20",
  amount: -1000,
  description: "合成扣款",
};

function syncResult(
  transactions: Array<{
    sourceId: string;
    postedDate: string;
    amount: number;
    description: string;
  }>,
) {
  return {
    records: [],
    bankAccounts: [
      {
        sourceId: ACCOUNT,
        institutionName: "兆豐銀行",
        accountName: "兆豐活存",
        accountType: "savings" as const,
        currency: "TWD",
      },
    ],
    bankBalanceSnapshots: [
      {
        accountId: ACCOUNT,
        sourceId: `${ACCOUNT}:${NOW}`,
        balance: 50_000,
        currency: "TWD",
        asOfAt: NOW,
      },
    ],
    bankTransactions: transactions.map((row) => ({
      accountId: ACCOUNT,
      authorizedAt: row.postedDate,
      currency: "TWD",
      status: "posted" as const,
      ...row,
    })),
  };
}

async function runSync(result: ReturnType<typeof syncResult>) {
  mocks.createMegabankConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue(result),
  });
  return syncMegabank(env, "manual");
}

async function transactions() {
  return (
    await env.DB.prepare(
      `SELECT id, source_id AS sourceId, amount, created_at AS createdAt
       FROM bank_transactions WHERE connector_id = 'megabank'
       ORDER BY source_id`,
    ).all<{ id: string; sourceId: string; amount: number; createdAt: string }>()
  ).results;
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
    .bind("megabank", "megabank", encrypted, NOW, NOW)
    .run();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 60_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 60_000);

describe("兆豐存款交易 sourceId 對帳（隔離 D1）", () => {
  it("舊 sourceId 的既有列被更新而非重複新增，使用者決定原樣保留", async () => {
    // 模擬舊版寫入：兩筆同日同額同摘要，sourceId 含舊的順序欄位雜湊。
    await runSync(
      syncResult([
        { sourceId: `${P}legacy-a:0`, ...debit },
        { sourceId: `${P}legacy-b:0`, ...debit },
      ]),
    );
    const before = await transactions();
    expect(before).toHaveLength(2);
    const annotated = before.find((row) => row.sourceId === `${P}legacy-a:0`)!;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at) VALUES (?, 1, 'created', 'updated')",
      ).bind(annotated.id),
      env.DB.prepare(
        "INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at) VALUES ('override-1', 'bank_transaction', ?, 'food', 'created', 'updated')",
      ).bind(annotated.id),
    ]);

    // 新版格式：同樣兩筆（occurrence 0/1）加上稍後入帳的新交易。
    const latest = [
      { sourceId: `${P}new:0`, ...debit },
      { sourceId: `${P}new:1`, ...debit },
      {
        sourceId: `${P}other:0`,
        postedDate: "2026-09-20",
        amount: 500,
        description: "合成入帳",
      },
    ];
    const outcome = await runSync(syncResult(latest));
    expect(outcome).toMatchObject({
      success: true,
      newRecords: { bankTransactions: 1 },
    });

    const after = await transactions();
    expect(after).toHaveLength(3);
    const legacyRows = after.filter((row) => row.sourceId.includes("legacy"));
    expect(legacyRows.map((row) => row.id).sort()).toEqual(
      before.map((row) => row.id).sort(),
    );
    expect(after.some((row) => row.sourceId.startsWith(`${P}new:`))).toBe(
      false,
    );
    expect(after.find((row) => row.sourceId === `${P}other:0`)?.amount).toBe(
      500,
    );
    // 既有列是更新而非重建：created_at 不變。
    expect(legacyRows.map((row) => row.createdAt).sort()).toEqual(
      before.map((row) => row.createdAt).sort(),
    );
    expect(
      await env.DB.prepare(
        "SELECT excluded_from_calculation, created_at FROM bank_transaction_preferences WHERE transaction_id = ?",
      )
        .bind(annotated.id)
        .first(),
    ).toEqual({ excluded_from_calculation: 1, created_at: "created" });
    expect(
      await env.DB.prepare(
        "SELECT category_id FROM classification_overrides WHERE target_id = ?",
      )
        .bind(annotated.id)
        .first(),
    ).toEqual({ category_id: "food" });

    // 再同步一次保持冪等。
    await runSync(syncResult(latest));
    expect(await transactions()).toHaveLength(3);
  });

  it("log 只記錄對回舊列的筆數", async () => {
    await runSync(syncResult([{ sourceId: `${P}legacy-a:0`, ...debit }]));
    const log = vi.spyOn(console, "log");
    await runSync(syncResult([{ sourceId: `${P}new:0`, ...debit }]));
    const lines = log.mock.calls.map(([value]) => String(value));
    expect(lines).toContain(
      JSON.stringify({ event: "megabank_tx_source_reconciled", remapped: 1 }),
    );
    expect(lines.join("\n")).not.toContain("合成扣款");
  });
});
