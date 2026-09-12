import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  investmentPositions,
  invoices,
} from "@taiwan-fin-hub/db";
import { and, isNull, sql } from "drizzle-orm";

export async function loadDashboardSummary(db: D1Database) {
  const database = createDrizzle(db);
  // Four independent aggregates stay concurrent; do not fold them into one scan.
  const [invoiceRow, investmentRow, bankAccountRow, bankBalanceRow] =
    await Promise.all([
      database
        .select({ count: sql<number>`count(*)`.as("count") })
        .from(invoices)
        .get(),
      database
        .select({
          count: sql<number>`count(*)`.as("count"),
          total:
            sql<number>`coalesce(sum(${investmentPositions.marketValue}), 0)`.as(
              "total",
            ),
        })
        .from(investmentPositions)
        .where(
          // Latest as_of_date is per connector + asset type, not a global max.
          sql`${investmentPositions.asOfDate} = (
            SELECT MAX(p2.as_of_date) FROM investment_positions p2
            WHERE p2.connector_id = ${investmentPositions.connectorId}
              AND p2.asset_type = ${investmentPositions.assetType}
          )`,
        )
        .get(),
      database
        .select({ count: sql<number>`count(*)`.as("count") })
        .from(bankAccounts)
        .where(
          and(
            isNull(bankAccounts.canonicalAccountId),
            isNull(bankAccounts.inactiveAt),
          ),
        )
        .get(),
      database
        .select({
          total:
            sql<number>`coalesce(sum(${bankBalanceSnapshots.balance}), 0)`.as(
              "total",
            ),
        })
        .from(bankBalanceSnapshots)
        .where(
          sql`${bankBalanceSnapshots.id} IN (
            SELECT (
              SELECT latest.id
              FROM bank_balance_snapshots latest
              WHERE latest.account_id = account.id
              ORDER BY latest.as_of_at DESC, latest.updated_at DESC
              LIMIT 1
            )
            FROM bank_accounts account
            WHERE account.canonical_account_id IS NULL AND account.inactive_at IS NULL
          )`,
        )
        .get(),
    ]);
  return { invoiceRow, investmentRow, bankAccountRow, bankBalanceRow };
}
