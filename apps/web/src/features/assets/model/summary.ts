import type { ExchangeRateRow, ManualAssetRow } from "@/data/assets/types";
import type { BankAccountRow, BankData } from "@/data/bank/types";
import type { InvestmentRow } from "@/data/investments/types";

const CONNECTOR_BANK_CODES: Record<string, string> = {
  cathaybk: "013",
  obank: "048",
  sinopac: "807",
  esun: "808",
  taishin: "812",
  ctbc: "822",
};

export interface InstitutionAssetGroup {
  key: string;
  institution: string;
  accounts: BankAccountRow[];
  cards: BankAccountRow[];
  assetTotalTwd: number;
  debtTotalTwd: number;
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
  institutionGroups: InstitutionAssetGroup[];
  missingCurrencies: string[];
}

function institutionKey(account: BankAccountRow) {
  const bankCode =
    account.bankCode ?? CONNECTOR_BANK_CODES[account.connectorId];
  return bankCode ? `bank:${bankCode}` : `connector:${account.connectorId}`;
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
  const missingCurrencies = new Set<string>();
  const recordMissingRate = (value: number, currency: string) => {
    if (value !== 0 && currency !== "TWD" && rateValues[currency] == null)
      missingCurrencies.add(currency);
  };
  bank.accounts.forEach((account) =>
    recordMissingRate(account.balance ?? 0, account.currency),
  );
  investments.forEach((item) =>
    recordMissingRate(
      (item.marketValue ?? 0) + (item.cashBalance ?? 0),
      item.currency,
    ),
  );
  manualAssets.forEach((item) =>
    recordMissingRate(item.value ?? 0, item.currency),
  );
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

  const groups = bank.accounts.reduce<Record<string, BankAccountRow[]>>(
    (result, account) => {
      (result[institutionKey(account)] ??= []).push(account);
      return result;
    },
    {},
  );
  const institutionGroups = Object.entries(groups)
    .map(([key, groupedAccounts]) => {
      const accounts = groupedAccounts.filter(
        (account) => account.accountType !== "credit",
      );
      const cards = groupedAccounts.filter(
        (account) => account.accountType === "credit",
      );
      return {
        key,
        institution:
          groupedAccounts.find((account) => account.institutionName)
            ?.institutionName ??
          groupedAccounts[0]?.connectorId ??
          "金融機構",
        accounts: [...accounts].sort(
          (a, b) =>
            toTwd(b.balance ?? 0, b.currency) -
            toTwd(a.balance ?? 0, a.currency),
        ),
        cards: [...cards].sort(
          (a, b) =>
            Math.abs(toTwd(b.balance ?? 0, b.currency)) -
            Math.abs(toTwd(a.balance ?? 0, a.currency)),
        ),
        assetTotalTwd: accounts.reduce(
          (sum, account) => sum + toTwd(account.balance ?? 0, account.currency),
          0,
        ),
        debtTotalTwd: cards.reduce(
          (sum, account) =>
            sum + Math.abs(toTwd(account.balance ?? 0, account.currency)),
          0,
        ),
        foreignCurrencies: [
          ...new Set(
            groupedAccounts
              .map((account) => account.currency)
              .filter((currency) => currency !== "TWD"),
          ),
        ],
      };
    })
    .sort(
      (a, b) =>
        b.assetTotalTwd - a.assetTotalTwd ||
        b.debtTotalTwd - a.debtTotalTwd ||
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
    institutionGroups,
    missingCurrencies: [...missingCurrencies].sort(),
  };
}
