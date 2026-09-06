-- Reuse authorized_at for source-provided transaction time. Never rewrite
-- source_id/posted_date: historical connector identities contain their old values.
-- Raw payloads are consulted only for this one-time, source-specific recovery.

UPDATE bank_transactions
SET authorized_at = substr(authorized_at, 1, 10)
WHERE connector_id = 'esun'
  AND authorized_at LIKE '%T00:00:00.000Z'
  AND (json_type(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
                 '$.consumerDt') = 'text'
    OR json_type(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
                 '$.postingDt') = 'text');

-- E.SUN deposits previously labelled Taiwan local clock values as UTC.
WITH source AS (
  SELECT id, substr(posted_date, 1, 10) AS day,
    trim(CAST(json_extract(raw_payload, '$.txTime') AS TEXT)) AS clock
  FROM bank_transactions
  WHERE connector_id = 'esun' AND authorized_at IS NULL
    AND json_type(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
                  '$.txDate') = 'text'
), recovered AS (
  SELECT id, CASE
    WHEN (clock GLOB '[0-2][0-9]:[0-5][0-9]' OR
          clock GLOB '[0-2][0-9]:[0-5][0-9]:[0-5][0-9]')
      AND substr(clock, 1, 2) < '24'
    THEN day || 'T' || clock || CASE WHEN length(clock) = 5 THEN ':00' ELSE '' END || '+08:00'
    ELSE day END AS authorized_at
  FROM source WHERE date(day, '+0 days') = day
)
UPDATE bank_transactions
SET authorized_at = recovered.authorized_at
FROM recovered WHERE bank_transactions.id = recovered.id;

-- These sources kept the original full timestamp in a known raw field.
WITH source AS (
  SELECT id, replace(replace(trim(CAST(CASE connector_id
      WHEN 'cathaybk' THEN COALESCE(json_extract(raw_payload, '$.txnDateTime'),
                                  json_extract(raw_payload, '$.accountDate'),
                                  json_extract(raw_payload, '$.consumeDate'))
      WHEN 'ctbc' THEN json_extract(raw_payload, '$.txnDateTime')
      WHEN 'tdcc' THEN json_extract(raw_payload, '$.occurredAt')
    END AS TEXT)), '/', '-'), ' ', 'T') AS value
  FROM bank_transactions
  WHERE connector_id IN ('cathaybk', 'ctbc', 'tdcc')
    AND (authorized_at IS NULL OR length(authorized_at) = 10)
    AND json_valid(raw_payload)
), recovered AS (
  SELECT id, CASE
    WHEN value = '1970-01-01T00:00:00' THEN '1970-01-01'
    WHEN length(value) = 10 AND date(value, '+0 days') = value THEN value
    WHEN value GLOB '????-??-??T[0-2][0-9]:[0-5][0-9]*'
      AND substr(value, 12, 2) < '24'
      AND date(substr(value, 1, 10), '+0 days') = substr(value, 1, 10)
      AND datetime(value) IS NOT NULL
    THEN CASE WHEN length(value) IN (16, 19, 23) AND value NOT LIKE '%Z'
      THEN value || '+08:00' ELSE value END
    ELSE NULL END AS authorized_at
  FROM source
)
UPDATE bank_transactions
SET authorized_at = recovered.authorized_at
FROM recovered
WHERE bank_transactions.id = recovered.id AND recovered.authorized_at IS NOT NULL;

-- First Bank preserved local transaction clocks without an offset.
UPDATE bank_transactions
SET authorized_at = authorized_at || '+08:00'
WHERE connector_id = 'firstbank' AND length(authorized_at) = 19
  AND authorized_at GLOB '????-??-??T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]'
  AND substr(authorized_at, 12, 2) < '24'
  AND date(substr(authorized_at, 1, 10), '+0 days') = substr(authorized_at, 1, 10)
  AND datetime(authorized_at) IS NOT NULL;

-- Legacy v2 invoice raw headers lost both source precision and timezone:
-- local clock strings and epoch timestamps were normalized in the same field.
-- Keep only the Taipei date until a sync supplies the original date shape.
-- New headers include invoice.invoiceDate and must retain genuine midnight.
UPDATE invoices
SET invoice_date = date(invoice_date, '+8 hours')
WHERE connector_id = 'einvoice'
  AND json_type(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
                '$.invoice') = 'object'
  AND json_extract(CASE WHEN json_valid(raw_payload) THEN raw_payload ELSE '{}' END,
                   '$.invoice.invoiceDate') IS NULL
  AND date(invoice_date, '+8 hours') IS NOT NULL
  AND length(invoice_date) > 10;
