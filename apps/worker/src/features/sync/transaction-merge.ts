/** Internal SQL supplied by the bank-specific matchers, never user input.
 * Execute the returned statements together in the promotion batch.
 */
export function mergeLegacyTransactionStatements(
  db: D1Database,
  candidatesSql: string,
): D1PreparedStatement[] {
  // Re-evaluate the same mapping inside the transaction. Copying equal preferences
  // and moving invoice references cannot turn an excluded conflict into a match.
  // Parent rows remain intact until the final statement, keeping cardinality stable.
  const mapping = `WITH candidates AS (${candidatesSql}),
    counted AS (
      SELECT old_id, new_id,
        COUNT(*) OVER (PARTITION BY old_id) AS old_count,
        COUNT(*) OVER (PARTITION BY new_id) AS new_count
      FROM candidates
    ), merges AS (
      SELECT c.old_id, c.new_id FROM counted c
      LEFT JOIN bank_transaction_preferences old_pref ON old_pref.transaction_id = c.old_id
      LEFT JOIN bank_transaction_preferences new_pref ON new_pref.transaction_id = c.new_id
      LEFT JOIN classification_overrides old_category
        ON old_category.target_type = 'bank_transaction' AND old_category.target_id = c.old_id
      LEFT JOIN classification_overrides new_category
        ON new_category.target_type = 'bank_transaction' AND new_category.target_id = c.new_id
      LEFT JOIN invoice_transaction_preferences old_invoice
        ON old_invoice.transaction_id = c.old_id AND old_invoice.decision = 'linked'
      LEFT JOIN invoice_transaction_preferences new_invoice
        ON new_invoice.transaction_id = c.new_id AND new_invoice.decision = 'linked'
      WHERE c.old_count = 1 AND c.new_count = 1 AND c.old_id <> c.new_id
        AND (old_pref.transaction_id IS NULL OR new_pref.transaction_id IS NULL
          OR old_pref.excluded_from_calculation = new_pref.excluded_from_calculation)
        AND (old_category.id IS NULL OR new_category.id IS NULL
          OR old_category.category_id = new_category.category_id)
        AND (old_invoice.invoice_id IS NULL OR new_invoice.invoice_id IS NULL)
    )`;
  return [
    `INSERT INTO bank_transaction_preferences
      (transaction_id, excluded_from_calculation, created_at, updated_at)
      SELECT m.new_id, p.excluded_from_calculation, p.created_at, p.updated_at
      FROM merges m JOIN bank_transaction_preferences p ON p.transaction_id = m.old_id
      WHERE true ON CONFLICT(transaction_id) DO NOTHING`,
    `INSERT INTO classification_overrides
      (id, target_type, target_id, category_id, created_at, updated_at)
      SELECT 'override:bank_transaction:' || m.new_id, 'bank_transaction', m.new_id,
        p.category_id, p.created_at, p.updated_at
      FROM merges m JOIN classification_overrides p
        ON p.target_type = 'bank_transaction' AND p.target_id = m.old_id
      WHERE true ON CONFLICT(target_type, target_id) DO NOTHING`,
    // Notes never block a merge; differing notes on both sides are kept together.
    `INSERT INTO bank_transaction_notes (transaction_id, note, created_at, updated_at)
      SELECT m.new_id, n.note, n.created_at, n.updated_at
      FROM merges m JOIN bank_transaction_notes n ON n.transaction_id = m.old_id
      WHERE true ON CONFLICT(transaction_id) DO UPDATE SET
        note = bank_transaction_notes.note || char(10) || excluded.note,
        updated_at = max(bank_transaction_notes.updated_at, excluded.updated_at)
      WHERE instr(bank_transaction_notes.note, excluded.note) = 0`,
    `UPDATE invoice_transaction_preferences
      SET transaction_id = m.new_id FROM merges m WHERE transaction_id = m.old_id`,
    `UPDATE bank_transactions SET
      transfer_peer_id = COALESCE((SELECT new_id FROM merges WHERE old_id = transfer_peer_id), transfer_peer_id),
      matched_transaction_id = COALESCE((SELECT new_id FROM merges WHERE old_id = matched_transaction_id), matched_transaction_id)
      WHERE transfer_peer_id IN (SELECT old_id FROM merges)
        OR matched_transaction_id IN (SELECT old_id FROM merges)`,
    `DELETE FROM bank_transaction_preferences WHERE transaction_id IN (SELECT old_id FROM merges)`,
    `DELETE FROM classification_overrides
      WHERE target_type = 'bank_transaction' AND target_id IN (SELECT old_id FROM merges)`,
    `DELETE FROM bank_transaction_notes WHERE transaction_id IN (SELECT old_id FROM merges)`,
    `DELETE FROM bank_transactions WHERE id IN (SELECT old_id FROM merges)`,
  ].map((statement) => db.prepare(`${mapping} ${statement}`));
}
