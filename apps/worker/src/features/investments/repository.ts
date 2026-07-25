import type { MonthDateRange } from "../../platform/month-range";

export type InvestmentPageCursor = {
  asOfDate: string;
  assetType: string;
  name: string;
  id: string;
};

export type TransactionPageCursor = {
  effectiveDate: string;
  updatedAt: string;
  id: string;
};

export type InvestmentPositionRow = {
  id: string;
  assetType: string;
  symbol: string | null;
  name: string;
  quantity: number | null;
  marketValue: number | null;
  cashBalance: number | null;
  currency: string;
  asOfDate: string;
};

export async function listLatestInvestmentPositions(
  db: D1Database,
  limit: number,
  cursor?: InvestmentPageCursor,
) {
  const cursorClause = cursor
    ? `AND (
        investment_positions.as_of_date < ?
        OR (
          investment_positions.as_of_date = ?
          AND (investment_positions.asset_type, investment_positions.name, investment_positions.id) > (?, ?, ?)
        )
      )`
    : "";
  const statement = db.prepare(
    `SELECT
      id,
      asset_type AS assetType,
      symbol,
      name,
      quantity,
      market_value AS marketValue,
      cash_balance AS cashBalance,
      currency,
      as_of_date AS asOfDate
    FROM investment_positions
    WHERE as_of_date = (
      SELECT MAX(p2.as_of_date) FROM investment_positions p2
      WHERE p2.connector_id = investment_positions.connector_id
        AND p2.asset_type = investment_positions.asset_type
    )
    ${cursorClause}
    ORDER BY as_of_date DESC, asset_type ASC, name ASC, id ASC
    LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(
          cursor.asOfDate,
          cursor.asOfDate,
          cursor.assetType,
          cursor.name,
          cursor.id,
          limit,
        )
      : statement.bind(limit)
  ).all<InvestmentPositionRow>();
  return rows.results;
}

export async function listInvestmentTransactions(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  const cursorClause = cursor
    ? "WHERE (effective_date, updated_at, id) < (?, ?, ?)"
    : "";
  const statement = db.prepare(
    `SELECT
      id,
      connector_id AS connectorId,
      account_id AS accountId,
      source_id AS sourceId,
      broker_no AS brokerNo,
      broker_account AS brokerAccount,
      broker_name AS brokerName,
      symbol,
      name,
      asset_type AS assetType,
      trade_date AS tradeDate,
      posted_date AS postedDate,
      transaction_code AS transactionCode,
      transaction_name AS transactionName,
      quantity,
      price,
      amount,
      currency,
      effective_date AS effectiveDate,
      updated_at AS updatedAt
    FROM investment_transactions
    ${cursorClause}
    ORDER BY effective_date DESC, updated_at DESC, id DESC
    LIMIT ?`,
  );
  const rows = await (
    cursor
      ? statement.bind(cursor.effectiveDate, cursor.updatedAt, cursor.id, limit)
      : statement.bind(limit)
  ).all<
    Record<string, unknown> & {
      id: string;
      effectiveDate: string;
      updatedAt: string;
    }
  >();
  return rows.results;
}

export async function listInvestmentTransactionsInRange(
  db: D1Database,
  range: MonthDateRange,
) {
  const rows = await db
    .prepare(
      `SELECT
      id,
      connector_id AS connectorId,
      account_id AS accountId,
      source_id AS sourceId,
      broker_no AS brokerNo,
      broker_account AS brokerAccount,
      broker_name AS brokerName,
      symbol,
      name,
      asset_type AS assetType,
      trade_date AS tradeDate,
      posted_date AS postedDate,
      transaction_code AS transactionCode,
      transaction_name AS transactionName,
      quantity,
      price,
      amount,
      currency,
      effective_date AS effectiveDate,
      updated_at AS updatedAt
    FROM investment_transactions
    WHERE effective_date >= ? AND effective_date < ?
    ORDER BY effective_date DESC, updated_at DESC, id DESC`,
    )
    .bind(range.from, range.to)
    .all<
      Record<string, unknown> & {
        id: string;
        effectiveDate: string;
        updatedAt: string;
      }
    >();
  return rows.results;
}
