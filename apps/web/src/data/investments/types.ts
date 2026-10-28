import type { ConnectorId } from "@taiwan-fin-hub/shared";

export interface InvestmentRow {
  id: string;
  /** 產生持倉的資料來源，用於依機構分組。 */
  connectorId: ConnectorId;
  /** 來源內的持倉識別碼；加密貨幣合約為 `futures-*`、錢包總值為 `wallet-*`，無持倉列為 `empty`。 */
  sourceId: string;
  assetType: "stock" | "etf" | "fund" | "crypto";
  symbol?: string;
  name: string;
  quantity?: number;
  marketValue?: number;
  cashBalance?: number;
  currency: string;
  asOfDate: string;
}

export interface InvestmentTransactionRow {
  id: string;
  connectorId: ConnectorId;
  accountId: string;
  sourceId: string;
  brokerNo?: string;
  brokerAccount?: string;
  brokerName?: string;
  symbol?: string;
  name?: string;
  assetType?: "stock" | "etf" | "fund" | "bond" | "unknown";
  tradeDate?: string;
  postedDate?: string;
  transactionCode?: string;
  transactionName?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  currency: string;
}
