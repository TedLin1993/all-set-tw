import { test } from "node:test";
import assert from "node:assert/strict";
import { firstradeDiagnostics } from "./lib/firstrade-diagnostics.mjs";
const account = {
  account: "PRIVATE-ACCOUNT",
  balance: {
    cash_balance: 17.25,
    total_account_value: 110.5,
    margin_balance: -7,
    long_stock_value: 100.25,
    long_option_value: 0,
    short_option_value: 0,
    password: "PRIVATE-PASSWORD",
  },
  positionsMarketValue: 100.25,
  positions: [{ symbol: "PRIVATE-SYMBOL", market_value: 100.25 }],
};
test("distinguishes a signed balance adjustment without exposing raw data", () => {
  const [d] = firstradeDiagnostics([account]);
  assert.equal(d.matches.totalFromPositionsCash, false);
  assert.equal(d.matches.totalFromPositionsCashPlusMargin, true);
  assert.equal(d.matches.totalFromStocksCashPlusMargin, true);
  assert.equal(d.fields.margin_balance, "negative");
  const text = JSON.stringify(d);
  for (const secret of [
    "PRIVATE-ACCOUNT",
    "PRIVATE-PASSWORD",
    "PRIVATE-SYMBOL",
    "100.25",
    "17.25",
    "110.5",
  ])
    assert.ok(!text.includes(secret));
});
test("missing fields are not interpreted as zero", () => {
  const [d] = firstradeDiagnostics([
    {
      ...account,
      balance: { cash_balance: 17.25, total_account_value: 117.5 },
      positionsMarketValue: undefined,
    },
  ]);
  assert.equal(d.matches.totalFromPositionsCash, true);
  assert.equal(d.matches.totalFromPositionsCashPlusMargin, null);
  assert.equal(d.fields.margin_balance, "missing");
  assert.equal(d.positionsSubtotalPresent, false);
});
test("invalid position values cannot yield a matching subtotal", () => {
  const [d] = firstradeDiagnostics([
    { ...account, positions: [{ market_value: NaN }] },
  ]);
  assert.equal(d.matches.positionsSubtotal, null);
});
