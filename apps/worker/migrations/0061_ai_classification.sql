-- AI 自動分類：單列設定與掃描進度，以及每筆交易的 AI 判斷結果。

CREATE TABLE ai_classification_settings (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enabled_at TEXT,
  scan_mode TEXT CHECK (scan_mode IS NULL OR scan_mode IN ('recent', 'backfill')),
  scan_id TEXT,
  scan_month TEXT,
  scan_stop_month TEXT,
  scan_watermark TEXT,
  scanned_watermark TEXT,
  backfill_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (backfill_status IN ('idle', 'running', 'completed')),
  backfill_classified_count INTEGER NOT NULL DEFAULT 0,
  backfill_undetermined_count INTEGER NOT NULL DEFAULT 0,
  backfill_started_at TEXT,
  backfill_completed_at TEXT,
  quota_day TEXT,
  quota_used INTEGER NOT NULL DEFAULT 0,
  paused_until TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO ai_classification_settings (id, enabled, updated_at)
VALUES ('default', 0, '2026-10-18T00:00:00.000Z');

-- Like classification_overrides, rows reference transactions by id without a
-- foreign key, so transaction merges and staging promotion are unaffected.
CREATE TABLE ai_classifications (
  transaction_id TEXT NOT NULL PRIMARY KEY,
  category_id TEXT REFERENCES classification_categories (id),
  probability REAL NOT NULL,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_ai_classifications_category
  ON ai_classifications (category_id);

