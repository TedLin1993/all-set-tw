export type InvoiceTransactionPreferenceRow = {
  invoiceId: string;
  transactionId: string | null;
  decision: "linked" | "separate";
  createdAt: string;
  updatedAt: string;
};

export type MappingInvoiceRow = {
  id: string;
  invoiceDate: string;
};

export type MappingTransactionRow = {
  id: string;
  postedDate: string | null;
  authorizedAt: string | null;
  amount: number;
  currency: string;
  accountType: string | null;
};

export async function listInvoiceTransactionPreferences(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT
        invoice_id AS invoiceId,
        transaction_id AS transactionId,
        decision,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM invoice_transaction_preferences
      WHERE transaction_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM bank_transactions txn
        WHERE txn.id = transaction_id AND txn.status = 'pending' AND txn.matched_transaction_id IS NOT NULL
      )
      ORDER BY updated_at DESC, invoice_id ASC`,
    )
    .all<InvoiceTransactionPreferenceRow>();
  return rows.results;
}

export async function findMappingInvoice(db: D1Database, invoiceId: string) {
  return db
    .prepare(
      `SELECT id, invoice_date AS invoiceDate
       FROM invoices
       WHERE id = ?`,
    )
    .bind(invoiceId)
    .first<MappingInvoiceRow>();
}

export async function findMappingTransaction(
  db: D1Database,
  transactionId: string,
) {
  return db
    .prepare(
      `SELECT
        bank_tx.id,
        bank_tx.posted_date AS postedDate,
        bank_tx.authorized_at AS authorizedAt,
        bank_tx.amount,
        bank_tx.currency,
        account.account_type AS accountType
      FROM bank_transactions bank_tx
      JOIN bank_accounts account ON account.id = bank_tx.account_id
      WHERE bank_tx.id = ? AND (bank_tx.status <> 'pending' OR bank_tx.matched_transaction_id IS NULL)`,
    )
    .bind(transactionId)
    .first<MappingTransactionRow>();
}

export async function findLinkedInvoiceId(
  db: D1Database,
  transactionId: string,
) {
  const row = await db
    .prepare(
      `SELECT invoice_id AS invoiceId
       FROM invoice_transaction_preferences
       WHERE transaction_id = ? AND decision = 'linked'`,
    )
    .bind(transactionId)
    .first<{ invoiceId: string }>();
  return row?.invoiceId;
}

export async function upsertInvoiceTransactionPreference(
  db: D1Database,
  input: {
    invoiceId: string;
    transactionId: string | null;
    decision: "linked" | "separate";
    now: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO invoice_transaction_preferences
       (invoice_id, transaction_id, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(invoice_id) DO UPDATE SET
         transaction_id = excluded.transaction_id,
         decision = excluded.decision,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.invoiceId,
      input.transactionId,
      input.decision,
      input.now,
      input.now,
    )
    .run();
}
