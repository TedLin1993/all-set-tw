import type { SyncWriteRecord } from "./persistence";

export type EsunCardRow = {
  id: string;
  account_id: string;
  source_id: string;
  status: string;
  authorized_at: string | null;
  amount: number;
  currency: string;
  raw_payload: string;
  matched_transaction_id?: string | null;
};

export type EsunAuthorizationLink = {
  id: string;
  posted: string;
  authorizedAt: string | null;
};

const CARD_SOURCE_PATTERN = "%:credit:esun:%";

function isRealtimeAuthorization(row: EsunCardRow) {
  let feed: unknown;
  try {
    feed = (JSON.parse(row.raw_payload || "{}") as { esunFeed?: unknown })
      .esunFeed;
  } catch {
    feed = undefined;
  }
  if (feed === "realtime") return true;
  if (feed === "history") return false;
  // Rows written before the feed marker existed: only realtime records carry
  // an authorization clock while still unposted.
  return (
    row.status === "pending" && /T\d{2}:\d{2}/.test(row.authorized_at ?? "")
  );
}

// Realtime and statement feeds name the same purchase differently (payment
// channel vs. merchant), so pairing relies on card, day, currency and amount.
export function matchEsunAuthorizations(
  rows: EsunCardRow[],
): EsunAuthorizationLink[] {
  const targeted = new Set(
    rows.map((row) => row.matched_transaction_id).filter(Boolean),
  );
  const key = (row: EsunCardRow) =>
    [
      row.account_id,
      row.authorized_at?.slice(0, 10),
      row.currency,
      row.amount,
    ].join("|");
  const available = new Map<string, EsunCardRow[]>();
  for (const row of [...rows].sort((left, right) =>
    left.source_id.localeCompare(right.source_id),
  )) {
    if (
      !row.authorized_at ||
      row.matched_transaction_id ||
      targeted.has(row.id) ||
      isRealtimeAuthorization(row)
    )
      continue;
    const group = available.get(key(row)) ?? [];
    group.push(row);
    available.set(key(row), group);
  }
  return rows
    .filter(
      (row) =>
        row.authorized_at &&
        !row.matched_transaction_id &&
        isRealtimeAuthorization(row),
    )
    .sort(
      (left, right) =>
        (left.authorized_at ?? "").localeCompare(right.authorized_at ?? "") ||
        left.source_id.localeCompare(right.source_id),
    )
    .flatMap((authorization) => {
      const target = available.get(key(authorization))?.shift();
      return target
        ? [
            {
              id: authorization.id,
              posted: target.id,
              authorizedAt: authorization.authorized_at,
            },
          ]
        : [];
    });
}

export async function prepareEsunAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
) {
  const stored = (
    await db
      .prepare(
        `SELECT id, account_id, source_id, status, authorized_at, amount, currency, raw_payload, matched_transaction_id
      FROM bank_transactions WHERE connector_id = 'esun' AND source_id LIKE ?`,
      )
      .bind(CARD_SOURCE_PATTERN)
      .all<EsunCardRow>()
  ).results;
  const rows = new Map(stored.map((row) => [row.id, row]));
  for (const record of records) {
    if (record.entityType !== "bank_transaction") continue;
    const row = record.payload as unknown as EsunCardRow;
    if (!row.source_id.includes(":credit:esun:")) continue;
    const previous = rows.get(row.id);
    rows.set(row.id, {
      ...row,
      status: previous?.status === "posted" ? "posted" : row.status,
      authorized_at: previous?.authorized_at?.includes("T")
        ? previous.authorized_at
        : row.authorized_at,
      matched_transaction_id: previous?.matched_transaction_id ?? null,
    });
  }
  const linksJson = JSON.stringify(matchEsunAuthorizations([...rows.values()]));
  return [
    db
      .prepare(
        `UPDATE bank_transactions SET matched_transaction_id = json_extract(link.value, '$.posted')
      FROM json_each(?) link
      WHERE bank_transactions.connector_id = 'esun' AND bank_transactions.id = json_extract(link.value, '$.id')`,
      )
      .bind(linksJson),
    db
      .prepare(
        `UPDATE bank_transactions SET authorized_at = json_extract(link.value, '$.authorizedAt')
      FROM json_each(?) link
      WHERE bank_transactions.connector_id = 'esun'
        AND bank_transactions.id = json_extract(link.value, '$.posted')
        AND length(COALESCE(bank_transactions.authorized_at, '')) <= 10
        AND length(COALESCE(json_extract(link.value, '$.authorizedAt'), '')) > 10`,
      )
      .bind(linksJson),
    db
      .prepare(
        `INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
        SELECT json_extract(link.value, '$.posted'), preference.excluded_from_calculation,
          preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN bank_transaction_preferences preference
          ON preference.transaction_id = json_extract(link.value, '$.id')
        WHERE true ON CONFLICT(transaction_id) DO NOTHING`,
      )
      .bind(linksJson),
    db
      .prepare(
        `INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
        SELECT 'override:bank_transaction:' || json_extract(link.value, '$.posted'),
          'bank_transaction', json_extract(link.value, '$.posted'), preference.category_id,
          preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN classification_overrides preference
          ON preference.target_type = 'bank_transaction' AND preference.target_id = json_extract(link.value, '$.id')
        WHERE true ON CONFLICT(target_type, target_id) DO NOTHING`,
      )
      .bind(linksJson),
    db
      .prepare(
        `UPDATE invoice_transaction_preferences SET transaction_id = (
        SELECT json_extract(link.value, '$.posted') FROM json_each(?) link
        WHERE json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
      ) WHERE transaction_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM invoice_transaction_preferences existing JOIN json_each(?) link
            ON existing.transaction_id = json_extract(link.value, '$.posted')
          WHERE existing.decision = 'linked' AND json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
        )`,
      )
      .bind(linksJson, linksJson, linksJson),
  ];
}
