-- 聯邦 New New Bank connector 的 sync job（預設停用，待設定並手動啟用後執行排程）。
INSERT OR IGNORE INTO sync_jobs (
  id, connector_id, scope, enabled, interval_minutes, next_run_at, created_at, updated_at
) VALUES (
  'ubot:all', 'ubot', 'all', 0, 1440,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
