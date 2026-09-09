import type { SyncWriteRecord } from "./persistence";
import {
  matchSinopacAuthorizations,
  type SinopacMatchTransaction,
} from "./sinopac-matching";

type StoredTransaction = {
  id: string;
  source_id: string;
  authorized_at: string;
  amount: number;
  currency: string;
  description: string;
  raw_payload: string;
  status: string;
  matched_transaction_id: string | null;
};
const candidate = (
  row: Omit<StoredTransaction, "status" | "raw_payload">,
): SinopacMatchTransaction => ({
  id: row.id,
  sourceId: row.source_id,
  authorizedAt: row.authorized_at,
  amount: row.amount,
  currency: row.currency,
  description: row.description ?? "",
});

export async function prepareSinopacAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
  currentAuthorizations: SyncWriteRecord[],
) {
  const [stored, rateRows] = await Promise.all([
    db
      .prepare(
        `SELECT id, source_id, authorized_at, amount, currency, description, raw_payload, status, matched_transaction_id
      FROM bank_transactions WHERE connector_id = 'sinopac' AND source_id LIKE 'sinopac:card:tx:v2:%'`,
      )
      .all<StoredTransaction>(),
    db
      .prepare("SELECT currency, rate_to_twd AS rate_twd FROM exchange_rates")
      .all<{ currency: string; rate_twd: number }>(),
  ]);
  const authorizations = new Map(
    stored.results
      .filter((row) => row.status === "pending" || row.matched_transaction_id)
      .map((row) => [row.source_id, row]),
  );
  const pending = [
    ...stored.results.filter((row) => row.status === "pending"),
    ...currentAuthorizations.map(
      (record) => record.payload as unknown as StoredTransaction,
    ),
  ];
  for (const row of pending) {
    const previous = authorizations.get(row.source_id);
    authorizations.set(row.source_id, {
      ...row,
      authorized_at: previous?.authorized_at?.includes("T")
        ? previous.authorized_at
        : row.authorized_at,
      matched_transaction_id: previous?.matched_transaction_id ?? null,
    });
  }
  const posted = new Map(
    stored.results
      .filter((row) => row.status === "posted")
      .map((row) => [row.id, row]),
  );
  for (const record of records) {
    if (
      record.entityType === "bank_transaction" &&
      record.payload.status === "posted"
    ) {
      posted.set(
        record.recordKey,
        record.payload as unknown as StoredTransaction,
      );
    }
  }
  const used = new Set(
    [...authorizations.values()]
      .map((row) => row.matched_transaction_id)
      .filter(Boolean),
  );
  const matches = matchSinopacAuthorizations(
    [...authorizations.values()]
      .filter(
        (row) =>
          !row.matched_transaction_id && row.authorized_at?.includes("T"),
      )
      .map(candidate),
    [...posted.values()].filter((row) => !used.has(row.id)).map(candidate),
    Object.fromEntries(
      rateRows.results.map((row) => [row.currency, row.rate_twd]),
    ),
  );
  for (const match of matches)
    authorizations.get(match.authorization.sourceId)!.matched_transaction_id =
      match.posted.id;
  const linked = [...authorizations.values()].filter(
    (row) => row.matched_transaction_id,
  );
  const byPosted = new Map(
    linked.map((row) => [row.matched_transaction_id, row]),
  );
  const allRecords = new Map(
    [...currentAuthorizations, ...records].map((record) => [
      record.recordKey,
      record,
    ]),
  );
  const updatedRecords = [...allRecords.values()].map((record) => {
    const authorization =
      record.entityType === "bank_transaction"
        ? byPosted.get(record.recordKey)
        : undefined;
    return authorization
      ? {
          ...record,
          payload: {
            ...record.payload,
            authorized_at: authorization.authorized_at,
          },
        }
      : record;
  });
  const linksJson = JSON.stringify(linked);
  const newLinksJson = JSON.stringify(
    matches.map((match) => authorizations.get(match.authorization.sourceId)),
  );
  return {
    records: updatedRecords,
    afterPromoteStatements: [
      db
        .prepare(
          `UPDATE bank_transactions SET matched_transaction_id = (
        SELECT json_extract(value, '$.matched_transaction_id') FROM json_each(?)
        WHERE json_extract(value, '$.id') = bank_transactions.id
      ) WHERE connector_id = 'sinopac' AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(linksJson, linksJson),
      db
        .prepare(
          `UPDATE bank_transactions SET authorized_at = (
        SELECT json_extract(value, '$.authorized_at') FROM json_each(?)
        WHERE json_extract(value, '$.matched_transaction_id') = bank_transactions.id
      ) WHERE connector_id = 'sinopac' AND status = 'posted' AND id IN (
        SELECT json_extract(value, '$.matched_transaction_id') FROM json_each(?)
      )`,
        )
        .bind(linksJson, linksJson),
      db
        .prepare(
          `INSERT INTO bank_transaction_preferences
        (transaction_id, excluded_from_calculation, created_at, updated_at)
        SELECT json_extract(link.value, '$.matched_transaction_id'), preference.excluded_from_calculation,
          preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN bank_transaction_preferences preference
          ON preference.transaction_id = json_extract(link.value, '$.id')
        WHERE true ON CONFLICT(transaction_id) DO NOTHING`,
        )
        .bind(newLinksJson),
      db
        .prepare(
          `INSERT INTO classification_overrides
        (id, target_type, target_id, category_id, created_at, updated_at)
        SELECT 'override:bank_transaction:' || json_extract(link.value, '$.matched_transaction_id'),
          'bank_transaction', json_extract(link.value, '$.matched_transaction_id'), preference.category_id,
          preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN classification_overrides preference
          ON preference.target_type = 'bank_transaction' AND preference.target_id = json_extract(link.value, '$.id')
        WHERE true ON CONFLICT(target_type, target_id) DO NOTHING`,
        )
        .bind(newLinksJson),
      db
        .prepare(
          `UPDATE invoice_transaction_preferences SET transaction_id = (
        SELECT json_extract(link.value, '$.matched_transaction_id') FROM json_each(?) link
        WHERE json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
      ) WHERE transaction_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM invoice_transaction_preferences existing JOIN json_each(?) link
            ON existing.transaction_id = json_extract(link.value, '$.matched_transaction_id')
          WHERE existing.decision = 'linked' AND json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
        )`,
        )
        .bind(newLinksJson, newLinksJson, newLinksJson),
    ],
  };
}
