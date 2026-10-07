import type { SyncWriteRecord } from "../../features/sync/persistence";
import { taishinMerchantNamesMatch, normalizeMerchantName } from "./protocol";

type CardRow = {
  id: string;
  account_id: string;
  source_id: string;
  status: string;
  authorized_at: string | null;
  amount: number;
  currency: string;
  description: string | null;
  raw_payload: string;
  matched_transaction_id: string | null;
};

function cardDetails(row: CardRow) {
  try {
    const raw = JSON.parse(row.raw_payload || "{}") as Record<string, unknown>;
    const last4 =
      typeof raw.cardLast4 === "string" && /^\d{4}$/.test(raw.cardLast4)
        ? raw.cardLast4
        : undefined;
    return {
      last4,
      identityDescription:
        typeof raw.identityDescription === "string"
          ? raw.identityDescription
          : undefined,
    };
  } catch {
    return { last4: undefined, identityDescription: undefined };
  }
}

function samePurchase(left: CardRow, right: CardRow) {
  const a = cardDetails(left);
  const b = cardDetails(right);
  if (
    !a.last4 ||
    a.last4 !== b.last4 ||
    !left.authorized_at ||
    !right.authorized_at ||
    left.account_id !== right.account_id ||
    left.authorized_at.slice(0, 10) !== right.authorized_at.slice(0, 10) ||
    left.currency !== right.currency ||
    left.amount !== right.amount
  )
    return false;
  return [left.description, a.identityDescription].some((name) =>
    [right.description, b.identityDescription].some((other) =>
      taishinMerchantNamesMatch(name ?? undefined, other ?? undefined),
    ),
  );
}

