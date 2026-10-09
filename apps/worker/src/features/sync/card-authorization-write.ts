import type { ConnectorId } from "@taiwan-fin-hub/shared";
import {
  matchCardAuthorizations,
  type CardAuthorizationLink,
} from "./card-authorization-matching";
import type { SyncWriteRecord } from "./persistence";

export type CardTransactionRow = Record<string, unknown> & {
  id: string;
  connector_id: string;
  account_id: string;
  source_id: string;
  status: string;
  authorized_at: string | null;
  posted_date: string | null;
  amount: number;
  currency: string;
  description: string | null;
  raw_payload: string;
  matched_transaction_id: string | null;
};

export function mergeCardTransactionRows(
  stored: CardTransactionRow[],
  records: SyncWriteRecord[],
) {
  const rows = new Map(stored.map((row) => [row.id, row]));
  for (const record of records) {
    if (record.entityType !== "bank_transaction") continue;
    const row = record.payload as CardTransactionRow;
    const previous = rows.get(row.id);
    rows.set(row.id, {
      ...(previous?.status === "posted" && row.status === "pending"
        ? previous
        : row),
      authorized_at:
        (previous?.authorized_at?.length ?? 0) > 10
          ? previous!.authorized_at
          : row.authorized_at,
      matched_transaction_id: previous?.matched_transaction_id ?? null,
    });
  }
  return [...rows.values()];
}

export function cardTransactionPreferenceStatements(
  db: D1Database,
  links: readonly Pick<CardAuthorizationLink, "id" | "posted">[],
  options: {
    connectorId: ConnectorId;
    encryptedConfig?: string;
    fillUncategorized?: boolean;
  },
) {
  if (!links.length) return [];
  const json = JSON.stringify(links);
  const guard =
    options.encryptedConfig == null
      ? ""
      : " AND EXISTS (SELECT 1 FROM connector_settings WHERE connector_id = ? AND encrypted_config = ?)";
  const bind = (sql: string, ...bindings: string[]) =>
    db
      .prepare(sql.replace("/* settings guard */", guard))
      .bind(
        ...bindings,
        ...(options.encryptedConfig == null
          ? []
          : [options.connectorId, options.encryptedConfig]),
      );
  return [
    bind(
      `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
      SELECT json_extract(link.value, '$.posted'), preference.excluded_from_calculation, preference.created_at, preference.updated_at
      FROM json_each(?) link JOIN bank_transaction_preferences preference ON preference.transaction_id = json_extract(link.value, '$.id')
      WHERE true /* settings guard */ ON CONFLICT(transaction_id) DO NOTHING`,
      json,
    ),
    bind(
      `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
      SELECT 'override:bank_transaction:' || json_extract(link.value, '$.posted'), 'bank_transaction', json_extract(link.value, '$.posted'), preference.category_id, preference.created_at, preference.updated_at
      FROM json_each(?) link JOIN classification_overrides preference ON preference.target_type = 'bank_transaction' AND preference.target_id = json_extract(link.value, '$.id')
      WHERE true ${options.fillUncategorized ? "AND preference.category_id <> 'other'" : ""} /* settings guard */
      ON CONFLICT(target_type, target_id) ${options.fillUncategorized ? "DO UPDATE SET category_id = excluded.category_id, updated_at = excluded.updated_at WHERE classification_overrides.category_id = 'other'" : "DO NOTHING"}`,
      json,
    ),
    bind(
      `UPDATE invoice_transaction_preferences SET transaction_id = (
        SELECT json_extract(link.value, '$.posted') FROM json_each(?) link WHERE json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
      ) WHERE transaction_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM invoice_transaction_preferences existing JOIN json_each(?) link ON existing.transaction_id = json_extract(link.value, '$.posted')
        WHERE existing.decision = 'linked' AND json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id) /* settings guard */`,
      json,
      json,
      json,
    ),
  ];
}

