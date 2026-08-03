import type { ExchangeRateRow, ManualAssetRow } from "@/data/assets/types";
import type { BankAccountRow, BankData } from "@/data/bank/types";
import type { InvestmentRow } from "@/data/investments/types";

export interface BankAccountGroup {
  institution: string;
  accounts: BankAccountRow[];
  totalTwd: number;
  foreignCurrencies: string[];
}

export interface AssetSummary {
  deposits: BankAccountRow[];
  cards: BankAccountRow[];
  bankTotal: number;
  investmentTotal: number;
  manualTotal: number;
  cardDebt: number;
  grossAssets: number;
  netWorth: number;
  groupedBanks: BankAccountGroup[];
}

export function calculateAssetSummary({
  bank,
  investments,
  manualAssets,
  rates,
}: {
  bank: BankData;
  investments: InvestmentRow[];
  manualAssets: ManualAssetRow[];
  rates?: ExchangeRateRow[];
}): AssetSummary {
  const rateValues = Object.fromEntries(
    (rates ?? []).map((rate) => [rate.currency, rate.rateTwd]),
  );
  const toTwd = (value: number, currency: string) =>
    currency === "TWD" ? value : value * (rateValues[currency] ?? 0);
  const deposits = bank.accounts.filter(
    (account) => account.accountType !== "credit",
  );
  const cards = bank.accounts.filter(
    (account) => account.accountType === "credit",
  );
  const bankTotal = deposits.reduce(
    (sum, account) => sum + toTwd(account.balance ?? 0, account.currency),
    0,
  );
  const investmentTotal = investments.reduce(
    (sum, item) =>
      sum +
      toTwd((item.marketValue ?? 0) + (item.cashBalance ?? 0), item.currency),
    0,
  );
  const manualTotal = manualAssets.reduce(
    (sum, item) => sum + toTwd(item.value ?? 0, item.currency),
    0,
  );
  const cardDebt = cards.reduce(
    (sum, account) =>
      sum + Math.abs(toTwd(account.balance ?? 0, account.currency)),
    0,
  );
  const grossAssets = bankTotal + investmentTotal + manualTotal;

  const groups = deposits.reduce<Record<string, BankAccountRow[]>>(
    (result, account) => {
      const institution = account.institutionName ?? account.connectorId;
      (result[institution] ??= []).push(account);
      return result;
    },
    {},
  );
  const groupedBanks = Object.entries(groups)
    .map(([institution, accounts]) => ({
      institution,
      accounts: [...accounts].sort(
        (a, b) =>
          toTwd(b.balance ?? 0, b.currency) - toTwd(a.balance ?? 0, a.currency),
      ),
      totalTwd: accounts.reduce(
        (sum, account) => sum + toTwd(account.balance ?? 0, account.currency),
        0,
      ),
      foreignCurrencies: [
        ...new Set(
          accounts
            .map((account) => account.currency)
            .filter((currency) => currency !== "TWD"),
        ),
      ],
    }))
    .sort(
      (a, b) =>
        b.totalTwd - a.totalTwd ||
        a.institution.localeCompare(b.institution, "zh-TW"),
    );

  return {
    deposits,
    cards,
    bankTotal,
    investmentTotal,
    manualTotal,
    cardDebt,
    grossAssets,
    netWorth: grossAssets - cardDebt,
    groupedBanks,
  };
}
