import type { ExchangeRateRow, ManualAssetRow } from "@/data/assets/types";
import type { BankAccountRow, BankData } from "@/data/bank/types";
import type { InvestmentRow } from "@/data/investments/types";
import { missingExchangeRateCurrencies } from "@/shared/format/financial";

const CONNECTOR_BANK_CODES: Record<string, string> = {
  firstbank: "007",
  hncb: "008",
  cathaybk: "013",
  obank: "048",
  skbank: "103",
  sinopac: "807",
  esun: "808",
  taishin: "812",
  ctbc: "822",
  kgibank: "809",
  megabank: "017",
  rakuten: "826",
};

export interface InstitutionAssetGroup {
  key: string;
  institution: string;
  accounts: BankAccountRow[];
  cards: BankAccountRow[];
  loans: BankAccountRow[];
  assetTotalTwd: number;
  debtTotalTwd: number;
  loanDebtTotalTwd: number;
  loanCategoryTotals: { housing: number; other: number };
  hasUnknownCardBalance: boolean;
  hasUnknownLoanBalance: boolean;
  foreignCurrencies: string[];
}

export interface AssetSummary {
  deposits: BankAccountRow[];
  cards: BankAccountRow[];
  loans: BankAccountRow[];
  bankTotal: number;
  investmentTotal: number;
  manualTotal: number;
  cardDebt: number;
  loanDebt: number;
  hasUnknownCardBalance: boolean;
  hasUnknownLoanBalance: boolean;
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
  const deposits = bank.accounts.filter(
    (account) =>
      account.accountType !== "credit" && account.accountType !== "loan",
  );
  const cards = bank.accounts.filter(
    (account) => account.accountType === "credit",
  );
  const loans = bank.accounts.filter(
    (account) => account.accountType === "loan",
  );
  const missingCurrencies = missingExchangeRateCurrencies(
    [
      ...deposits.map((account) => ({
        currency: account.currency,
        amount: account.balance ?? 0,
      })),
      ...cards.map((account) => ({
        currency: account.currency,
        amount: Math.abs(account.balance ?? 0),
      })),
      ...loans.map((account) => ({
        currency: account.currency,
        amount: Math.abs(account.balance ?? 0),
      })),
      ...investments.map((item) => ({
        currency: item.currency,
        amount: (item.marketValue ?? 0) + (item.cashBalance ?? 0),
      })),
      ...manualAssets.map((item) => ({
        currency: item.currency,
        amount: item.value ?? 0,
      })),
    ],
    rateValues,
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
    (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
    0,
  );
  const loanDebt = loans.reduce(
    (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
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
        (account) =>
          account.accountType !== "credit" && account.accountType !== "loan",
      );
      const cards = groupedAccounts.filter(
        (account) => account.accountType === "credit",
      );
      const loans = groupedAccounts.filter(
        (account) => account.accountType === "loan",
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
        hasUnknownCardBalance: cards.some((card) => card.balance == null),
        debtTotalTwd: cards.reduce(
          (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
          0,
        ),
        loans: [...loans].sort(
          (a, b) =>
            Math.abs(toTwd(b.balance ?? 0, b.currency)) -
            Math.abs(toTwd(a.balance ?? 0, a.currency)),
        ),
        loanDebtTotalTwd: loans.reduce(
          (sum, account) => sum - toTwd(account.balance ?? 0, account.currency),
          0,
        ),
        loanCategoryTotals: {
          housing: loans
            .filter((loan) => loan.loanCategory === "housing")
            .reduce(
              (sum, loan) => sum - toTwd(loan.balance ?? 0, loan.currency),
              0,
            ),
          other: loans
            .filter((loan) => loan.loanCategory === "other")
            .reduce(
              (sum, loan) => sum - toTwd(loan.balance ?? 0, loan.currency),
              0,
            ),
        },
        hasUnknownLoanBalance: loans.some((loan) => loan.balance == null),
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
        b.loanDebtTotalTwd - a.loanDebtTotalTwd ||
        b.debtTotalTwd - a.debtTotalTwd ||
        a.institution.localeCompare(b.institution, "zh-TW"),
    );

  return {
    deposits,
    cards,
    loans,
    bankTotal,
    investmentTotal,
    manualTotal,
    cardDebt,
    loanDebt,
    hasUnknownCardBalance: cards.some((card) => card.balance == null),
    hasUnknownLoanBalance: loans.some((loan) => loan.balance == null),
    grossAssets,
    netWorth: grossAssets - cardDebt - loanDebt,
    institutionGroups,
    missingCurrencies,
  };
}
