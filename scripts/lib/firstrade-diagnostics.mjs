// Deliberately excludes amounts, account identifiers, symbols and credentials.
export function firstradeDiagnostics(accounts) {
  const numeric = (v) => typeof v === "number" && Number.isFinite(v);
  const fields = [
    "cash_balance",
    "total_account_value",
    "margin_balance",
    "long_stock_value",
    "long_option_value",
    "short_option_value",
  ];
  return accounts.map((a) => {
    const b = a.balance;
    const values = a.positions.map((p) => p.market_value);
    const sum = values.every(numeric)
      ? values.reduce((n, v) => n + v, 0)
      : undefined;
    const tolerance = Math.max(0.05, (values.length + 2) * 0.005);
    const matches = (target, ...parts) =>
      numeric(target) && parts.every(numeric)
        ? Math.abs(target - parts.reduce((n, v) => n + v, 0)) <=
          tolerance + 1e-8
        : null;
    const minusMargin = numeric(b.margin_balance)
      ? -b.margin_balance
      : undefined;
    return {
      positionCount: a.positions.length,
      fields: Object.fromEntries(
        fields.map((k) => [
          k,
          !numeric(b[k])
            ? b[k] === undefined
              ? "missing"
              : "invalid"
            : b[k] === 0
              ? "zero"
              : b[k] > 0
                ? "positive"
                : "negative",
        ]),
      ),
      positionsSubtotalPresent: numeric(a.positionsMarketValue),
      matches: {
        positionsSubtotal: matches(a.positionsMarketValue, sum),
        balanceStocks: matches(b.long_stock_value, sum),
        totalFromStocksCash: matches(
          b.total_account_value,
          b.long_stock_value,
          b.cash_balance,
        ),
        totalFromStocksCashPlusMargin: matches(
          b.total_account_value,
          b.long_stock_value,
          b.cash_balance,
          b.margin_balance,
        ),
        totalFromStocksCashMinusMargin: matches(
          b.total_account_value,
          b.long_stock_value,
          b.cash_balance,
          minusMargin,
        ),
        totalFromPositionsCash: matches(
          b.total_account_value,
          sum,
          b.cash_balance,
        ),
        totalFromPositionsCashPlusMargin: matches(
          b.total_account_value,
          sum,
          b.cash_balance,
          b.margin_balance,
        ),
        totalFromPositionsCashMinusMargin: matches(
          b.total_account_value,
          sum,
          b.cash_balance,
          minusMargin,
        ),
        totalFromStocksOnly: matches(b.total_account_value, b.long_stock_value),
        totalFromPositionsOnly: matches(b.total_account_value, sum),
      },
    };
  });
}
