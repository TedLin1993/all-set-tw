INSERT OR IGNORE INTO classification_categories
  (id, label, sort_order, is_system, created_at, updated_at) VALUES
  ('software',     '軟體服務', 14, 1, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'),
  ('utilities',    '生活繳費', 15, 1, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'),
  ('other-income', '其他收入', 16, 1, '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z');

UPDATE classification_categories
SET sort_order = 17, updated_at = '2026-09-06T00:00:00.000Z'
WHERE id = 'other' AND is_system = 1 AND sort_order = 14;
