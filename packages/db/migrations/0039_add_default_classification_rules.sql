INSERT OR IGNORE INTO classification_rules
  (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at)
SELECT 'system:bank:software-keywords', id, 'bank_transaction', 'description', 'regex',
  '^(?!.*(?:手續費|交易服務費|\bforeign\s+transaction\s+fee\b)).*(?:\b(?:openai|cursor|cloudflare)(?:\b|o[0-9])|\bchatgpt\b|\banthropic\b|\bclaude(?:\.ai|\s+(?:pro|max|subscription))\b|\bgoogle\s*[* ]\s*(?:cloud|one|workspace)\b|\b(?:github|jetbrains|adobe|notion|dropbox)(?:\b|o[0-9])|\b(?:microsoft|office)\s*365\b|\bicloud\b)',
  108, 1, 1, 'system', '軟體服務商家與產品名稱', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
FROM classification_categories
WHERE label = '軟體服務' COLLATE NOCASE;

INSERT OR IGNORE INTO classification_rules
  (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at)
SELECT 'system:bank:utilities-keywords', id, 'bank_transaction', 'description', 'regex',
  '^(?!.*(?:手續費|交易服務費|購機|手機|設備|門市|商城|購物)).*(?:中華電信|遠傳電信|台灣大哥大|台灣之星|亞太電信|台灣電力|台灣自來水|臺北自來水|台北自來水|台電|台水|水費|電費|瓦斯費|天然氣費|電信費|電話費|網路費|寬頻費|\bhinet\b)',
  108, 1, 1, 'system', '電信、水電、瓦斯與網路費用', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
FROM classification_categories
WHERE label = '生活繳費' COLLATE NOCASE;

INSERT OR IGNORE INTO classification_rules
  (id, category_id, target_type, field, operator, pattern, priority, enabled, is_system, source, description, created_at, updated_at)
SELECT 'system:bank:other-income-keywords', id, 'bank_transaction', 'description', 'regex',
  '^(?!.*(?:退刷|退款|退貨|折抵|利息調整|利息退還|貸款|借款|融資|循環利息|手續費)).*(?:^利息$|利息存入|存款利息|活存利息|定存利息|股息|股利|配息|現金回饋|回饋金|現金回存|租金補貼|租屋補助|育兒津貼|生育補助|政府補助|稿費|稿酬|接案收入|退稅|^interest$|\binterest\s+(?:credit|income)\b|\bdividends?\b|\bcashback\b)',
  108, 1, 1, 'system', '正金額的利息、股利、補助、稿費、退稅與現金回饋', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
FROM classification_categories
WHERE label = '其他收入' COLLATE NOCASE;
