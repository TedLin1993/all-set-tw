import type { ConnectorId } from "@taiwan-fin-hub/shared";

export interface InvestmentRow {
  id: string;
  /** 產生持倉的資料來源，用於依機構分組。 */
  connectorId: ConnectorId;
  /** 來源內的持倉識別碼；加密貨幣合約為 `futures-*`、錢包總值為 `wallet-*`，無持倉列以 `empty` 開頭。 */
  sourceId: string;
  assetType: "stock" | "etf" | "fund" | "crypto";
  symbol?: string;
  name: string;
  quantity?: number;
  marketValue?: number;
  cashBalance?: number;
  /** 原幣成本；來源尚未提供或無法取得時保留 null。 */
  costBasis?: number | null;
  /** 原幣未實現損益；不併入市值。 */
  unrealizedPnl?: number | null;
  /** 交易市場，例如 TW 或 US。 */
  market?: string | null;
  /** 券商分公司代號與交易帳號，用於辨識持倉來源。 */
  brokerNo?: string | null;
  brokerAccount?: string | null;
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
  /** 賣出的已實現損益；買進或來源沒有完整成本時為 null。 */
  realizedPnl?: number | null;
  currency: string;
}
