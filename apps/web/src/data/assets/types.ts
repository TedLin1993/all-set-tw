export interface NetWorthHistoryRow {
  date: string;
  netWorth: number;
  assetType: string;
  source: string;
}

export interface ExchangeRateRow {
  currency: string;
  rateTwd: number;
  updatedAt: string;
}

export interface ManualAssetRow {
  id: string;
  name: string;
  category: string;
  note: string | null;
  currency: string;
  createdAt: string;
  value?: number;
  date?: string;
}

export interface ManualAssetHistoryEntry {
  date: string;
  value: number;
}
