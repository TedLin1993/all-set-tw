import assert from "node:assert/strict";
import { FirstradeApiClient, FirstradeApiError } from "../../src/firstrade-api";
import {
  parseFirstradeConfig,
  parseFirstradePortfolio,
} from "../../src/firstrade";

function fixture(responses: unknown[]) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({
      path: new URL(String(url)).pathname + new URL(String(url)).search,
      init,
    });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    assert.notEqual(value, undefined, "unexpected request");
    return new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetcher };
}
const otp = {
  error: "",
  t_token: "temporary",
  otp: [{ channel: "sms", recipientId: 123, recipientMask: "***1234" }],
};
const auth = { error: "", sid: "session", ftat: "token" };
{
  const f = fixture([
    {},
    otp,
    { error: "", verificationSid: "verification" },
    auth,
    { error: "", items: [{ account: "12345678" }] },
    { error: "", result: { account: "12345678", cash_balance: 12 } },
    {
      error: "",
      account: "12345678",
      page: 1,
      pages: 2,
      total: 2,
      items: [{ symbol: "A", quantity: 0.5 }],
    },
    {
      error: "",
      account: "12345678",
      page: 2,
      pages: 2,
      total: 2,
      items: [{ symbol: "B", quantity: 2 }],
    },
  ]);
  const client = new FirstradeApiClient(f.fetcher);
  assert.deepEqual(await client.login("user", "password"), {
    kind: "delivery",
    options: [{ index: 0, channel: "sms", recipientMask: "***1234" }],
  });
  assert.equal(f.calls.length, 2, "login must not automatically send OTP");
  await client.sendCode(0);
  assert.equal(
    new URLSearchParams(String(f.calls[2].init?.body)).get("recipientId"),
    "123",
  );
  await assert.rejects(client.sendCode(0), FirstradeApiError);
  await client.verify("123456");
  const data = await client.readPortfolio();
  assert.equal(data[0].positions.length, 2);
  assert.equal(data[0].positions[0].quantity, 0.5);
  const body = new URLSearchParams(String(f.calls[3].init?.body));
  assert.equal(body.get("verificationSid"), "verification");
  assert.equal(body.get("otpCode"), "123456");
  assert.equal(body.has("remember_for"), false);
  assert.ok(f.calls.every((c) => c.init?.redirect === "manual"));
  assert.ok(f.calls.every((c) => !c.path.includes("order")));
  await assert.rejects(client.readPortfolio(), FirstradeApiError);
}
for (const failure of [
  new Response('{"secret":"never echo"}', { status: 401 }),
  new Error("private network detail"),
]) {
  const f = fixture([{}, failure]);
  const client = new FirstradeApiClient(f.fetcher);
  await assert.rejects(
    client.login("u", "sensitive password"),
    (e) =>
      e instanceof FirstradeApiError &&
      !e.message.includes("secret") &&
      !e.message.includes("private"),
  );
  await assert.rejects(
    client.login("u", "sensitive password"),
    FirstradeApiError,
  );
  assert.equal(f.calls.length, 2, "failed login must not be retried");
}
{
  let time = 1;
  const f = fixture([{}, otp]);
  const client = new FirstradeApiClient(f.fetcher, () => time);
  await client.login("u", "p");
  time += 300_000;
  await assert.rejects(
    client.sendCode(0),
    (e) => e instanceof FirstradeApiError && e.kind === "expired",
  );
  assert.equal(f.calls.length, 2);
}
{
  const f = fixture([
    {},
    auth,
    { items: [{ account: "a" }] },
    { result: { account: "a" } },
    { account: "a", page: 1, pages: 1, total: 2, items: [{ symbol: "A" }] },
  ]);
  const client = new FirstradeApiClient(f.fetcher);
  await client.login("u", "p");
  await assert.rejects(
    client.readPortfolio(),
    (e) => e instanceof FirstradeApiError && e.step === "positions-count",
  );
  await assert.rejects(client.readPortfolio(), FirstradeApiError);
}
{
  const accounts = [
    {
      account: "12345678",
      balance: { cash_balance: 12.34, total_account_value: 112.59 },
      positions: [
        {
          symbol: "TEST",
          company_name: "Synthetic equity",
          quantity: 0.5,
          market_value: 100.25,
          sec_type: 1,
          cost: 99,
        },
      ],
    },
  ];
  const first = await parseFirstradePortfolio(accounts, "2026-09-27");
  const repeat = await parseFirstradePortfolio(accounts, "2026-09-28");
  assert.deepEqual(
    first.map((p) => p.sourceId),
    repeat.map((p) => p.sourceId),
  );
  assert.equal(
    first.reduce((n, p) => n + (p.cashBalance ?? 0) + (p.marketValue ?? 0), 0),
    112.59,
  );
  assert.equal(first[0].quantity, 0.5);
  assert.ok(!JSON.stringify(first).includes("12345678"));
  await assert.rejects(
    parseFirstradePortfolio(
      [
        {
          ...accounts[0],
          balance: { cash_balance: 12, total_account_value: 999 },
        },
      ],
      "2026-09-27",
    ),
  );
  await assert.rejects(
    parseFirstradePortfolio(
      [
        {
          ...accounts[0],
          positions: [{ ...accounts[0].positions[0], sec_type: 2 }],
        },
      ],
      "2026-09-27",
    ),
  );
  assert.throws(() => parseFirstradeConfig({ password: 42 }));
  const f = fixture([{}, otp]);
  const original = new FirstradeApiClient(f.fetcher);
  await original.login("user", "password");
  const session = original.exportSession();
  const config = parseFirstradeConfig({
    username: "user",
    password: "password",
    pendingSession: session,
  });
  original.clear();
  const restored = new FirstradeApiClient(
    fixture([{ verificationSid: "verification" }]).fetcher,
  );
  restored.restoreSession(config.pendingSession!);
  assert.equal((await restored.sendCode(0)).kind, "code");
}
console.log(
  "Firstrade protocol self-check passed (synthetic; not a live integration).",
);

