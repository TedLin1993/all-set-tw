export const queryKeys = {
  runtime: ["runtime"] as const,
  summary: ["summary"] as const,
  bank: ["bank"] as const,
  bankRange: (from: string, to: string) => ["bank", "range", from, to] as const,
  bills: ["creditCardBills"] as const,
  billsRange: (from: string, to: string) =>
    ["creditCardBills", "range", from, to] as const,
  investments: ["investments"] as const,
  investmentTransactions: ["investment-transactions"] as const,
  investmentTransactionsRange: (from: string, to: string) =>
    ["investment-transactions", "range", from, to] as const,
  invoices: ["invoices"] as const,
  invoicesRange: (from: string, to: string) =>
    ["invoices", "range", from, to] as const,
  invoiceDetail: (invoiceId: string) =>
    ["invoices", "detail", invoiceId] as const,
  invoiceTransactionMappings: ["invoice-transaction-mappings"] as const,
  manualAssets: ["manualAssets"] as const,
  exchangeRates: ["exchange-rates"] as const,
  netWorthHistory: ["netWorthHistory"] as const,
  syncJobs: ["sync-jobs"] as const,
  syncSchedule: ["sync-schedule"] as const,
  notifications: ["notifications"] as const,
  classificationCategories: ["classification-categories"] as const,
  classificationRules: ["classification-rules"] as const,
  connectorSettings: (id: string) => ["connector-settings", id] as const,
  manualAssetHistory: (id: string) => ["manualAssetHistory", id] as const,
};
