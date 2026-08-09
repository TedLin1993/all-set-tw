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
  const assets = await db
    .prepare(
      `SELECT id, name, category, note, currency, created_at AS createdAt
     FROM manual_assets
     ORDER BY created_at ASC`,
    )
    .all<ManualAssetRow>();
  return assets.results;
}

export async function listLatestManualAssetValues(db: D1Database) {
  const history = await db
    .prepare(
      `SELECT asset_type AS assetId, net_worth AS value, date
     FROM net_worth_history
     WHERE source = 'manual'
     GROUP BY asset_type
     HAVING date = MAX(date)`,
    )
    .all<ManualAssetHistoryRow>();
  return history.results;
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
  await db.batch([
    db
      .prepare(
        `INSERT INTO manual_assets (id, name, category, note, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.name,
        input.category,
        input.note,
        input.currency,
        input.now,
      ),
    manualAssetHistoryUpsertStatement(
      db,
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
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.name) {
    sets.push("name = ?");
    values.push(input.name);
  }
  if (input.category) {
    sets.push("category = ?");
    values.push(input.category);
  }
  if ("note" in input) {
    sets.push("note = ?");
    values.push(input.note ?? null);
  }
  if (input.currency) {
    sets.push("currency = ?");
    values.push(input.currency);
  }
  const statements: D1PreparedStatement[] = [];
  if (sets.length > 0) {
    statements.push(
      db
        .prepare(`UPDATE manual_assets SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...values, id),
    );
  }
  if (input.value !== undefined && input.date !== undefined) {
    statements.push(
      manualAssetHistoryUpsertStatement(db, id, input.date, input.value, now),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function deleteManualAsset(db: D1Database, id: string) {
  await db.batch([
    db
      .prepare(
        "DELETE FROM net_worth_history WHERE source = 'manual' AND asset_type = ?",
      )
      .bind(id),
    db.prepare("DELETE FROM manual_assets WHERE id = ?").bind(id),
  ]);
}

export async function listManualAssetHistory(db: D1Database, id: string) {
  const rows = await db
    .prepare(
      `SELECT date, net_worth AS value
     FROM net_worth_history
     WHERE source = 'manual' AND asset_type = ?
     ORDER BY date ASC`,
    )
    .bind(id)
    .all<{ date: string; value: number }>();
  return rows.results;
}

export async function upsertManualAssetHistory(
  db: D1Database,
  id: string,
  date: string,
  value: number,
  now: string,
) {
  await manualAssetHistoryUpsertStatement(db, id, date, value, now).run();
}

export async function deleteManualAssetHistory(
  db: D1Database,
  id: string,
  date: string,
) {
  await db
    .prepare(
      `DELETE FROM net_worth_history
     WHERE source = 'manual' AND asset_type = ? AND date = ?`,
    )
    .bind(id, date)
    .run();
}

function manualAssetHistoryUpsertStatement(
  db: D1Database,
  id: string,
  date: string,
  value: number,
  now: string,
) {
  return db
    .prepare(
      `INSERT INTO net_worth_history (id, date, net_worth, asset_type, source, snapshotted_at)
     VALUES (?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(source, asset_type, date) DO UPDATE SET
       net_worth = excluded.net_worth,
       snapshotted_at = excluded.snapshotted_at`,
    )
    .bind(`manual:${id}:${date}`, date, value, id, now);
}
