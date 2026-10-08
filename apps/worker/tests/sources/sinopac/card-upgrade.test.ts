import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import { acquireSyncJobLock, releaseSyncJobLock } from "../../../src/db";
import { createSyncExecution } from "../../../src/features/sync/execution";

const mocks = vi.hoisted(() => ({ createSinopacConnector: vi.fn() }));

vi.mock("../../../src/sources/sinopac/connector", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/sources/sinopac/connector")
  >("../../../src/sources/sinopac/connector");
  return { ...actual, createSinopacConnector: mocks.createSinopacConnector };
});

import { parseSinopacCardData } from "../../../src/sources/sinopac/connector";
import { syncSinopac } from "../../../src/sources/sinopac/sync";

// 全部為合成資料：假卡號末四碼、整數金額。
const KEY = "synthetic-test-encryption-key";
const OLD = "2026-09-25T00:00:00.000Z";
const LOCK_ROW = "sinopac:all";
const RUN_ID = "synthetic-run";
const TWD = "credit:sinopac:main";
const USD = "credit:sinopac:main:USD";

let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

type Detail = Record<string, string>;
type Item = Record<string, string>;

const detail = (overrides: Detail): Detail => ({
  CurrencyCode: "000",
  CardLast4: "1111",
  TXDATE: "2026/09/20",
  DEDATE: "2026/09/22",
  TXCODE: "",
  CARDNAME: "測試現金回饋信用卡",
  ...overrides,
});

const item = (overrides: Item): Item => ({
  AuthDate: "2026/09/23",
  AuthTime: "12:00:00",
  CardNo: "************1111",
  AuthResult: "Y",
  CardName: "測試現金回饋信用卡",
  ...overrides,
});

function parsed(details: Detail[], items: Item[] = []) {
  const result = parseSinopacCardData({
    summary: [],
    bills: [],
    latest: { Result: { Items: items } },
    outstanding: { Result: { Detail: details } },
  });
  return {
    bankAccounts: [],
    bankBalanceSnapshots: [],
    creditCardBills: [],
    bankTransactions: result.bankTransactions,
    cardAuthorizations: result.cardAuthorizations,
    pendingSnapshotComplete: result.pendingSnapshotComplete,
  };
}

type Parsed = ReturnType<typeof parsed>["bankTransactions"][number];

const txId = (accountSourceId: string, sourceId: string) =>
  `sinopac:${accountSourceId}:${sourceId}`;

/** 模擬舊版寫入的列：同一筆銀行明細，但記錄的正負號（與因此不同的識別碼）由舊版決定。 */
async function seedOld(
  transaction: Parsed,
  { amount, occurrence = 1 }: { amount: number; occurrence?: number },
) {
  const sourceId = transaction.sourceId
    .replace(/:-?[\d.]+:(\w+):\d+$/, `:${amount}:$1:${occurrence}`)
    .replace(/:payment-[0-9a-f]{8}:/, ":payment:");
  const id = txId(transaction.accountId, sourceId);
  await env.DB.prepare(
    `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date,
       authorized_at, amount, currency, description, counterparty, status, raw_payload,
       created_at, updated_at)
     VALUES (?, 'sinopac', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      `sinopac:${transaction.accountId}`,
      sourceId,
      transaction.postedDate ?? null,
      transaction.authorizedAt ?? null,
      amount,
      transaction.currency,
      transaction.description,
      transaction.description,
      transaction.status,
      JSON.stringify({
        ...(transaction.raw as Record<string, unknown>),
        duplicateOccurrence: occurrence,
      }),
      OLD,
      OLD,
    )
    .run();
  return id;
}

async function seedUserData(id: string, label: string, category = "food") {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
       VALUES (?, 'bank_transaction', ?, ?, ?, ?)`,
    ).bind(`override:bank_transaction:${id}`, id, category, OLD, OLD),
    env.DB.prepare(
      `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
       VALUES (?, 1, ?, ?)`,
    ).bind(id, OLD, OLD),
    env.DB.prepare(
      `INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at)
       VALUES (?, 'einvoice', ?, '2026-09-20', 100, ?, ?)`,
    ).bind(`invoice-${label}`, `invoice-${label}`, OLD, OLD),
    env.DB.prepare(
      `INSERT INTO invoice_transaction_preferences (invoice_id, transaction_id, decision, created_at, updated_at)
       VALUES (?, ?, 'linked', ?, ?)`,
    ).bind(`invoice-${label}`, id, OLD, OLD),
  ]);
}

