export const DEFAULT_EXCHANGE_CURRENCIES: readonly string[] = [
  "USD",
  "JPY",
  "EUR",
];
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));

export function assetExchangeRateCurrencies(
  amounts: ReadonlyArray<{ currency: string; amount: number }>,
) {
  const extraCurrencies = new Set(
    amounts
      .filter(
        ({ currency, amount }) =>
          currency !== "TWD" &&
          currencyCodes.has(currency) &&
          !DEFAULT_EXCHANGE_CURRENCIES.includes(currency) &&
          amount !== 0,
      )
      .map(({ currency }) => currency),
  );
  return [...DEFAULT_EXCHANGE_CURRENCIES, ...[...extraCurrencies].sort()];
}
