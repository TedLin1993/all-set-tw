import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { bankRoutes } from "../../../src/features/bank/route";
import type { Env } from "../../../src/platform/env";

let harness: Awaited<ReturnType<typeof createTestD1>>;
beforeAll(async () => {
  harness = await createTestD1();
}, 60_000);
afterAll(async () => {
  await harness?.mf.dispose();
});

it("分卡只影響交易標示：唯一對照顯示卡名與末碼，缺少或歧義皆未知，帳單負債維持一份", async () => {
  const db = harness.binding;
  const now = "2026-10-15T00:00:00Z";
  const cards = [
    { cardLast4: "1111", cardName: "合成甲卡" },
    { cardLast4: "2222", cardName: "合成乙卡" },
    { cardLast4: "3333", cardName: "合成丙卡" },
    { cardLast4: "3333", cardName: "合成丁卡" },
    { cardLast4: "4444" },
  ];
  for (const [id, connector, raw] of [
    ["ctbc", "ctbc", JSON.stringify({ cards })],
    ["esun", "esun", "{}"],
    ["invalid", "ctbc", "invalid-json"],
  ]) {
    await db
      .prepare(
        "INSERT INTO bank_accounts (id,connector_id,source_id,account_name,account_type,currency,raw_payload,created_at,updated_at) VALUES (?,?,? ,?,'credit','TWD',?,?,?)",
      )
      .bind(
        id,
        connector,
        `credit:${connector}:${id}`,
        connector === "esun" ? "玉山信用卡 7777" : "不可沿用的首張卡名",
        raw,
        now,
        now,
      )
      .run();
  }
  await db
    .prepare(
      "INSERT INTO bank_balance_snapshots (id,connector_id,account_id,source_id,balance,currency,as_of_at,created_at,updated_at) VALUES ('balance','ctbc','ctbc','balance',-25,'TWD',?,?,?)",
    )
    .bind(now, now, now)
    .run();
  await db
    .prepare(
      "INSERT INTO credit_card_bills (id,connector_id,account_id,source_id,billing_period,statement_amount,currency,created_at,updated_at) VALUES ('bill','ctbc','ctbc','bill','2026-10',25,'TWD',?,?)",
    )
    .bind(now, now)
    .run();
  const cases = [
    ["posted-a", "ctbc", "posted", { cardLast4: "1111" }, "合成甲卡 · 1111"],
    ["unbilled-b", "ctbc", "posted", { cardLast4: "2222" }, "合成乙卡 · 2222"],
    ["pending-a", "ctbc", "pending", { cardLast4: "1111" }, "合成甲卡 · 1111"],
    ["missing", "ctbc", "posted", {}, "未辨識卡片"],
    ["unknown", "ctbc", "posted", { cardLast4: "9999" }, "未辨識卡片"],
    ["ambiguous", "ctbc", "posted", { cardLast4: "3333" }, "未辨識卡片"],
    ["nameless", "ctbc", "posted", { cardLast4: "4444" }, "未辨識卡片"],
    ["invalid", "invalid", "posted", { cardLast4: "1111" }, "未辨識卡片"],
    [
      "normalized",
      "ctbc",
      "posted",
      { cardLast4: "legacy", displayCardLast4: "1111" },
      "合成甲卡 · 1111",
    ],
    [
      "conflicting-display",
      "ctbc",
      "posted",
      { cardLast4: "1111", displayCardLast4: null },
      "未辨識卡片",
    ],
    ["esun", "esun", "posted", { cardLast4: "7777" }, "玉山信用卡 7777"],
  ] as const;
  for (const [id, account, status, raw] of cases) {
    await db
      .prepare(
        "INSERT INTO bank_transactions (id,connector_id,account_id,source_id,posted_date,authorized_at,amount,currency,status,raw_payload,created_at,updated_at) VALUES (?,?,?,?, '2026-10-10','2026-10-09',-1,'TWD',?,?,?,?)",
      )
      .bind(
        id,
        account === "esun" ? "esun" : "ctbc",
        account,
        id,
        status,
        JSON.stringify(raw),
        now,
        now,
      )
      .run();
  }
  const env = { DB: db } as Env;
  for (const url of ["/bank?from=2026-10&to=2026-10", "/bank?limit=100"]) {
    const response = await bankRoutes.request(url, {}, env);
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.transactions).toHaveLength(cases.length);
    for (const [id, , , , label] of cases) {
      const txn = data.transactions.find((row: any) => row.id === id);
      expect(txn.accountName).toBe(label);
      expect(txn).not.toHaveProperty("cardMetadata");
      expect(txn).not.toHaveProperty("cardLast4");
      expect(txn).not.toHaveProperty("rawPayload");
    }
    expect(data.accounts.find((a: any) => a.id === "ctbc")).toMatchObject({
      accountName: "中國信託信用卡",
      balance: -25,
    });
  }
  const bills = (await (
    await bankRoutes.request("/bank/bills?from=2026-10&to=2026-10", {}, env)
  ).json()) as any[];
  expect(bills).toHaveLength(1);
  expect(bills[0].statementAmount).toBe(25);
  expect(
    await db.prepare("SELECT count(*) AS n FROM bank_accounts").first("n"),
  ).toBe(3);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM bank_balance_snapshots")
      .first("n"),
  ).toBe(1);
});
