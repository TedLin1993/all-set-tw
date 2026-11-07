import {
  createDrizzle,
  bankAccounts,
  bankBalanceSnapshots,
  investmentPositions,
  invoices,
  isLatestInvestmentPosition,
  exchangeRates,
} from "../../db";
import { and, eq, isNull, sql } from "drizzle-orm";

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
          count:
            sql<number>`coalesce(sum(CASE WHEN ${investmentPositions.sourceId} = 'empty' OR ${investmentPositions.sourceId} LIKE 'empty:%' THEN 0 ELSE 1 END), 0)`.as(
              "count",
            ),
          total:
            sql<number>`coalesce(sum((coalesce(${investmentPositions.marketValue}, 0) + coalesce(${investmentPositions.cashBalance}, 0)) * CASE WHEN ${investmentPositions.currency} = 'TWD' THEN 1 ELSE coalesce(${exchangeRates.rateToTwd}, 0) END), 0)`.as(
              "total",
            ),
        })
        .from(investmentPositions)
        .leftJoin(
          exchangeRates,
          eq(exchangeRates.currency, investmentPositions.currency),
        )
        // Apply the same latest snapshot and account authority as the asset list.
        .where(isLatestInvestmentPosition())
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
