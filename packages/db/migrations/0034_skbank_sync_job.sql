INSERT OR IGNORE INTO sync_jobs (
  id, connector_id, scope, enabled, interval_minutes, next_run_at, created_at, updated_at
) VALUES (
  'skbank:all', 'skbank', 'all', 0, 1440,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
