-- 早期以欄位預設值建立的 connector sync job 會保留 06:00，即使已跟隨預設排程。
-- 啟用中的 job 若提早到期，會在預設時間前多開一輪排程批次；先依預設排程重算下一個時段
-- （與 nextSyncRunAt 相同：台北時間、嚴格晚於現在、每週取勾選星期中最近的一天），
-- 再把所有跟隨預設的 job 排程欄位對齊 sync_schedule_settings。
WITH settings AS (
  SELECT
    interval_minutes,
    COALESCE(preferred_weekdays, json_array(preferred_weekday)) AS weekdays,
    datetime(date('now', '+8 hours') || ' ' || preferred_time, '-8 hours') AS today_slot
  FROM sync_schedule_settings
  WHERE id = 'default'
), next_slot AS (
  SELECT
    CASE
      WHEN interval_minutes < 1440
        THEN datetime('now', '+' || interval_minutes || ' minutes')
      WHEN interval_minutes = 10080 THEN (
        SELECT MIN(
          CASE WHEN slot <= datetime('now') THEN datetime(slot, '+7 days') ELSE slot END
        )
        FROM (
          SELECT datetime(
            today_slot,
            '+' || ((CAST(day.value AS INTEGER)
              - CAST(strftime('%w', 'now', '+8 hours') AS INTEGER) + 7) % 7) || ' days'
          ) AS slot
          FROM json_each(weekdays) AS day
        )
      )
      WHEN today_slot <= datetime('now') THEN datetime(today_slot, '+1 day')
      ELSE today_slot
    END AS run_at
  FROM settings
)
UPDATE sync_jobs
SET next_run_at = (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', run_at) FROM next_slot),
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
