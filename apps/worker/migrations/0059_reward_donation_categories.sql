-- 新增「捐款」與「回饋」系統分類，以及可確定分類的系統規則。

-- 預設排序：生活繳費 15、捐款 16、其他收入 17、回饋 18、未分類 19；只調整仍為預設值的分類。
UPDATE classification_categories
SET sort_order = 17, updated_at = '2026-10-15T00:00:00.000Z'
WHERE id = 'other-income' AND is_system = 1 AND sort_order = 16;

UPDATE classification_categories
SET sort_order = 19, updated_at = '2026-10-15T00:00:00.000Z'
WHERE id = 'other' AND is_system = 1 AND sort_order = 17;

-- 捐款：既有同名自訂分類併入系統分類，保留其分類覆寫與規則。
UPDATE classification_categories
SET label = '捐款（併入系統分類）', updated_at = '2026-10-15T00:00:00.000Z'
WHERE label = '捐款' COLLATE NOCASE AND id <> 'donation';

INSERT OR IGNORE INTO classification_categories
  (id, label, sort_order, is_system, created_at, updated_at)
VALUES ('donation', '捐款', 16, 1, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z');

UPDATE classification_overrides
SET category_id = 'donation', updated_at = '2026-10-15T00:00:00.000Z'
WHERE category_id IN (
  SELECT id FROM classification_categories WHERE label = '捐款（併入系統分類）'
);

UPDATE classification_rules
SET category_id = 'donation'
WHERE category_id IN (
  SELECT id FROM classification_categories WHERE label = '捐款（併入系統分類）'
);

DELETE FROM classification_categories WHERE label = '捐款（併入系統分類）';

-- 回饋：既有同名自訂分類併入系統分類，保留其分類覆寫與規則。
UPDATE classification_categories
SET label = '回饋（併入系統分類）', updated_at = '2026-10-15T00:00:00.000Z'
WHERE label = '回饋' COLLATE NOCASE AND id <> 'reward';

INSERT OR IGNORE INTO classification_categories
  (id, label, sort_order, is_system, created_at, updated_at)
VALUES ('reward', '回饋', 18, 1, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z');

UPDATE classification_overrides
SET category_id = 'reward', updated_at = '2026-10-15T00:00:00.000Z'
WHERE category_id IN (
  SELECT id FROM classification_categories WHERE label = '回饋（併入系統分類）'
);

UPDATE classification_rules
SET category_id = 'reward'
WHERE category_id IN (
  SELECT id FROM classification_categories WHERE label = '回饋（併入系統分類）'
);

DELETE FROM classification_categories WHERE label = '回饋（併入系統分類）';

INSERT OR IGNORE INTO classification_rules
  (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at, excluded_from_calculation) VALUES
  ('system:bank:reward-keywords',         'reward',   'bank_transaction', 'description', 'regex', '消費折抵|紅利折抵|點數折抵|回饋|年費減免|\bcash\s?back\b', 109, 1, 1, 'system', '信用卡回饋、消費折抵與年費減免', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 0),
  ('system:bank:card-payment-received',   'transfer', 'bank_transaction', 'description', 'regex', '自扣已入帳|繳款入帳|\bpayment\s+received\b', 107, 1, 1, 'system', '信用卡繳款入帳', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 1),
  ('system:bank:e-wallet-transfer',       'transfer', 'bank_transaction', 'description', 'regex', '(?:一卡通|ipass|全支付|街口|悠遊付|icash\s?pay|line\s?pay\s?money).*(?:儲值|加值|提領)|(?:儲值|加值|提領).*(?:一卡通|ipass|全支付|街口|悠遊付|icash\s?pay|line\s?pay\s?money)', 107, 1, 1, 'system', '電子支付儲值、加值與提領', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 0),
  ('system:bank:food-delivery',           'food',     'bank_transaction', 'description', 'regex', '\buber\s*\*?\s*eats\b', 101, 1, 1, 'system', 'Uber Eats 外送（優先於交通規則的 uber 關鍵字）', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 0),
  ('system:bank:convenience-store',       'shopping', 'bank_transaction', 'description', 'regex', '超商|超市|7-?eleven|全家便利|familymart|萊爾富|hi-?life|ok\s?mart|美廉社|全聯|家樂福|carrefour|大潤發|愛買|好市多|costco|supermarket', 102, 1, 1, 'system', '超商、超市與量販店（不論購買品項）', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 0),
  ('system:bank:donation-keywords',       'donation', 'bank_transaction', 'description', 'regex', '捐款|捐贈|政治獻金', 100, 1, 1, 'system', '捐款與政治獻金', '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 0);

