-- 信用卡／貸款的扣款帳戶。
-- 銀行頁面揭露的自動扣繳帳戶只保存銀行代碼、末四碼與可對應的存款 source_id，不保存完整帳號。
-- autopay_status 為 NULL 表示來源未提供；none 表示銀行明確顯示未設定自動扣繳。
ALTER TABLE bank_accounts ADD COLUMN autopay_status TEXT
  CHECK (autopay_status IS NULL OR autopay_status IN ('enabled', 'none'));
ALTER TABLE bank_accounts ADD COLUMN autopay_bank_code TEXT;
ALTER TABLE bank_accounts ADD COLUMN autopay_account_last4 TEXT;
ALTER TABLE bank_accounts ADD COLUMN autopay_account_source_id TEXT;

-- 使用者手動指定的扣款帳戶，優先於銀行提供的資料。
-- payment_account_id 為 NULL 表示使用者明確選擇「不指定」。
-- 與交易偏好不同，兩個帳戶 ID 都不設 FK：帳戶被移除或合併時視為未設定，
-- 不阻擋同步資料清理，也不以 CASCADE 悄悄刪除使用者設定。
CREATE TABLE bank_account_payment_accounts (
  account_id TEXT NOT NULL PRIMARY KEY,
  payment_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