{
  const positions = Array.from({ length: 38 }, (_, i) => ({
    symbol: "ROUND" + i,
    company_name: "Rounding fixture",
    quantity: 1,
    market_value: 1,
    sec_type: 1,
  }));
  const account = {
    account: "synthetic",
    balance: { cash_balance: 10, total_account_value: 48.19 },
    positions,
  };
  assert.equal(
    (await parseFirstradePortfolio([account], "2026-09-28")).length,
    39,
  );
  await assert.rejects(
    parseFirstradePortfolio(
      [
        {
          ...account,
          balance: { ...account.balance, total_account_value: 48.21 },
        },
      ],
      "2026-09-28",
    ),
    /持倉 38 筆/,
  );
}

for (const pages of [-1, 0, 101]) {
  const f = fixture([
    {},
    auth,
    { items: [{ account: "a" }] },
    { result: { account: "a" } },
    { account: "a", page: 1, pages, total: 1, items: [{ symbol: "X" }] },
  ]);
  const c = new FirstradeApiClient(f.fetcher);
  await c.login("u", "p");
  await assert.rejects(
    c.readPortfolio(),
    (e) => e instanceof FirstradeApiError && e.step === "positions",
  );
  assert.equal(f.calls.length, 5);
}

{
  const account = {
    account: "synthetic",
    balance: {
      cash_balance: 10,
      total_account_value: 115,
      long_stock_value: 105,
      long_option_value: 0,
      short_option_value: 0,
      margin_balance: 0,
    },
    positionsMarketValue: 100,
    positions: [
      {
        symbol: "QUOTE",
        company_name: "Quote fixture",
        quantity: 1,
        market_value: 100,
        sec_type: 1,
      },
    ],
  };
  const rows = await parseFirstradePortfolio([account], "2026-09-28");
  assert.equal(rows[0].marketValue, 100);
  assert.equal(rows[1].cashBalance, 10);
  assert.match(JSON.stringify(rows[1].raw), /不同報價來源/);
  const cashOnly = {
    ...account,
    balance: {
      cash_balance: 10,
      total_account_value: 115,
      long_stock_value: 105,
    },
  };
  const cashOnlyRows = await parseFirstradePortfolio([cashOnly], "2026-09-28");
  assert.deepEqual(
    cashOnlyRows,
    rows,
    "observed cash-account omissions must not prevent a reconciled snapshot",
  );

  for (const changed of [
    { ...account, positionsMarketValue: undefined },
    { ...account, balance: { ...account.balance, margin_balance: null } },
    { ...account, balance: { ...account.balance, long_option_value: "0" } },
    { ...account, positions: [], positionsMarketValue: 0 },
    { ...account, positionsMarketValue: 99 },
    { ...account, balance: { ...account.balance, long_stock_value: 104 } },
    { ...account, balance: { ...account.balance, margin_balance: 5 } },
    { ...account, balance: { ...account.balance, long_option_value: 5 } },
    { ...account, balance: { ...account.balance, short_option_value: -5 } },
  ])
    await assert.rejects(parseFirstradePortfolio([changed], "2026-09-28"));
}
