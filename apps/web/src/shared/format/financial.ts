import { moneyState } from "../state/money-visibility.svelte";

type CurrencyAmount = { currency: string; amount: number };
type ExchangeRate = { currency: string; rateTwd: number; updatedAt?: string };
type AccountBalance = {
  currency: string;
  balance?: number;
  availableBalance?: number;
};

export function formatCurrency(value: number, currency = "TWD") {
  if (moneyState.hidden) return "••••••";
  const sign = value < 0 ? "−" : "";
  const number = new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: 0,
  }).format(Math.abs(value));
  const symbols: Record<string, string> = {
    TWD: "NT$",
    USD: "US$",
    JPY: "JP¥",
    EUR: "€",
  };
  return `${sign}${symbols[currency] ?? `${currency} `}${number}`;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function formatCompactTwd(value: number) {
  if (moneyState.hidden) return "••••";
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(0)}萬`;
  return formatNumber(Math.round(value));
}

export function formatDateTime(value?: string) {
  const date = parseValidDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatDate(value?: string) {
  const date = parseValidDate(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "short" }).format(date);
}

export function normalizeFinancialDate(value?: string) {
  if (!value) return "";
  const roc = value.match(/^0(\d{3})-(\d{2})-(\d{2})(.*)$/);
  if (!roc) return value;
  return `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}${roc[4]}`;
}

export function parseValidDate(value?: string) {
  if (!value) return undefined;
  const normalized = normalizeFinancialDate(value);
  const date = new Date(normalized);
  if (!Number.isNaN(date.getTime())) return date;
  const prefix = normalized.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!prefix) return undefined;
  const fallback = new Date(
    Number(prefix[1]),
    Number(prefix[2]) - 1,
    Number(prefix[3]),
  );
  return Number.isNaN(fallback.getTime()) ? undefined : fallback;
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function formatBankAccountName(account: {
  accountName?: string;
  sourceId?: string;
  accountSourceId?: string;
  accountType?: string;
}) {
  if (account.accountType === "credit")
    return (
      account.accountName ?? account.sourceId ?? account.accountSourceId ?? "-"
    );
  const sourceId = account.accountSourceId ?? account.sourceId ?? "";
  const last5 = bankAccountLast5(sourceId);
  if (last5) return last5;
  const name = account.accountName?.startsWith("末五碼 ")
    ? account.accountName.slice(4)
    : account.accountName;
  return name ?? sourceId ?? "-";
}

export function bankAccountLast5(sourceId: string) {
  const settlement = sourceId.match(/^settlement:[^:]+:([^:]+)/);
  const esun = sourceId.match(/^bank:esun:([^:]+)/);
  const digits = (settlement?.[1] ?? esun?.[1] ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-5) : undefined;
}

export function formatCurrencyTotals(totals: Record<string, number>) {
  if (moneyState.hidden && Object.keys(totals).length > 0) return "••••••";
  const entries = Object.entries(totals);
  if (entries.length === 0) return formatCurrency(0);
  if (entries.length === 1)
    return formatCurrency(entries[0]![1], entries[0]![0]);
  return entries
    .map(([currency, amount]) => formatCurrency(amount, currency))
    .join(" · ");
}

export function sumAccountsByCurrency(
  accounts: AccountBalance[],
  field: "balance" | "availableBalance",
) {
  return accounts.reduce<Record<string, number>>((totals, account) => {
    const currency = account.currency || "TWD";
    totals[currency] = (totals[currency] ?? 0) + (account[field] ?? 0);
    return totals;
  }, {});
}

export function rateMap(rates: ExchangeRate[] | undefined) {
  return Object.fromEntries((rates ?? []).map((r) => [r.currency, r.rateTwd]));
}

export function missingExchangeRateCurrencies(
  amounts: ReadonlyArray<CurrencyAmount>,
  rates: Readonly<Record<string, number>>,
) {
  return [
    ...new Set(
      amounts
        .filter(
          ({ currency, amount }) =>
            amount > 0 && currency !== "TWD" && rates[currency] == null,
        )
        .map(({ currency }) => currency),
    ),
  ].sort();
}

export function transactionValueTwd(
  transaction: CurrencyAmount,
  rates: Record<string, number>,
) {
  if (transaction.currency === "TWD") return transaction.amount;
  return transaction.amount * (rates[transaction.currency] ?? 1);
}
