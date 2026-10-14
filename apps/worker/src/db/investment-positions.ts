import { sql } from "drizzle-orm";
import { investmentPositions } from "./schema";

/**
 * Latest snapshot date per connector + asset type. One GROUP BY over
 * idx_investment_positions_latest_scope replaces a MAX subquery per row.
 */
export const LATEST_INVESTMENT_POSITION_SCOPES_SQL = `SELECT latest_scope.connector_id, latest_scope.asset_type, MAX(latest_scope.as_of_date)
  FROM investment_positions latest_scope
  GROUP BY latest_scope.connector_id, latest_scope.asset_type`;

export function isLatestInvestmentPosition(
  positions: Pick<
    typeof investmentPositions,
    "connectorId" | "assetType" | "asOfDate"
  > = investmentPositions,
) {
  return sql`(${positions.connectorId}, ${positions.assetType}, ${positions.asOfDate}) IN (${sql.raw(LATEST_INVESTMENT_POSITION_SCOPES_SQL)})`;
}
