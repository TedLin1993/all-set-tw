-- 交易備註與計算偏好共用 bank_transaction_preferences 的同一列。
-- excluded_from_calculation 改為可為 NULL：NULL 表示使用者沒有選擇計入或排除，
-- 只寫備註的列不會改變預設排除、退款配對等計算結果。
-- SQLite 無法移除既有欄位的 NOT NULL，因此重建資料表，完整保留既有偏好與時間；
-- 有孤兒引用時複製失敗並回滾，不刪除使用者決定。
CREATE TABLE bank_transaction_preferences_new (
  transaction_id TEXT NOT NULL PRIMARY KEY REFERENCES bank_transactions (id),
  excluded_from_calculation INTEGER CHECK (excluded_from_calculation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(trim(note)) > 0)
);

INSERT INTO bank_transaction_preferences_new
  (transaction_id, excluded_from_calculation, created_at, updated_at)
SELECT transaction_id, excluded_from_calculation, created_at, updated_at
FROM bank_transaction_preferences;

DROP TABLE bank_transaction_preferences;
ALTER TABLE bank_transaction_preferences_new RENAME TO bank_transaction_preferences;
CREATE INDEX idx_bank_transaction_preferences_excluded
  ON bank_transaction_preferences (excluded_from_calculation);
