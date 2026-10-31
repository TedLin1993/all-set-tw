-- 早期以欄位預設值建立的 connector sync job 會保留 06:00，即使已跟隨預設排程。
-- 啟用中的 job 若提早到期，會在預設時間前多開一輪排程批次；先將其移到預設排程的下一輪，
-- 再把所有跟隨預設的 job 排程欄位對齊 sync_schedule_settings。
UPDATE sync_jobs
SET next_run_at = (
      SELECT MIN(aligned.next_run_at)
      FROM sync_jobs aligned
      JOIN sync_schedule_settings settings ON settings.id = 'default'
      WHERE aligned.schedule_mode = 'inherit'
        AND aligned.enabled = 1
        AND aligned.interval_minutes = settings.interval_minutes
        AND aligned.preferred_time = settings.preferred_time
        AND COALESCE(aligned.preferred_weekdays, json_array(aligned.preferred_weekday))
          = COALESCE(settings.preferred_weekdays, json_array(settings.preferred_weekday))
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schedule_mode = 'inherit'
  AND enabled = 1
  AND EXISTS (
    SELECT 1
    FROM sync_schedule_settings settings
    WHERE settings.id = 'default'
      AND (
        sync_jobs.interval_minutes != settings.interval_minutes
        OR sync_jobs.preferred_time != settings.preferred_time
        OR COALESCE(sync_jobs.preferred_weekdays, json_array(sync_jobs.preferred_weekday))
          != COALESCE(settings.preferred_weekdays, json_array(settings.preferred_weekday))
      )
  )
  AND EXISTS (
    SELECT 1
    FROM sync_jobs aligned
    JOIN sync_schedule_settings settings ON settings.id = 'default'
    WHERE aligned.schedule_mode = 'inherit'
      AND aligned.enabled = 1
      AND aligned.interval_minutes = settings.interval_minutes
      AND aligned.preferred_time = settings.preferred_time
      AND COALESCE(aligned.preferred_weekdays, json_array(aligned.preferred_weekday))
        = COALESCE(settings.preferred_weekdays, json_array(settings.preferred_weekday))
  );

UPDATE sync_jobs
SET interval_minutes = (SELECT interval_minutes FROM sync_schedule_settings WHERE id = 'default'),
    preferred_time = (SELECT preferred_time FROM sync_schedule_settings WHERE id = 'default'),
    preferred_weekday = (SELECT preferred_weekday FROM sync_schedule_settings WHERE id = 'default'),
    preferred_weekdays = (SELECT preferred_weekdays FROM sync_schedule_settings WHERE id = 'default'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE schedule_mode = 'inherit'
  AND EXISTS (
    SELECT 1
    FROM sync_schedule_settings settings
    WHERE settings.id = 'default'
      AND (
        sync_jobs.interval_minutes != settings.interval_minutes
        OR sync_jobs.preferred_time != settings.preferred_time
        OR COALESCE(sync_jobs.preferred_weekdays, json_array(sync_jobs.preferred_weekday))
          != COALESCE(settings.preferred_weekdays, json_array(settings.preferred_weekday))
      )
  );
