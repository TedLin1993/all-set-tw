-- 推播偏好：預設排程同步摘要是否附上近期繳款提醒，預設開啟。
ALTER TABLE notification_preferences
  ADD COLUMN notify_payment_due INTEGER NOT NULL DEFAULT 1;
