-- 純發票活動（未配對到銀行或信用卡交易）的個別計算偏好。
-- 現金消費的發票在提款時已計入支出，使用者可逐筆排除以免重複計算。
-- 發票同步的 upsert 只更新來源欄位，不會覆寫此使用者設定。
ALTER TABLE invoices
  ADD COLUMN excluded_from_calculation INTEGER NOT NULL DEFAULT 0
  CHECK (excluded_from_calculation IN (0, 1));
