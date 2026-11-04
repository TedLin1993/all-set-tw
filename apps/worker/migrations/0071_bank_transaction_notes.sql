-- 使用者對銀行與信用卡交易的自由文字備註，例如轉帳或扣款的用途。
-- 與 bank_transaction_preferences 分開保存：計算偏好只要有列就代表使用者明確選擇計入或排除，
-- 只寫備註不應改變計算結果。
-- transaction_id 使用 NO ACTION FK；交易合併或授權入帳時，同步流程須先移轉備註再刪除舊交易。
CREATE TABLE bank_transaction_notes (
  transaction_id TEXT NOT NULL PRIMARY KEY REFERENCES bank_transactions (id),
  note TEXT NOT NULL CHECK (length(trim(note)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
