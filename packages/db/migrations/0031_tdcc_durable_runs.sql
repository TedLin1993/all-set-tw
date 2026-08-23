-- TDCC can return one page per bank or investment account.  Keep the
-- provider work durable so a Queue delivery only has to process a bounded
-- number of pages and can safely resume after a retry.
CREATE TABLE IF NOT EXISTS tdcc_sync_runs (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL DEFAULT 'tdcc'
    CHECK (connector_id = 'tdcc'),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  scope TEXT NOT NULL DEFAULT 'all'
    CHECK (scope IN ('all', 'investments', 'bank', 'trades')),
  sync_job_id TEXT REFERENCES sync_jobs(id) ON DELETE SET NULL,
  scheduled_batch_id TEXT REFERENCES scheduled_sync_batches(id) ON DELETE SET NULL,
  settings_version TEXT,
  phase TEXT NOT NULL DEFAULT 'initialize'
    CHECK (phase IN (
      'initialize', 'snapshot', 'positions', 'bank', 'investments',
      'trades', 'promote', 'finalize'
    )),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'initializing', 'processing', 'promoting',
    'completed', 'failed', 'needs_user_action'
  )),
  -- The run retains the encrypted provider state it was initialized with.
  -- It is never exposed in an API response or log.
  encrypted_config TEXT,
  encrypted_session TEXT,
  session_json TEXT CHECK (session_json IS NULL OR json_valid(session_json)),
  total_item_count INTEGER NOT NULL DEFAULT 0,
  pending_item_count INTEGER NOT NULL DEFAULT 0,
  processing_item_count INTEGER NOT NULL DEFAULT 0,
  done_item_count INTEGER NOT NULL DEFAULT 0,
  failed_item_count INTEGER NOT NULL DEFAULT 0,
  session_refresh_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  promoted_at TEXT,
  completed_at TEXT
);

-- TDCC scopes share one connector session/cursor.  Only one active run may
-- exist at a time, including when a partial manual scope races tdcc:all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tdcc_sync_runs_one_active
  ON tdcc_sync_runs (connector_id)
  WHERE status IN ('queued', 'initializing', 'processing', 'promoting');

CREATE INDEX IF NOT EXISTS idx_tdcc_sync_runs_completed
  ON tdcc_sync_runs (completed_at DESC);

CREATE TABLE IF NOT EXISTS tdcc_sync_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES tdcc_sync_runs(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  task_key TEXT NOT NULL DEFAULT '',
  account_id TEXT,
  page_cursor TEXT NOT NULL DEFAULT '',
  next_page_cursor TEXT,
  page_number INTEGER NOT NULL DEFAULT 0,
  task_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(task_json)),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (run_id, task_type, task_key, page_cursor)
);

CREATE INDEX IF NOT EXISTS idx_tdcc_sync_run_items_claim
  ON tdcc_sync_run_items (run_id, status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_tdcc_sync_run_items_account
  ON tdcc_sync_run_items (run_id, account_id, task_type, page_number);
