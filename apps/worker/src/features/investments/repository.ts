import {
  createDrizzle,
  investmentPositions,
  investmentTransactions,
} from "@taiwan-fin-hub/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { MonthDateRange } from "../../platform/month-range";

const latestPosition = alias(investmentPositions, "p2");

const investmentTransactionColumns = {
  id: sql<string>`${investmentTransactions.id}`,
  connectorId: investmentTransactions.connectorId,
  accountId: investmentTransactions.accountId,
  sourceId: investmentTransactions.sourceId,
  brokerNo: investmentTransactions.brokerNo,
  brokerAccount: investmentTransactions.brokerAccount,
  brokerName: investmentTransactions.brokerName,
  symbol: investmentTransactions.symbol,
  name: investmentTransactions.name,
  assetType: investmentTransactions.assetType,
  tradeDate: investmentTransactions.tradeDate,
  postedDate: investmentTransactions.postedDate,
  transactionCode: investmentTransactions.transactionCode,
  transactionName: investmentTransactions.transactionName,
  quantity: investmentTransactions.quantity,
  price: investmentTransactions.price,
  amount: investmentTransactions.amount,
  currency: investmentTransactions.currency,
  effectiveDate: sql<string>`${investmentTransactions.effectiveDate}`,
  updatedAt: investmentTransactions.updatedAt,
};

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
  return createDrizzle(db)
    .select({
      id: sql<string>`${investmentPositions.id}`,
      assetType: investmentPositions.assetType,
      symbol: investmentPositions.symbol,
      name: investmentPositions.name,
      quantity: investmentPositions.quantity,
      marketValue: investmentPositions.marketValue,
      cashBalance: investmentPositions.cashBalance,
      currency: investmentPositions.currency,
      asOfDate: investmentPositions.asOfDate,
    })
    .from(investmentPositions)
    .where(
      and(
        // Latest as_of_date is per connector + asset type, not a global max.
        eq(
          investmentPositions.asOfDate,
          sql`(
            SELECT MAX(${latestPosition.asOfDate})
            FROM ${latestPosition}
            WHERE ${latestPosition.connectorId} = ${investmentPositions.connectorId}
              AND ${latestPosition.assetType} = ${investmentPositions.assetType}
          )`,
        ),
        cursor
          ? sql`(
              ${investmentPositions.asOfDate} < ${cursor.asOfDate}
              OR (
                ${investmentPositions.asOfDate} = ${cursor.asOfDate}
                AND (${investmentPositions.assetType}, ${investmentPositions.name}, ${investmentPositions.id})
                  > (${cursor.assetType}, ${cursor.name}, ${cursor.id})
              )
            )`
          : undefined,
      ),
    )
    .orderBy(
      desc(investmentPositions.asOfDate),
      asc(investmentPositions.assetType),
      asc(investmentPositions.name),
      asc(investmentPositions.id),
    )
    .limit(limit)
    .all();
}

export async function listInvestmentTransactions(
  db: D1Database,
  limit: number,
  cursor?: TransactionPageCursor,
) {
  return createDrizzle(db)
    .select(investmentTransactionColumns)
    .from(investmentTransactions)
    .where(
      cursor
        ? sql`(${investmentTransactions.effectiveDate}, ${investmentTransactions.updatedAt}, ${investmentTransactions.id}) < (${cursor.effectiveDate}, ${cursor.updatedAt}, ${cursor.id})`
        : undefined,
    )
    .orderBy(
      desc(investmentTransactions.effectiveDate),
      desc(investmentTransactions.updatedAt),
      desc(investmentTransactions.id),
    )
    .limit(limit)
    .all();
}

export async function listInvestmentTransactionsInRange(
  db: D1Database,
  range: MonthDateRange,
  days?: string[],
) {
  return createDrizzle(db)
    .select(investmentTransactionColumns)
    .from(investmentTransactions)
    .where(
      days
        ? sql`substr(${investmentTransactions.effectiveDate}, 1, 10) IN (SELECT value FROM json_each(${JSON.stringify(days)}))`
        : and(
            sql`${investmentTransactions.effectiveDate} >= ${range.from}`,
            sql`${investmentTransactions.effectiveDate} < ${range.to}`,
          ),
    )
    .orderBy(
      desc(investmentTransactions.effectiveDate),
      desc(investmentTransactions.updatedAt),
      desc(investmentTransactions.id),
    )
    .all();
}
