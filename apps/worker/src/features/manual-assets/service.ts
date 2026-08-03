import {
  createManualAsset as createManualAssetRecord,
  deleteManualAsset as deleteManualAssetRecord,
  deleteManualAssetHistory as deleteManualAssetHistoryRecord,
  listLatestManualAssetValues,
  listManualAssetHistory as listManualAssetHistoryRecords,
  listManualAssets as listManualAssetRecords,
  updateManualAsset as updateManualAssetRecord,
  upsertManualAssetHistory,
} from "./repository";

export async function getManualAssets(db: D1Database) {
  const [assets, history] = await Promise.all([
    listManualAssetRecords(db),
    listLatestManualAssetValues(db),
  ]);
  const valueMap = Object.fromEntries(
    history.map((row) => [row.assetId, { value: row.value, date: row.date }]),
  );
  return assets.map((asset) => ({ ...asset, ...valueMap[asset.id] }));
}

export async function addManualAsset(
  db: D1Database,
  input: {
    name: string;
    category: string;
    note?: string;
    currency: string;
    value: number;
    date: string;
  },
) {
  const id = `manual:${crypto.randomUUID()}`;
  await createManualAssetRecord(db, {
    ...input,
    id,
    note: input.note ?? null,
    now: new Date().toISOString(),
  });
  return id;
}

export function editManualAsset(
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
) {
  return updateManualAssetRecord(db, id, input, new Date().toISOString());
}

export function removeManualAsset(db: D1Database, id: string) {
  return deleteManualAssetRecord(db, id);
}

export function getManualAssetHistory(db: D1Database, id: string) {
  return listManualAssetHistoryRecords(db, id);
}

export function setManualAssetHistory(
  db: D1Database,
  id: string,
  input: { date: string; value: number },
) {
  return upsertManualAssetHistory(
    db,
    id,
    input.date,
    input.value,
    new Date().toISOString(),
  );
}

export function removeManualAssetHistory(
  db: D1Database,
  id: string,
  date: string,
) {
  return deleteManualAssetHistoryRecord(db, id, date);
}