async function userData(id: string) {
  const one = async (sql: string) =>
    (await env.DB.prepare(sql).bind(id).first<Record<string, unknown>>()) ??
    null;
  return {
    category: (
      await one(
        "SELECT category_id FROM classification_overrides WHERE target_type = 'bank_transaction' AND target_id = ?",
      )
    )?.category_id,
    excluded: (
      await one(
        "SELECT excluded_from_calculation FROM bank_transaction_preferences WHERE transaction_id = ?",
      )
    )?.excluded_from_calculation,
    invoice: (
      await one(
        "SELECT invoice_id FROM invoice_transaction_preferences WHERE decision = 'linked' AND transaction_id = ?",
      )
    )?.invoice_id,
  };
}

async function rows(where: string, ...binds: unknown[]) {
  return (
    await env.DB.prepare(
      `SELECT id, amount, status, description, matched_transaction_id
       FROM bank_transactions WHERE connector_id = 'sinopac' AND ${where}
       ORDER BY id`,
    )
      .bind(...binds)
      .all<{
        id: string;
        amount: number;
        status: string;
        description: string;
        matched_transaction_id: string | null;
      }>()
  ).results;
}

async function runSync(result: ReturnType<typeof parsed>) {
  mocks.createSinopacConnector.mockReturnValue({
    sync: vi.fn().mockResolvedValue(result),
  });
  expect(
    await acquireSyncJobLock(env.DB, {
      lockRowId: LOCK_ROW,
      runId: RUN_ID,
      scope: "all",
      trigger: "manual",
      leaseMs: 60_000,
    }),
  ).toBe(true);
  const execution = createSyncExecution(env, {
    lockRowId: LOCK_ROW,
    runId: RUN_ID,
  });
  try {
    return await execution.run((guardedEnv) =>
      syncSinopac(guardedEnv, "manual"),
    );
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, LOCK_ROW, RUN_ID);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: KEY } as Env;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES('sinopac', 'sinopac', ?, ?, ?)",
    ).bind(await encryptJson({ userId: "A123456789" }, KEY), OLD, OLD),
    ...[TWD, USD].map((sourceId) =>
      env.DB.prepare(
        `INSERT INTO bank_accounts (id, connector_id, source_id, institution_name, account_name,
           account_type, currency, created_at, updated_at)
         VALUES (?, 'sinopac', ?, '永豐銀行', '測試信用卡', 'credit', ?, ?, ?)`,
      ).bind(
        `sinopac:${sourceId}`,
        sourceId,
        sourceId === USD ? "USD" : "TWD",
        OLD,
        OLD,
      ),
    ),
    ...[
      ["food", "餐飲"],
      ["shopping", "購物"],
    ].map(([id, label]) =>
      env.DB.prepare(
        `INSERT INTO classification_categories (id, label, sort_order, is_system, created_at, updated_at)
         VALUES (?, ?, 100, 0, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(id, label, OLD, OLD),
    ),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 30_000);

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 30_000);

describe("永豐信用卡升級：舊版錯號與重複列（隔離 D1，經 syncSinopac）", () => {
  it("同 ID 入帳保留授權時間、名稱與設定，也不再用該明細隱藏第二筆同額授權", async () => {
    const first = item({
      AuthDate: "2026/09/23",
      Memo: "合成授權店名",
      AuthAmt: "100",
    });
    const pending = parsed([], [first]);
    await runSync(pending);
    const id = txId(TWD, pending.cardAuthorizations![0]!.sourceId);
    await seedUserData(id, "same-id");
    const postedDetail = detail({
      TXDATE: "2026/09/23",
      AMT: "100",
      MEMO: "合成正式分店",
    });
    await runSync(parsed([postedDetail]));
    await runSync(
      parsed(
        [postedDetail],
        [first, { ...first, AuthTime: "13:00:00", Memo: "第二筆合成商店" }],
      ),
    );
    await runSync(parsed([], []));
    await runSync(parsed([postedDetail]));
    const visible = await rows(
      "status = 'posted' OR matched_transaction_id IS NULL",
    );
    expect(visible).toHaveLength(2);
    expect(visible.find((row) => row.id === id)).toMatchObject({
      status: "posted",
      amount: -100,
      description: "合成授權店名",
    });
    expect(visible.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(await userData(id)).toEqual({
      category: "food",
      excluded: 1,
      invoice: "invoice-same-id",
    });
    expect(
      await env.DB.prepare(
        "SELECT authorized_at FROM bank_transactions WHERE id = ?",
      )
        .bind(id)
        .first("authorized_at"),
    ).toBe("2026-09-23T12:00:00+08:00");
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("共用精確配對之後仍能銜接臺幣授權與外幣入帳，保留正式金額及使用者設定", async () => {
    const authorization = item({
      AuthDate: "2026/09/23",
      Memo: "TEST OVERSEAS SHOP",
      AuthAmt: "1,000",
    });
    const pending = parsed([], [authorization]);
    await runSync(pending);
    const pendingId = txId(TWD, pending.cardAuthorizations![0]!.sourceId);
    await seedUserData(pendingId, "fx");
    const posted = parsed([
      detail({
        TXDATE: "2026/09/23",
        DEDATE: "2026/09/25",
        CurrencyCode: "840",
        MEMO: "TEST OVERSEAS SHOP",
        AMT: "31.00",
      }),
    ]);
    const postedId = txId(USD, posted.bankTransactions[0]!.sourceId);
    for (const result of [posted, pending, posted]) await runSync(result);
    expect(
      await rows("status = 'posted' OR matched_transaction_id IS NULL"),
    ).toEqual([
      expect.objectContaining({ id: postedId, amount: -31, status: "posted" }),
    ]);
    expect(await userData(postedId)).toEqual({
      category: "food",
      excluded: 1,
      invoice: "invoice-fx",
    });
    expect(
      await env.DB.prepare(
        "SELECT currency, authorized_at FROM bank_transactions WHERE id = ?",
      )
        .bind(postedId)
        .first(),
    ).toEqual({ currency: "USD", authorized_at: "2026-09-23T12:00:00+08:00" });
    expect(
      (await env.DB.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it("授權已配對錯號的外幣入帳：同步不回滾，配對與使用者資料改指向新列", async () => {
    const result = parsed([
      detail({ CurrencyCode: "840", MEMO: "TEST OVERSEAS SHOP", AMT: "31.00" }),
    ]);
    const current = result.bankTransactions[0]!;
    expect(current.amount).toBe(-31);
    const oldPosted = await seedOld(current, { amount: 31 });
    await seedUserData(oldPosted, "overseas");
    // 臺幣授權（金額與入帳不同）由舊版配對到錯號的外幣入帳；銀行已不再回傳這筆授權。
    const [authorization] = parsed(
      [],
      [
        item({
          AuthDate: "2026/09/20",
          Memo: "測試海外商店",
          AuthAmt: "1,000",
        }),
      ],
    ).cardAuthorizations!;
    const oldAuthorization = await seedOld(authorization!, { amount: 1000 });
    await env.DB.prepare(
      "UPDATE bank_transactions SET matched_transaction_id = ? WHERE id = ?",
    )
      .bind(oldPosted, oldAuthorization)
      .run();

    await runSync(result);

    const posted = await rows("status = 'posted'");
    expect(posted).toEqual([
      expect.objectContaining({ id: txId(USD, current.sourceId), amount: -31 }),
    ]);
    expect(await userData(posted[0]!.id)).toEqual({
      category: "food",
      excluded: 1,
      invoice: "invoice-overseas",
    });
    expect(
      (await rows("id = ?", oldAuthorization))[0]?.matched_transaction_id,
    ).toBe(posted[0]!.id);
  });

  it("同卡同日同店兩筆同額消費都曾記錯號：一對一併入，各自保留使用者資料", async () => {
    const result = parsed([
      detail({ MEMO: "測試飲料店", AMT: "50" }),
      detail({ MEMO: "測試飲料店", AMT: "50" }),
    ]);
    const [first, second] = result.bankTransactions;
    const oldFirst = await seedOld(first!, { amount: 50, occurrence: 1 });
    const oldSecond = await seedOld(second!, { amount: 50, occurrence: 2 });
    await seedUserData(oldFirst, "first", "food");
    await seedUserData(oldSecond, "second", "shopping");

    await runSync(result);

    const current = await rows("1 = 1");
    expect(current.map((row) => row.amount)).toEqual([-50, -50]);
    expect(await userData(txId(TWD, first!.sourceId))).toEqual({
      category: "food",
      excluded: 1,
      invoice: "invoice-first",
    });
    expect(await userData(txId(TWD, second!.sourceId))).toEqual({
      category: "shopping",
      excluded: 1,
      invoice: "invoice-second",
    });
  });

  it("沒有 AMT 時以 TXAMT 核對同一筆明細", async () => {
    const result = parsed([
      detail({ MEMO: "測試書店", AMT: "", TXAMT: "300" }),
    ]);
    const current = result.bankTransactions[0]!;
    expect(current.amount).toBe(-300);
    const old = await seedOld(current, { amount: 300 });
    await seedUserData(old, "book");

    await runSync(result);

    expect((await rows("1 = 1")).map((row) => row.amount)).toEqual([-300]);
    expect((await userData(txId(TWD, current.sourceId))).category).toBe("food");
  });

  it("其他卡或其他消費日的同額同摘要列不會被併入", async () => {
    const result = parsed([detail({ MEMO: "測試超商", AMT: "80" })]);
    const current = result.bankTransactions[0]!;
    const otherCard = parsed([
      detail({ MEMO: "測試超商", AMT: "80", CardLast4: "2222" }),
    ]).bankTransactions[0]!;
    const otherDay = parsed([
      detail({ MEMO: "測試超商", AMT: "80", TXDATE: "2026/09/19" }),
    ]).bankTransactions[0]!;
    const keptCard = await seedOld(otherCard, { amount: 80 });
    const keptDay = await seedOld(otherDay, { amount: 80 });
    await seedUserData(keptCard, "card");

    await runSync(result);

    const remaining = (await rows("1 = 1")).map((row) => row.id);
    expect(remaining).toEqual(
      [keptCard, keptDay, txId(TWD, current.sourceId)].sort(),
    );
    expect((await userData(keptCard)).category).toBe("food");
    expect((await userData(txId(TWD, current.sourceId))).category).toBe(
      undefined,
    );
  });

  it("曾記錯號的待入帳授權併入新的授權列", async () => {
    const result = parsed([], [item({ Memo: "測試麵包店", AuthAmt: "65" })]);
    const current = result.cardAuthorizations![0]!;
    expect(current.amount).toBe(-65);
    const old = await seedOld(current, { amount: 65 });
    await seedUserData(old, "bakery");

    await runSync(result);

    const pending = await rows("status = 'pending'");
    expect(pending.map((row) => row.amount)).toEqual([-65]);
    expect(await userData(pending[0]!.id)).toEqual({
      category: "food",
      excluded: 1,
      invoice: "invoice-bakery",
    });
  });

  it("方向改正讓同組序號重排時，不留下重複的舊列", async () => {
    const result = parsed([
      detail({ TXDATE: "2026/09/24", MEMO: "測試回饋金入帳戶", AMT: "2" }),
      detail({ TXDATE: "2026/09/24", MEMO: "測試消費回饋", AMT: "-2" }),
    ]);
    const [transfer, cashback] = result.bankTransactions;
    expect([transfer!.amount, cashback!.amount]).toEqual([-2, 2]);
    // 舊版兩筆都記成 +2，同組序號為 1、2；改正後消費回饋成為該組的第 1 筆。
    await seedOld(transfer!, { amount: 2, occurrence: 1 });
    await seedOld(cashback!, { amount: 2, occurrence: 2 });

    await runSync(result);

    expect(
      (await rows("1 = 1")).map((row) => [row.description, row.amount]),
    ).toEqual(
      expect.arrayContaining([
        ["測試回饋金入帳戶", -2],
        ["測試消費回饋", 2],
      ]),
    );
    expect(await rows("1 = 1")).toHaveLength(2);
  });

  it("舊版 :payment: 與含卡號的繳款列併入新版含摘要雜湊的繳款列", async () => {
    const result = parsed([
      detail({ TXDATE: "2026/09/24", MEMO: "測試自扣已入帳", AMT: "-5,000" }),
    ]);
    const current = result.bankTransactions[0]!;
    expect(current.sourceId).toMatch(/:payment-[0-9a-f]{8}:1$/);
    const oldPayment = await seedOld(current, { amount: 5000 });
    const otherCard = parsed([
      detail({
        TXDATE: "2026/09/24",
        MEMO: "測試自扣已入帳",
        AMT: "-5,000",
        CardLast4: "2222",
      }),
    ]).bankTransactions[0]!;
    // 含卡號的更舊格式
    const cardKeyed = txId(
      TWD,
      otherCard.sourceId.replace(/:payment-[0-9a-f]{8}:/, ":2222:"),
    );
    await env.DB.prepare(
      `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date,
         authorized_at, amount, currency, description, status, raw_payload, created_at, updated_at)
       SELECT ?, connector_id, account_id, ?, posted_date, authorized_at, amount, currency,
         description, status, raw_payload, '2026-09-20T00:00:00.000Z', created_at
       FROM bank_transactions WHERE id = ?`,
    )
      .bind(cardKeyed, cardKeyed.replace(`sinopac:${TWD}:`, ""), oldPayment)
      .run();
    await seedUserData(cardKeyed, "payment", "shopping");

    await runSync(result);

    expect((await rows("1 = 1")).map((row) => row.id)).toEqual([
      txId(TWD, current.sourceId),
    ]);
    expect((await userData(txId(TWD, current.sourceId))).category).toBe(
      "shopping",
    );
  });
});
