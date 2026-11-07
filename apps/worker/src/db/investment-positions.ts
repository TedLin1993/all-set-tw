import { sql } from "drizzle-orm";
import { investmentPositions } from "./schema";

/**
 * Select the complete latest snapshot for each safe holding scope.
 *
 * Known broker/account/market/asset-type rows are grouped across connectors so
 * a direct broker snapshot can supersede TDCC for the same account, market and
 * asset type. Keeping the asset type in the scope also stops one asset type's
 * newer snapshot from hiding another's within a single connector. Rows
 * without a complete identity stay scoped to their connector and asset type;
 * they must never be guessed into another account or market. The first CTE
 * keeps the existing connector + asset type latest-snapshot boundary before
 * cross-source scope selection, so stale accounts cannot reappear.
 */
export const LATEST_INVESTMENT_POSITION_IDS_SQL = `WITH latest_connector_asset AS (
  SELECT connector_id, asset_type, MAX(as_of_date) AS as_of_date
  FROM investment_positions
  GROUP BY connector_id, asset_type
), scoped_positions AS (
  SELECT
    position.id,
    position.connector_id,
    position.asset_type,
    position.as_of_date,
    CASE
      WHEN length(position.as_of_date) = 10
       AND substr(position.as_of_date, 5, 1) = '-'
       AND substr(position.as_of_date, 8, 1) = '-'
      THEN position.as_of_date
      ELSE strftime('%Y-%m-%d', position.as_of_date, '+8 hours')
    END AS as_of_day,
    position.updated_at,
    CASE
      WHEN NULLIF(TRIM(position.broker_no), '') IS NOT NULL
       AND NULLIF(TRIM(position.broker_account), '') IS NOT NULL
       AND NULLIF(TRIM(position.market), '') IS NOT NULL
      THEN 'identity|' || TRIM(position.broker_no) || '|' ||
           TRIM(position.broker_account) || '|' || UPPER(TRIM(position.market)) ||
           '|' || position.asset_type
      ELSE 'connector|' || position.connector_id || '|' ||
           position.asset_type || '|' || COALESCE(UPPER(TRIM(position.market)), '')
    END AS scope_key
  FROM investment_positions position
  JOIN latest_connector_asset latest
    ON latest.connector_id = position.connector_id
   AND latest.asset_type = position.asset_type
   AND latest.as_of_date = position.as_of_date
), scope_versions AS (
  SELECT
    scope_key,
    connector_id,
    as_of_day,
    MAX(updated_at) AS updated_at,
    CASE
      WHEN connector_id = 'sinotrade' THEN 2
      WHEN connector_id = 'tdcc' THEN 0
      ELSE 1
    END AS direct_priority
  FROM scoped_positions
  GROUP BY scope_key, connector_id, as_of_day
), ranked_scope_versions AS (
  SELECT
    scope_key,
    connector_id,
    as_of_day,
    ROW_NUMBER() OVER (
      PARTITION BY scope_key
      ORDER BY as_of_day DESC, direct_priority DESC, updated_at DESC, connector_id ASC
    ) AS scope_rank
  FROM scope_versions
)
SELECT position.id
FROM scoped_positions position
JOIN ranked_scope_versions selected
  ON selected.scope_key = position.scope_key
 AND selected.connector_id = position.connector_id
 AND selected.as_of_day = position.as_of_day
 AND selected.scope_rank = 1`;

export function isLatestInvestmentPosition(
  positions: Pick<
    typeof investmentPositions,
    "id" | "connectorId" | "assetType" | "asOfDate"
  > = investmentPositions,
) {
  return sql`${positions.id} IN (${sql.raw(LATEST_INVESTMENT_POSITION_IDS_SQL)})`;
}