export function cardAuthorizationLinkStatements(
  db: D1Database,
  connectorId: ConnectorId,
  links: readonly CardAuthorizationLink[],
  encryptedConfig?: string,
) {
  if (!links.length) return [];
  const json = JSON.stringify(links);
  const guard =
    encryptedConfig == null
      ? ""
      : " AND EXISTS (SELECT 1 FROM connector_settings WHERE connector_id = ? AND encrypted_config = ?)";
  const bind = (sql: string) =>
    db
      .prepare(sql.replace("/* settings guard */", guard))
      .bind(
        json,
        connectorId,
        ...(encryptedConfig == null ? [] : [connectorId, encryptedConfig]),
      );
  return [
    bind(`UPDATE bank_transactions SET matched_transaction_id = json_extract(link.value, '$.posted')
      FROM json_each(?) link WHERE connector_id = ? AND bank_transactions.id = json_extract(link.value, '$.id')
      AND bank_transactions.status = 'pending' AND bank_transactions.matched_transaction_id IS NULL /* settings guard */`),
    bind(`UPDATE bank_transactions SET authorized_at = json_extract(link.value, '$.authorizedAt')
      FROM json_each(?) link WHERE connector_id = ? AND bank_transactions.id = json_extract(link.value, '$.posted')
      AND length(COALESCE(bank_transactions.authorized_at, '')) <= 10
      AND length(COALESCE(json_extract(link.value, '$.authorizedAt'), '')) > 10 /* settings guard */`),
    ...cardTransactionPreferenceStatements(db, links, {
      connectorId,
      encryptedConfig,
    }),
  ];
}

export function reuseMatchedCardTargets(
  stored: CardTransactionRow[],
  records: SyncWriteRecord[],
) {
  const byId = new Map(stored.map((row) => [row.id, row]));
  const updated = new Map<string, SyncWriteRecord>();
  for (const record of records) {
    const previous =
      record.entityType === "bank_transaction"
        ? byId.get(record.recordKey)
        : undefined;
    let target =
      record.payload.status === "posted" && previous?.matched_transaction_id
        ? byId.get(previous.matched_transaction_id)
        : undefined;
    const visited = new Set<string>();
    while (target?.matched_transaction_id && !visited.has(target.id)) {
      visited.add(target.id);
      target = byId.get(target.matched_transaction_id);
    }
    // A previously hidden authorization must stay hidden when a later feed
    // returns its source ID as posted. Update its established final target.
    const rewritten = target
      ? {
          ...record,
          recordKey: target.id,
          payload: {
            ...record.payload,
            id: target.id,
            source_id: target.source_id,
            account_id: target.account_id,
          },
        }
      : record;
    const key = `${rewritten.entityType}:${rewritten.recordKey}`;
    if (
      updated.get(key)?.payload.status === "posted" &&
      rewritten.payload.status === "pending"
    )
      continue;
    updated.set(key, rewritten);
  }
  return [...updated.values()];
}

export async function prepareCardAuthorizationWrite(
  db: D1Database,
  connectorId: ConnectorId,
  records: SyncWriteRecord[],
  options: {
    sourcePattern: string;
    cardId: (row: CardTransactionRow) => string | undefined;
    encryptedConfig?: string;
  },
) {
  const stored = (
    await db
      .prepare(
        "SELECT * FROM bank_transactions WHERE connector_id = ? AND source_id LIKE ?",
      )
      .bind(connectorId, options.sourcePattern)
      .all<CardTransactionRow>()
  ).results;
  const preparedRecords = reuseMatchedCardTargets(stored, records);
  const incoming = preparedRecords.filter(
    (record) =>
      record.entityType === "bank_transaction" &&
      record.payload.connector_id === connectorId &&
      options.cardId(record.payload as CardTransactionRow),
  );
  const rows = mergeCardTransactionRows(stored, incoming);
  const targeted = new Set(
    rows.map((row) => row.matched_transaction_id).filter(Boolean),
  );
  const candidate = (row: CardTransactionRow) => ({
    id: row.id,
    sourceId: row.source_id,
    accountId: row.account_id,
    cardId: options.cardId(row),
    authorizedAt: row.authorized_at,
    amount: row.amount,
    currency: row.currency,
  });
  const links = matchCardAuthorizations(
    rows
      .filter((row) => row.status === "pending" && !row.matched_transaction_id)
      .map(candidate),
    rows
      .filter((row) => row.status === "posted" && !targeted.has(row.id))
      .map(candidate),
  );
  return {
    records: preparedRecords,
    afterPromoteStatements: cardAuthorizationLinkStatements(
      db,
      connectorId,
      links,
      options.encryptedConfig,
    ),
  };
}
