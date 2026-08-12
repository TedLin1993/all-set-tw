CREATE TABLE IF NOT EXISTS einvoice_sync_runs (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'einvoice'
    CHECK (connector_id = 'einvoice'),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  sync_job_id TEXT REFERENCES sync_jobs(id) ON DELETE SET NULL,
  scheduled_batch_id TEXT REFERENCES scheduled_sync_batches(id) ON DELETE SET NULL,
  settings_version TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'initializing', 'processing', 'completed', 'failed', 'needs_user_action'
  )),
  total_item_count INTEGER NOT NULL DEFAULT 0,
  pending_item_count INTEGER NOT NULL DEFAULT 0,
  processing_item_count INTEGER NOT NULL DEFAULT 0,
  done_item_count INTEGER NOT NULL DEFAULT 0,
  line_item_count INTEGER NOT NULL DEFAULT 0,
  new_invoice_count INTEGER NOT NULL DEFAULT 0,
  session_refresh_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  chunk_lease_owner TEXT,
  chunk_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_einvoice_sync_runs_one_active
  ON einvoice_sync_runs (connector_id)
  WHERE status IN ('queued', 'initializing', 'processing');

CREATE INDEX IF NOT EXISTS idx_einvoice_sync_runs_completed
  ON einvoice_sync_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS einvoice_sync_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES einvoice_sync_runs(id) ON DELETE CASCADE,
  invoice_source_id TEXT NOT NULL,
  header_json TEXT NOT NULL,
  normalized_invoice_json TEXT NOT NULL,
  detail_key TEXT,
  detail_metadata_json TEXT,
  detail_items_json TEXT,
  line_item_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'done')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, invoice_source_id)
);

CREATE INDEX IF NOT EXISTS idx_einvoice_sync_run_items_claim
  ON einvoice_sync_run_items (run_id, status, lease_expires_at, created_at);

-- Detail fetching is now an explicit durable-run operation, not a connector preference.
UPDATE connector_settings
SET public_config = CASE
      WHEN json_remove(public_config, '$.fetchDetails') = '{}' THEN NULL
      ELSE json_remove(public_config, '$.fetchDetails')
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE connector_id = 'einvoice'
  AND public_config IS NOT NULL
  AND json_valid(public_config)
  AND json_type(public_config, '$.fetchDetails') IN ('true', 'false');
