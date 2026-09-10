-- Merge duplicate invoices by invoice number, retaining the v2 UTC identity.
-- Keep the v2 source_id so later v2 syncs update the surviving invoice.
CREATE TABLE _invoice_identity_merge AS
SELECT old.id AS old_id, current.id AS current_id,
       current.source_id AS current_source_id
FROM invoices old
JOIN invoices current
  ON current.id = (
    SELECT candidate.id
    FROM invoices candidate
    WHERE candidate.connector_id = 'einvoice'
      AND candidate.invoice_number = old.invoice_number
    ORDER BY
      (candidate.source_id GLOB candidate.invoice_number || ':????-??-??T??:??:??.???Z') DESC,
      candidate.updated_at DESC,
      candidate.id DESC
    LIMIT 1
  )
WHERE old.connector_id = 'einvoice'
  AND old.invoice_number IS NOT NULL AND old.invoice_number <> ''
  AND old.id <> current.id;

-- Keep the canonical preference when both copies have a decision; otherwise move
-- the old decision to the canonical invoice.
DELETE FROM invoice_transaction_preferences
WHERE invoice_id IN (
  SELECT old_id FROM _invoice_identity_merge
  WHERE EXISTS (SELECT 1 FROM invoice_transaction_preferences WHERE invoice_id = current_id)
);
UPDATE invoice_transaction_preferences
SET invoice_id = (SELECT current_id FROM _invoice_identity_merge WHERE old_id = invoice_id)
WHERE invoice_id IN (SELECT old_id FROM _invoice_identity_merge);

-- Keep existing v2 details; copy missing legacy lines with the v2 identity.
INSERT INTO invoice_line_items (
  id, invoice_id, connector_id, invoice_source_id, source_id,
  line_number, description, quantity, unit_price, amount, raw_payload, created_at, updated_at
)
SELECT 'einvoice:' || m.current_source_id || ':item:' || line.source_id,
       m.current_id, 'einvoice', m.current_source_id, line.source_id,
       line.line_number, line.description, line.quantity, line.unit_price,
       line.amount, line.raw_payload, line.created_at, line.updated_at
FROM invoice_line_items line
JOIN _invoice_identity_merge m ON line.invoice_id = m.old_id
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_line_items existing
  WHERE existing.invoice_id = m.current_id AND existing.source_id = line.source_id
);
DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT old_id FROM _invoice_identity_merge);
DELETE FROM invoices WHERE id IN (SELECT old_id FROM _invoice_identity_merge);
DROP TABLE _invoice_identity_merge;