export async function prepareTaishinAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
  encryptedConfig?: string,
) {
  const stored = (
    await db
      .prepare(
        `SELECT id, account_id, source_id, status, authorized_at, amount, currency,
      description, raw_payload, matched_transaction_id FROM bank_transactions
    WHERE connector_id = 'taishin' AND source_id LIKE 'taishin:card:tx:v2:%'`,
      )
      .all<CardRow>()
  ).results;
  const rows = new Map(stored.map((row) => [row.id, row]));
  const incoming = records.filter(
    (record) =>
      record.entityType === "bank_transaction" &&
      String(record.payload.source_id).startsWith("taishin:card:tx:v2:") &&
      record.payload.status === "posted",
  );
  const presentIds = new Set(incoming.map((record) => record.recordKey));
  const unmatchedIncoming = incoming.filter(
    (record) => !rows.has(record.recordKey),
  );
  const unmatchedStored = stored.filter(
    (row) =>
      row.status === "posted" &&
      !presentIds.has(row.id) &&
      row.source_id.split(":").slice(8, -1).join(":") !==
        normalizeMerchantName(row.description ?? undefined),
  );
  const replacements = new Map<string, CardRow>();
  for (const record of incoming) {
    const previous = rows.get(record.recordKey);
    // An authorization already linked to a different posted ID stays pending.
    if (previous?.matched_transaction_id) {
      const target = rows.get(previous.matched_transaction_id);
      if (target?.status === "posted")
        replacements.set(record.recordKey, target);
    }
  }
  for (const record of unmatchedIncoming) {
    const row = record.payload as unknown as CardRow;
    const candidates = unmatchedStored.filter((previous) =>
      samePurchase(row, previous),
    );
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    if (
      unmatchedIncoming.filter((other) =>
        samePurchase(other.payload as unknown as CardRow, target),
      ).length !== 1
    )
      continue;
    // Before this connector queried unbilled details, the in-memory lifecycle
    // merger could borrow a pending merchant's ID. Reuse that saved posted ID
    // when the official posted feed later names the purchase differently.
    replacements.set(record.recordKey, target);
  }
  const updated = new Map<string, SyncWriteRecord>();
  for (const original of records) {
    const target = replacements.get(original.recordKey);
    const record = target
      ? {
          ...original,
          recordKey: target.id,
          payload: {
            ...original.payload,
            id: target.id,
            source_id: target.source_id,
          },
        }
      : original;
    const alreadyPrepared = updated.get(record.recordKey);
    if (
      alreadyPrepared?.payload.status === "posted" &&
      record.payload.status === "pending"
    )
      continue;
    updated.set(record.recordKey, record);
    if (
      record.entityType !== "bank_transaction" ||
      !String(record.payload.source_id).startsWith("taishin:card:tx:v2:")
    )
      continue;
    const row = record.payload as unknown as CardRow;
    const previous = rows.get(row.id);
    rows.set(row.id, {
      ...row,
      status: previous?.status === "posted" ? "posted" : row.status,
      authorized_at:
        (previous?.authorized_at?.length ?? 0) > 10
          ? previous!.authorized_at
          : row.authorized_at,
      matched_transaction_id: previous?.matched_transaction_id ?? null,
    });
  }
  const targeted = new Set(
    [...rows.values()].map((row) => row.matched_transaction_id).filter(Boolean),
  );
  const pending = [...rows.values()].filter(
    (row) => row.status === "pending" && !row.matched_transaction_id,
  );
  const posted = [...rows.values()].filter(
    (row) => row.status === "posted" && !targeted.has(row.id),
  );
  const links: Array<{
    id: string;
    posted: string;
    authorizedAt: string | null;
  }> = [];
  for (const authorization of pending) {
    const candidates = posted.filter((row) => samePurchase(authorization, row));
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    if (pending.filter((row) => samePurchase(row, target)).length !== 1)
      continue;
    links.push({
      id: authorization.id,
      posted: target.id,
      authorizedAt: authorization.authorized_at,
    });
  }
  const json = JSON.stringify(links);
  const guard =
    encryptedConfig == null
      ? ""
      : " AND EXISTS (SELECT 1 FROM connector_settings WHERE connector_id = 'taishin' AND encrypted_config = ?)";
  const statement = (sql: string, ...bindings: string[]) =>
    db
      .prepare(sql.replace("/* settings guard */", guard))
      .bind(...bindings, ...(encryptedConfig == null ? [] : [encryptedConfig]));
  return {
    records: [...updated.values()],
    afterPromoteStatements:
      links.length === 0
        ? []
        : [
            statement(
              `UPDATE bank_transactions SET matched_transaction_id = json_extract(link.value, '$.posted')
        FROM json_each(?) link WHERE bank_transactions.connector_id = 'taishin'
          AND bank_transactions.id = json_extract(link.value, '$.id')
          AND bank_transactions.status = 'pending' AND bank_transactions.matched_transaction_id IS NULL /* settings guard */`,
              json,
            ),
            statement(
              `UPDATE bank_transactions SET authorized_at = json_extract(link.value, '$.authorizedAt')
        FROM json_each(?) link WHERE bank_transactions.connector_id = 'taishin'
          AND bank_transactions.id = json_extract(link.value, '$.posted')
          AND bank_transactions.status = 'posted' AND length(COALESCE(bank_transactions.authorized_at, '')) <= 10
          AND length(COALESCE(json_extract(link.value, '$.authorizedAt'), '')) > 10 /* settings guard */`,
              json,
            ),
            statement(
              `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
        SELECT json_extract(link.value, '$.posted'), preference.excluded_from_calculation, preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN bank_transaction_preferences preference
          ON preference.transaction_id = json_extract(link.value, '$.id')
        WHERE true /* settings guard */ ON CONFLICT(transaction_id) DO NOTHING`,
              json,
            ),
            statement(
              `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
        SELECT 'override:bank_transaction:' || json_extract(link.value, '$.posted'), 'bank_transaction',
          json_extract(link.value, '$.posted'), preference.category_id, preference.created_at, preference.updated_at
        FROM json_each(?) link JOIN classification_overrides preference
          ON preference.target_type = 'bank_transaction' AND preference.target_id = json_extract(link.value, '$.id')
        WHERE true /* settings guard */ ON CONFLICT(target_type, target_id) DO NOTHING`,
              json,
            ),
            statement(
              `UPDATE invoice_transaction_preferences SET transaction_id = (
          SELECT json_extract(link.value, '$.posted') FROM json_each(?) link
          WHERE json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
        ) WHERE transaction_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        AND NOT EXISTS (
          SELECT 1 FROM invoice_transaction_preferences existing JOIN json_each(?) link
            ON existing.transaction_id = json_extract(link.value, '$.posted')
          WHERE existing.decision = 'linked' AND json_extract(link.value, '$.id') = invoice_transaction_preferences.transaction_id
        ) /* settings guard */`,
              json,
              json,
              json,
            ),
          ],
  };
}
