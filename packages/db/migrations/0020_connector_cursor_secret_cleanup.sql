-- Connector cursors are intentionally non-sensitive. Session material belongs
-- in encrypted_config and will be refreshed there on the next successful sync.
UPDATE connector_settings
SET sync_cursor = json_remove(
  sync_cursor,
  '$.sessionCookies',
  '$.sessionExpiresAt'
)
WHERE connector_id IN ('esun', 'cathaybk')
  AND sync_cursor IS NOT NULL
  AND json_valid(sync_cursor);

-- Do not remove a legacy TDCC session here. D1 migrations cannot encrypt it,
-- and deleting it would force an otherwise unnecessary device verification.
-- The TDCC connector can still read the legacy cursor once; the next
-- successful sync atomically moves device/session state into encrypted_config
-- and persists only trade watermarks in sync_cursor.
