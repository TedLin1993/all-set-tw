export type SyncEntityType =
  | "invoice"
  | "invoice_line_item"
  | "bank_account"
  | "bank_balance_snapshot"
  | "bank_transaction"
  | "credit_card_bill"
  | "investment_position"
  | "investment_transaction"
  | "net_worth_history";

export type SyncWriteRecord = {
  entityType: SyncEntityType;
  recordKey: string;
  payload: Record<string, unknown>;
};

type EntityConfig = {
  table: string;
  columns: string[];
  conflictColumns: string[];
  updateColumns: string[];
};

const ENTITY_ORDER: SyncEntityType[] = [
  "invoice",
  "invoice_line_item",
  "bank_account",
  "bank_balance_snapshot",
  "bank_transaction",
  "credit_card_bill",
  "investment_position",
  "investment_transaction",
  "net_worth_history",
];

const ENTITY_CONFIG: Record<SyncEntityType, EntityConfig> = {
  invoice: {
    table: "invoices",
    columns: [
      "id",
      "connector_id",
      "source_id",
      "invoice_number",
      "invoice_date",
      "seller_name",
      "amount",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "source_id"],
    updateColumns: [
      "invoice_number",
      "invoice_date",
      "seller_name",
      "amount",
      "raw_payload",
      "updated_at",
    ],
  },
  invoice_line_item: {
    table: "invoice_line_items",
    columns: [
      "id",
      "invoice_id",
      "connector_id",
      "invoice_source_id",
      "source_id",
      "line_number",
      "description",
      "quantity",
      "unit_price",
      "amount",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "invoice_source_id", "source_id"],
    updateColumns: [
      "invoice_id",
      "line_number",
      "description",
      "quantity",
      "unit_price",
      "amount",
      "raw_payload",
      "updated_at",
    ],
  },
  bank_account: {
    table: "bank_accounts",
    columns: [
      "id",
      "connector_id",
      "source_id",
      "institution_name",
      "account_name",
      "account_type",
      "currency",
      "credit_limit",
      "bank_code",
      "account_last4",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "source_id"],
    updateColumns: [
      "institution_name",
      "account_name",
      "account_type",
      "currency",
      "credit_limit",
      "bank_code",
      "account_last4",
      "raw_payload",
      "updated_at",
    ],
  },
  bank_balance_snapshot: {
    table: "bank_balance_snapshots",
    columns: [
      "id",
      "connector_id",
      "account_id",
      "source_id",
      "balance",
      "available_balance",
      "statement_balance",
      "payment_due_date",
      "statement_closing_date",
      "no_payment_needed",
      "currency",
      "as_of_at",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "account_id", "source_id"],
    updateColumns: [
      "balance",
      "available_balance",
      "statement_balance",
      "payment_due_date",
      "statement_closing_date",
      "no_payment_needed",
      "currency",
      "as_of_at",
      "raw_payload",
      "updated_at",
    ],
  },
  bank_transaction: {
    table: "bank_transactions",
    columns: [
      "id",
      "connector_id",
      "account_id",
      "source_id",
      "posted_date",
      "authorized_at",
      "amount",
      "currency",
      "description",
      "counterparty",
      "status",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "account_id", "source_id"],
    updateColumns: [
      "posted_date",
      "authorized_at",
      "amount",
      "currency",
      "description",
      "counterparty",
      "status",
      "raw_payload",
      "updated_at",
    ],
  },
  credit_card_bill: {
    table: "credit_card_bills",
    columns: [
      "id",
      "connector_id",
      "account_id",
      "source_id",
      "billing_period",
      "statement_amount",
      "minimum_payment",
      "paid_amount",
      "is_paid",
      "payment_due_date",
      "statement_closing_date",
      "currency",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "account_id", "billing_period"],
    updateColumns: [
      "source_id",
      "statement_amount",
      "minimum_payment",
      "paid_amount",
      "is_paid",
      "payment_due_date",
      "statement_closing_date",
      "currency",
      "raw_payload",
      "updated_at",
    ],
  },
  investment_position: {
    table: "investment_positions",
    columns: [
      "id",
      "connector_id",
      "source_id",
      "asset_type",
      "symbol",
      "name",
      "quantity",
      "market_value",
      "cash_balance",
      "currency",
      "as_of_date",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "source_id", "as_of_date"],
    updateColumns: [
      "asset_type",
      "symbol",
      "name",
      "quantity",
      "market_value",
      "cash_balance",
      "currency",
      "raw_payload",
      "updated_at",
    ],
  },
  investment_transaction: {
    table: "investment_transactions",
    columns: [
      "id",
      "connector_id",
      "account_id",
      "source_id",
      "broker_no",
      "broker_account",
      "broker_name",
      "symbol",
      "name",
      "asset_type",
      "trade_date",
      "posted_date",
      "transaction_code",
      "transaction_name",
      "quantity",
      "price",
      "amount",
      "currency",
      "raw_payload",
      "created_at",
      "updated_at",
    ],
    conflictColumns: ["connector_id", "account_id", "source_id"],
    updateColumns: [
      "broker_no",
      "broker_account",
      "broker_name",
      "symbol",
      "name",
      "asset_type",
      "trade_date",
      "posted_date",
      "transaction_code",
      "transaction_name",
      "quantity",
      "price",
      "amount",
      "currency",
      "raw_payload",
      "updated_at",
    ],
  },
  net_worth_history: {
    table: "net_worth_history",
    columns: [
      "id",
      "date",
      "net_worth",
      "asset_type",
      "source",
      "snapshotted_at",
    ],
    conflictColumns: ["source", "asset_type", "date"],
    updateColumns: ["net_worth", "snapshotted_at"],
  },
};

