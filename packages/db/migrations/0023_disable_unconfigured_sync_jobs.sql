-- Before 0004, the initial sync jobs for several connectors were enabled.
-- A fresh installation therefore ran them without credentials and persisted a
-- misleading needs_user_action status. A connector without settings is not
-- eligible for scheduled sync and should not retain a sync result.
UPDATE sync_jobs
SET enabled = 0,
    interval_minutes = COALESCE(
      (SELECT interval_minutes FROM sync_schedule_settings WHERE id = 'default'),
      1440
    ),
    schedule_mode = 'inherit',
    preferred_time = COALESCE(
      (SELECT preferred_time FROM sync_schedule_settings WHERE id = 'default'),
      '06:00'
    ),
    preferred_weekday = COALESCE(
      (SELECT preferred_weekday FROM sync_schedule_settings WHERE id = 'default'),
      1
    ),
    last_run_at = NULL,
    last_success_at = NULL,
    last_status = NULL,
    last_error = NULL,
    locked_until = NULL,
    locked_by = NULL,
    lock_trigger = NULL,
    lock_scope = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1
  FROM connector_settings
  WHERE connector_settings.connector_id = sync_jobs.connector_id
);
