-- 手動記錄使用的虛擬帳戶旗標：is_manual = 1 的帳戶沒有餘額、不同步、不參與自動配對。
ALTER TABLE bank_accounts
ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1));

-- 「現金與其他」虛擬帳戶；全新資料庫建立此列，已存在同 id 的列只補上旗標。
INSERT INTO bank_accounts (
  id, connector_id, source_id, institution_name, account_name, account_type,
  currency, created_at, updated_at, is_manual
) VALUES (
  'manual:cash', 'manual', 'manual:cash', '手動記錄', '現金與其他', 'unknown',
  'TWD', '2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z', 1
)
ON CONFLICT (id) DO UPDATE SET is_manual = 1;