const STAGING_CHUNK_SIZE = 100;
const STAGING_RETENTION_MS = 24 * 60 * 60 * 1_000;

export async function persistStagedSyncWrite(
  db: D1Database,
  input: {
    records: SyncWriteRecord[];
    beforePromoteStatements?: D1PreparedStatement[];
    afterPromoteStatements?: D1PreparedStatement[];
    finalizeStatements?: D1PreparedStatement[];
  },
) {
  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .prepare("DELETE FROM sync_write_staging WHERE created_at < ?")
    .bind(new Date(Date.now() - STAGING_RETENTION_MS).toISOString())
    .run();

  try {
    for (
      let offset = 0;
      offset < input.records.length;
      offset += STAGING_CHUNK_SIZE
    ) {
      const chunk = input.records.slice(offset, offset + STAGING_CHUNK_SIZE);
      await db
        .prepare(
          `INSERT INTO sync_write_staging (run_id, entity_type, record_key, payload, created_at)
         SELECT
           ?1,
           json_extract(value, '$.entityType'),
           json_extract(value, '$.recordKey'),
           json_extract(value, '$.payload'),
           ?2
         FROM json_each(?3)
         WHERE 1
         ON CONFLICT(run_id, entity_type, record_key) DO UPDATE SET
           payload = excluded.payload,
           created_at = excluded.created_at`,
        )
        .bind(runId, createdAt, JSON.stringify(chunk))
        .run();
    }

    const entityTypes = new Set(
      input.records.map((record) => record.entityType),
    );
    await db.batch([
      ...(input.beforePromoteStatements ?? []),
      ...ENTITY_ORDER.filter((entityType) => entityTypes.has(entityType)).map(
        (entityType) => promotionStatement(db, runId, entityType),
      ),
      ...(input.afterPromoteStatements ?? []),
      ...(input.finalizeStatements ?? []),
      db.prepare("DELETE FROM sync_write_staging WHERE run_id = ?").bind(runId),
    ]);
  } catch (error) {
    await db
      .prepare("DELETE FROM sync_write_staging WHERE run_id = ?")
      .bind(runId)
      .run()
      .catch(() => undefined);
    throw error;
  }
}

function promotionStatement(
  db: D1Database,
  runId: string,
  entityType: SyncEntityType,
) {
  const config = ENTITY_CONFIG[entityType];
  const columns = config.columns.join(", ");
  const values = config.columns
    .map((column) => `json_extract(payload, '$.${column}')`)
    .join(", ");
  const updates = config.updateColumns
    .map((column) => {
      if (entityType === "credit_card_bill") {
        if (column === "paid_amount")
          return "paid_amount = COALESCE(excluded.paid_amount, credit_card_bills.paid_amount)";
        if (column === "is_paid")
          return `is_paid = CASE
            WHEN credit_card_bills.is_paid = 1 OR excluded.is_paid = 1 THEN 1
            ELSE COALESCE(excluded.is_paid, credit_card_bills.is_paid)
          END`;
      }
      if (entityType !== "bank_transaction")
        return `${column} = excluded.${column}`;
      if (column === "status")
        return "status = CASE WHEN bank_transactions.status = 'posted' OR excluded.status = 'posted' THEN 'posted' ELSE 'pending' END";
      if (column === "authorized_at")
        return `authorized_at = CASE
          WHEN bank_transactions.status = 'pending' AND excluded.status = 'posted'
            THEN COALESCE(bank_transactions.authorized_at, excluded.authorized_at)
          WHEN bank_transactions.status = 'posted' AND excluded.status = 'pending'
            THEN bank_transactions.authorized_at
          ELSE excluded.authorized_at
        END`;
      return `${column} = CASE WHEN bank_transactions.status = 'posted' AND excluded.status = 'pending' THEN bank_transactions.${column} ELSE excluded.${column} END`;
    })
    .join(", ");

  return db
    .prepare(
      `INSERT INTO ${config.table} (${columns})
     SELECT ${values}
     FROM sync_write_staging
     WHERE run_id = ? AND entity_type = ?
     ON CONFLICT(${config.conflictColumns.join(", ")}) DO UPDATE SET ${updates}`,
    )
    .bind(runId, entityType);
}
