import {
  createDb,
  manualAssets,
  netWorthHistory,
  type AppDatabase,
} from "@taiwan-fin-hub/db";
import { and, asc, eq, sql } from "drizzle-orm";

export type ManualAssetRow = {
  id: string;
  name: string;
  category: string;
  note: string | null;
  currency: string;
  createdAt: string;
};

export type ManualAssetHistoryRow = {
  assetId: string;
  value: number;
  date: string;
};

export async function listManualAssets(db: D1Database) {
  return createDb(db)
    .select({
      id: sql<string>`${manualAssets.id}`,
      name: manualAssets.name,
      category: manualAssets.category,
      note: manualAssets.note,
      currency: manualAssets.currency,
      createdAt: manualAssets.createdAt,
    })
    .from(manualAssets)
    .orderBy(asc(manualAssets.createdAt))
    .all();
}

export async function listLatestManualAssetValues(db: D1Database) {
  return createDb(db)
    .select({
      assetId: sql<string>`${netWorthHistory.assetType}`,
      value: netWorthHistory.netWorth,
      date: netWorthHistory.date,
    })
    .from(netWorthHistory)
    .where(eq(netWorthHistory.source, "manual"))
    .groupBy(netWorthHistory.assetType)
    .having(sql`${netWorthHistory.date} = max(${netWorthHistory.date})`)
    .all();
}

export async function createManualAsset(
  db: D1Database,
  input: {
    id: string;
    name: string;
    category: string;
    note: string | null;
    currency: string;
    value: number;
    date: string;
    now: string;
  },
) {
  const database = createDb(db);
  await database.batch([
    database.insert(manualAssets).values({
      id: input.id,
      name: input.name,
      category: input.category,
      note: input.note,
      currency: input.currency,
      createdAt: input.now,
    }),
    manualAssetHistoryUpsert(
      database,
      input.id,
      input.date,
      input.value,
      input.now,
    ),
  ]);
}

export async function updateManualAsset(
  db: D1Database,
  id: string,
  input: {
    name?: string;
    category?: string;
    note?: string | null;
    currency?: string;
    value?: number;
    date?: string;
  },
  now: string,
) {
  const patch: {
    name?: string;
    category?: string;
    note?: string | null;
    currency?: string;
  } = {};
  if (input.name) patch.name = input.name;
  if (input.category) patch.category = input.category;
  if ("note" in input) patch.note = input.note ?? null;
  if (input.currency) patch.currency = input.currency;

  const database = createDb(db);
  const assetUpdate =
    Object.keys(patch).length > 0
      ? database.update(manualAssets).set(patch).where(eq(manualAssets.id, id))
      : undefined;
  const historyUpsert =
    input.value !== undefined && input.date !== undefined
      ? manualAssetHistoryUpsert(database, id, input.date, input.value, now)
      : undefined;
  if (assetUpdate && historyUpsert) {
    await database.batch([assetUpdate, historyUpsert]);
  } else if (assetUpdate) {
    await assetUpdate;
  } else if (historyUpsert) {
    await historyUpsert;
  }
}

export async function deleteManualAsset(db: D1Database, id: string) {
  const database = createDb(db);
  await database.batch([
    database
      .delete(netWorthHistory)
      .where(
        and(
          eq(netWorthHistory.source, "manual"),
          eq(netWorthHistory.assetType, id),
        ),
      ),
    database.delete(manualAssets).where(eq(manualAssets.id, id)),
  ]);
}

export async function listManualAssetHistory(db: D1Database, id: string) {
  return createDb(db)
    .select({
      date: netWorthHistory.date,
      value: netWorthHistory.netWorth,
    })
    .from(netWorthHistory)
    .where(
      and(
        eq(netWorthHistory.source, "manual"),
        eq(netWorthHistory.assetType, id),
      ),
    )
    .orderBy(asc(netWorthHistory.date))
    .all();
}

export async function upsertManualAssetHistory(
  db: D1Database,
  id: string,
  date: string,
  value: number,
  now: string,
) {
  await manualAssetHistoryUpsert(createDb(db), id, date, value, now);
}

export async function deleteManualAssetHistory(
  db: D1Database,
  id: string,
  date: string,
) {
  await createDb(db)
    .delete(netWorthHistory)
    .where(
      and(
        eq(netWorthHistory.source, "manual"),
        eq(netWorthHistory.assetType, id),
        eq(netWorthHistory.date, date),
      ),
    );
}

function manualAssetHistoryUpsert(
  database: AppDatabase,
  id: string,
  date: string,
  value: number,
  now: string,
) {
  return database
    .insert(netWorthHistory)
    .values({
      id: `manual:${id}:${date}`,
      date,
      netWorth: value,
      assetType: id,
      source: "manual",
      snapshottedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        netWorthHistory.source,
        netWorthHistory.assetType,
        netWorthHistory.date,
      ],
      set: {
        netWorth: value,
        snapshottedAt: now,
      },
    });
}
