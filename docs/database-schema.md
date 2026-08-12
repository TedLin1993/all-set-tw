# Database Schema

> 此文件由 `npm run db:schema:docs` 自動產生，請勿直接編輯。
>
> Schema 來源是套用 `packages/db/migrations/*.sql` 後的隔離 local D1；不包含任何正式環境資料。
> Wrangler 管理的 `d1_migrations` metadata table 刻意省略。
> Table 與欄位的業務語意來自 `packages/db/schema-metadata.json`。

## 目錄

- Tables：24
- Explicit indexes：32
- Other objects：0
- Migrations：25

## Tables

| Table | 用途 | Columns | Foreign keys | Indexes |
| --- | --- | ---: | ---: | ---: |
| [`bank_accounts`](#bank_accounts) | 各銀行與信用卡連接器同步回來的帳戶主檔；同一個實體帳戶可能同時存在多個來源記錄。 | 14 | 1 | 1 |
| [`bank_balance_snapshots`](#bank_balance_snapshots) | 帳戶在特定時間點的餘額快照，供資產總值與歷史圖表計算。 | 15 | 1 | 2 |
| [`bank_transaction_preferences`](#bank_transaction_preferences) | 使用者對銀行交易計算方式的個別偏好。 | 4 | 0 | 1 |
| [`bank_transactions`](#bank_transactions) | 銀行帳戶、信用卡與其他存款型連接器同步回來的交易明細。 | 15 | 1 | 4 |
| [`classification_categories`](#classification_categories) | 交易與發票使用的分類字典，包含系統預設分類與使用者分類。 | 6 | 0 | 1 |
| [`classification_overrides`](#classification_overrides) | 使用者對單筆目標資料指定的分類覆寫。 | 6 | 1 | 1 |
| [`classification_rules`](#classification_rules) | 以文字條件自動判斷交易或其他資料分類的規則。 | 14 | 1 | 2 |
| [`connector_settings`](#connector_settings) | 每個外部金融資料連接器的認證設定、公開設定與同步游標。 | 7 | 0 | 0 |
| [`credit_card_bills`](#credit_card_bills) | 信用卡依帳單週期整理的帳單主檔。 | 15 | 1 | 2 |
| [`exchange_rates`](#exchange_rates) | 將外幣換算為新台幣時使用的最新匯率。 | 3 | 0 | 0 |
| [`investment_positions`](#investment_positions) | 投資帳戶在特定日期的持倉與資產市值快照。 | 14 | 0 | 4 |
| [`investment_transactions`](#investment_transactions) | 投資帳戶的買賣、配息或其他證券交易明細。 | 22 | 0 | 3 |
| [`invoice_line_items`](#invoice_line_items) | 電子發票底下的商品或服務明細。 | 13 | 1 | 2 |
| [`invoice_transaction_preferences`](#invoice_transaction_preferences) | 使用者對電子發票與銀行交易是否關聯的決策。 | 5 | 0 | 1 |
| [`invoices`](#invoices) | 電子發票的抬頭與總額主檔。 | 10 | 0 | 2 |
| [`manual_assets`](#manual_assets) | 使用者手動登錄、無法由銀行或投資連接器同步的資產。 | 6 | 0 | 0 |
| [`net_worth_history`](#net_worth_history) | 按日期保存的淨資產或資產類別歷史數值，用於圖表與歷史查詢。 | 6 | 0 | 2 |
| [`notification_preferences`](#notification_preferences) | 此單一部署的同步推播偏好設定。 | 5 | 0 | 0 |
| [`push_subscriptions`](#push_subscriptions) | 瀏覽器 Web Push 裝置訂閱資料。 | 6 | 0 | 0 |
| [`scheduled_sync_batch_results`](#scheduled_sync_batch_results) | 預設排程同步批次中各工作的完成結果。 | 8 | 1 | 0 |
| [`scheduled_sync_batches`](#scheduled_sync_batches) | 追蹤預設排程中需彙總推播的一輪同步工作。 | 12 | 0 | 2 |
| [`sync_jobs`](#sync_jobs) | 每個連接器與同步範圍的排程、鎖定狀態與最近執行結果。 | 19 | 0 | 1 |
| [`sync_schedule_settings`](#sync_schedule_settings) | 所有使用 inherit 模式之同步工作的全域預設排程。 | 6 | 0 | 0 |
| [`sync_write_staging`](#sync_write_staging) | 同步流程寫入正式資料表前的暫存資料。 | 5 | 0 | 1 |

### `bank_accounts`

> 用途：各銀行與信用卡連接器同步回來的帳戶主檔；同一個實體帳戶可能同時存在多個來源記錄。
> 注意：canonical_account_id 為 NULL 的記錄是主要帳戶；有值的記錄是用於跨連接器對應的來源帳戶。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 系統內部使用的穩定帳戶識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 建立此記錄的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `source_id` | 外部銀行或連接器提供的帳戶識別碼。 | TEXT | NO | — | — | — |
| 4 | `institution_name` | 銀行、發卡機構或金融機構名稱。 | TEXT | YES | — | — | — |
| 5 | `account_name` | 前端顯示用的帳戶名稱。 | TEXT | YES | — | — | — |
| 6 | `account_type` | 帳戶類型，例如 checking、savings、credit 或 loan。 | TEXT | YES | — | — | — |
| 7 | `currency` | 帳戶金額使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 8 | `raw_payload` | 連接器回傳的原始或正規化 JSON，供除錯與重新解析使用。 | TEXT | YES | — | — | — |
| 9 | `created_at` | 此帳戶記錄首次寫入的時間。 | TEXT | NO | — | — | — |
| 10 | `updated_at` | 此帳戶記錄最後更新的時間。 | TEXT | NO | — | — | — |
| 11 | `bank_code` | 金融機構代碼，用於跨連接器辨識同一帳戶。 | TEXT | YES | — | — | — |
| 12 | `account_last4` | 帳號末四碼，用於顯示與帳戶比對。 | TEXT | YES | — | — | — |
| 13 | `canonical_account_id` | 指向同一實體的主要帳戶；NULL 表示此記錄本身就是主要帳戶。 | TEXT | YES | — | — | — |
| 14 | `credit_limit` | 信用卡或授信帳戶的額度；非授信帳戶通常為 NULL。 | INTEGER | YES | — | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `canonical_account_id` | `bank_accounts` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_bank_accounts_match` | 否 | 否 | `bank_code`, `account_last4`, `currency` | `CREATE INDEX idx_bank_accounts_match<br>  ON bank_accounts (bank_code, account_last4, currency)` |

#### DDL

```sql
CREATE TABLE "bank_accounts" (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  institution_name TEXT,
  account_name TEXT,
  account_type TEXT CHECK (
    account_type IS NULL
    OR account_type IN ('checking', 'savings', 'credit', 'loan', 'settlement_cash', 'time_deposit', 'stored_value', 'unknown')
  ),
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bank_code TEXT,
  account_last4 TEXT,
  canonical_account_id TEXT REFERENCES "bank_accounts" (id),
  credit_limit INTEGER,
  UNIQUE (connector_id, source_id)
)
```

### `bank_balance_snapshots`

> 用途：帳戶在特定時間點的餘額快照，供資產總值與歷史圖表計算。
> 注意：同一帳戶可以有多個時間點的快照；查詢最新餘額時會依 as_of_at 與 updated_at 排序。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 餘額快照的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 產生此快照的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `account_id` | 所屬 bank_accounts 記錄的識別碼。 | TEXT | NO | — | — | — |
| 4 | `source_id` | 外部來源對此餘額或帳戶的識別碼。 | TEXT | NO | — | — | — |
| 5 | `balance` | 連接器回報的帳戶餘額。 | INTEGER | NO | — | — | — |
| 6 | `available_balance` | 可立即使用的餘額；部分金融機構不提供時為 NULL。 | INTEGER | YES | — | — | — |
| 7 | `currency` | 餘額使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 8 | `as_of_at` | 餘額實際觀測或結算的時間。 | TEXT | NO | — | — | — |
| 9 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 10 | `created_at` | 此快照首次寫入的時間。 | TEXT | NO | — | — | — |
| 11 | `updated_at` | 此快照最後更新的時間。 | TEXT | NO | — | — | — |
| 12 | `statement_balance` | 信用卡帳單上的應繳金額。 | INTEGER | YES | — | — | — |
| 13 | `payment_due_date` | 信用卡帳單繳款期限。 | TEXT | YES | — | — | — |
| 14 | `no_payment_needed` | 是否標示為本期不需要繳款的旗標。 | INTEGER | YES | — | — | — |
| 15 | `statement_closing_date` | 信用卡帳單結帳日。 | TEXT | YES | — | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `account_id` | `bank_accounts` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_bank_balance_snapshots_as_of` | 否 | 否 | `as_of_at` | `CREATE INDEX idx_bank_balance_snapshots_as_of<br>  ON bank_balance_snapshots (as_of_at)` |
| `idx_bank_balance_snapshots_account_as_of` | 否 | 否 | `account_id`, `as_of_at` | `CREATE INDEX idx_bank_balance_snapshots_account_as_of<br>  ON bank_balance_snapshots (account_id, as_of_at)` |

#### DDL

```sql
CREATE TABLE "bank_balance_snapshots" (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES "bank_accounts" (id),
  source_id TEXT NOT NULL,
  balance INTEGER NOT NULL,
  available_balance INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_at TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  statement_balance INTEGER,
  payment_due_date TEXT,
  no_payment_needed INTEGER,
  statement_closing_date TEXT,
  UNIQUE (connector_id, account_id, source_id)
)
```

### `bank_transaction_preferences`

> 用途：使用者對銀行交易計算方式的個別偏好。
> 注意：目前主要用來記錄交易是否排除於資產或支出計算之外；沒有偏好的交易不會建立記錄。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `transaction_id` | 套用偏好的 bank_transactions 記錄識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `excluded_from_calculation` | 是否將此交易排除於計算，0 表示納入、1 表示排除。 | INTEGER | NO | 0 | — | — |
| 3 | `created_at` | 偏好首次建立的時間。 | TEXT | NO | — | — | — |
| 4 | `updated_at` | 偏好最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_bank_transaction_preferences_excluded` | 否 | 否 | `excluded_from_calculation` | `CREATE INDEX idx_bank_transaction_preferences_excluded<br>  ON bank_transaction_preferences (excluded_from_calculation)` |

#### DDL

```sql
CREATE TABLE bank_transaction_preferences (
  transaction_id TEXT PRIMARY KEY,
  excluded_from_calculation INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_calculation IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### `bank_transactions`

> 用途：銀行帳戶、信用卡與其他存款型連接器同步回來的交易明細。
> 注意：effective_date 統一有 posted_date 與 authorized_at 的交易排序；status 用來區分 pending 與 posted。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 交易的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 產生此交易的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `account_id` | 所屬 bank_accounts 記錄的識別碼。 | TEXT | NO | — | — | — |
| 4 | `source_id` | 外部來源系統提供的交易識別碼。 | TEXT | NO | — | — | — |
| 5 | `posted_date` | 交易正式入帳的日期或時間；尚未入帳時可能為 NULL。 | TEXT | YES | — | — | — |
| 6 | `authorized_at` | 交易授權或刷卡發生的時間。 | TEXT | YES | — | — | — |
| 7 | `amount` | 交易金額；正負方向依連接器正規化規則表示。 | INTEGER | NO | — | — | — |
| 8 | `currency` | 交易使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 9 | `description` | 銀行或商店提供的交易說明。 | TEXT | YES | — | — | — |
| 10 | `counterparty` | 交易對手、商店或收付款方名稱。 | TEXT | YES | — | — | — |
| 11 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 12 | `created_at` | 交易首次寫入的時間。 | TEXT | NO | — | — | — |
| 13 | `updated_at` | 交易最後更新的時間。 | TEXT | NO | — | — | — |
| 14 | `effective_date` | 由 posted_date 優先、authorized_at 備援產生的查詢排序日期。 | TEXT | YES | — | — | virtual |
| 15 | `status` | 交易狀態，目前限制為 pending 或 posted。 | TEXT | NO | 'posted' | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `account_id` | `bank_accounts` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_bank_transactions_status` | 否 | 否 | `connector_id`, `account_id`, `status` | `CREATE INDEX idx_bank_transactions_status<br>  ON bank_transactions (connector_id, account_id, status)` |
| `idx_bank_transactions_effective_updated` | 否 | 否 | `effective_date`, `updated_at`, `id` | `CREATE INDEX idx_bank_transactions_effective_updated<br>  ON bank_transactions (effective_date DESC, updated_at DESC, id DESC)` |
| `idx_bank_transactions_posted_date` | 否 | 否 | `posted_date` | `CREATE INDEX idx_bank_transactions_posted_date<br>  ON bank_transactions (posted_date)` |
| `idx_bank_transactions_account_posted_date` | 否 | 否 | `account_id`, `posted_date` | `CREATE INDEX idx_bank_transactions_account_posted_date<br>  ON bank_transactions (account_id, posted_date)` |

#### DDL

```sql
CREATE TABLE "bank_transactions" (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES "bank_accounts" (id),
  source_id TEXT NOT NULL,
  posted_date TEXT,
  authorized_at TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  description TEXT,
  counterparty TEXT,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_date TEXT AS (COALESCE(posted_date, authorized_at, '')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending', 'posted')),
  UNIQUE (connector_id, account_id, source_id)
)
```

### `classification_categories`

> 用途：交易與發票使用的分類字典，包含系統預設分類與使用者分類。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 分類的穩定識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `label` | 前端顯示的分類名稱。 | TEXT | NO | — | — | — |
| 3 | `sort_order` | 分類在介面中的排序順序。 | INTEGER | NO | 0 | — | — |
| 4 | `is_system` | 是否為系統內建分類；1 表示不可視為一般使用者資料刪除。 | INTEGER | NO | 1 | — | — |
| 5 | `created_at` | 分類建立的時間。 | TEXT | NO | — | — | — |
| 6 | `updated_at` | 分類最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_classification_categories_label_nocase` | 是 | 否 | `label` | `CREATE UNIQUE INDEX idx_classification_categories_label_nocase<br>  ON classification_categories (label COLLATE NOCASE)` |

#### DDL

```sql
CREATE TABLE classification_categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

### `classification_overrides`

> 用途：使用者對單筆目標資料指定的分類覆寫。
> 注意：同一個 target_type 與 target_id 只能有一個覆寫，優先於自動分類規則。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 覆寫記錄的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `target_type` | 被分類資料的類型，例如 bank_transaction。 | TEXT | NO | — | — | — |
| 3 | `target_id` | 被分類資料的識別碼。 | TEXT | NO | — | — | — |
| 4 | `category_id` | 指定的 classification_categories 識別碼。 | TEXT | NO | — | — | — |
| 5 | `created_at` | 覆寫建立的時間。 | TEXT | NO | — | — | — |
| 6 | `updated_at` | 覆寫最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `category_id` | `classification_categories` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_classification_overrides_category` | 否 | 否 | `category_id` | `CREATE INDEX idx_classification_overrides_category<br>  ON classification_overrides (category_id)` |

#### DDL

```sql
CREATE TABLE classification_overrides (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES classification_categories(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_type, target_id)
)
```

### `classification_rules`

> 用途：以文字條件自動判斷交易或其他資料分類的規則。
> 注意：規則依 enabled、target_type 與 priority 套用；system 規則由程式提供，user 規則可由使用者管理。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 規則的穩定識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `category_id` | 符合規則時套用的分類識別碼。 | TEXT | NO | — | — | — |
| 3 | `target_type` | 規則適用的資料類型；NULL 表示可套用於共用目標。 | TEXT | YES | — | — | — |
| 4 | `field` | 要比對的欄位或欄位集合，例如 any_text。 | TEXT | NO | — | — | — |
| 5 | `operator` | 比對運算子，例如 regex。 | TEXT | NO | — | — | — |
| 6 | `pattern` | 運算子使用的比對模式或關鍵字。 | TEXT | NO | — | — | — |
| 7 | `priority` | 規則套用的優先序。 | INTEGER | NO | 100 | — | — |
| 8 | `enabled` | 規則是否啟用，0 表示停用。 | INTEGER | NO | 1 | — | — |
| 9 | `is_system` | 是否為系統內建規則。 | INTEGER | NO | 0 | — | — |
| 10 | `source` | 規則來源，例如 system 或 user。 | TEXT | NO | 'user' | — | — |
| 11 | `description` | 規則用途的可讀說明。 | TEXT | YES | — | — | — |
| 12 | `created_at` | 規則建立的時間。 | TEXT | NO | — | — | — |
| 13 | `updated_at` | 規則最後更新的時間。 | TEXT | NO | — | — | — |
| 14 | `excluded_from_calculation` | 符合規則的交易是否預設排除於計算，0 表示納入、1 表示排除。 | INTEGER | NO | 0 | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `category_id` | `classification_categories` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_classification_rules_category` | 否 | 否 | `category_id` | `CREATE INDEX idx_classification_rules_category<br>  ON classification_rules (category_id)` |
| `idx_classification_rules_enabled_priority` | 否 | 否 | `enabled`, `target_type`, `priority` | `CREATE INDEX idx_classification_rules_enabled_priority<br>  ON classification_rules (enabled, target_type, priority)` |

#### DDL

```sql
CREATE TABLE classification_rules (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES classification_categories(id),
  target_type TEXT,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'user',
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, excluded_from_calculation INTEGER NOT NULL DEFAULT 0
CHECK (excluded_from_calculation IN (0, 1)))
```

### `connector_settings`

> 用途：每個外部金融資料連接器的認證設定、公開設定與同步游標。
> 注意：encrypted_config 儲存敏感憑證；public_config 僅供非敏感的連接器設定使用。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 設定記錄的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 連接器的穩定識別碼，每個連接器只有一筆設定。 | TEXT | NO | — | — | — |
| 3 | `encrypted_config` | 使用 Worker 設定的金鑰加密後的認證與私密設定。 | TEXT | NO | — | — | — |
| 4 | `sync_cursor` | 連接器下次增量同步使用的游標或狀態。 | TEXT | YES | — | — | — |
| 5 | `created_at` | 連接器設定首次建立的時間。 | TEXT | NO | — | — | — |
| 6 | `updated_at` | 連接器設定最後更新的時間。 | TEXT | NO | — | — | — |
| 7 | `public_config` | 不含敏感資訊、可供前端或同步流程讀取的 JSON 設定。 | TEXT | YES | — | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE connector_settings (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  encrypted_config TEXT NOT NULL,
  sync_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, public_config TEXT,
  UNIQUE (connector_id)
)
```

### `credit_card_bills`

> 用途：信用卡依帳單週期整理的帳單主檔。
> 注意：此表描述帳單，不是逐筆交易；逐筆刷卡資料仍位於 bank_transactions。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 帳單的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 產生此帳單的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `account_id` | 所屬信用卡帳戶的 bank_accounts 識別碼。 | TEXT | NO | — | — | — |
| 4 | `source_id` | 外部來源系統提供的帳單識別碼。 | TEXT | NO | — | — | — |
| 5 | `billing_period` | 帳單週期，格式通常為 YYYY-MM。 | TEXT | NO | — | — | — |
| 6 | `statement_amount` | 本期帳單總額。 | INTEGER | YES | — | — | — |
| 7 | `minimum_payment` | 本期最低應繳金額。 | INTEGER | YES | — | — | — |
| 8 | `paid_amount` | 目前已繳付的金額。 | INTEGER | YES | — | — | — |
| 9 | `is_paid` | 帳單是否已繳清的旗標。 | INTEGER | YES | — | — | — |
| 10 | `payment_due_date` | 帳單繳款期限。 | TEXT | YES | — | — | — |
| 11 | `statement_closing_date` | 帳單結帳日。 | TEXT | YES | — | — | — |
| 12 | `currency` | 帳單金額使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 13 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 14 | `created_at` | 帳單首次寫入的時間。 | TEXT | NO | — | — | — |
| 15 | `updated_at` | 帳單最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `account_id` | `bank_accounts` | `id` | NO ACTION | NO ACTION |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_credit_card_bills_page` | 否 | 否 | `billing_period`, `account_id`, `id` | `CREATE INDEX idx_credit_card_bills_page<br>  ON credit_card_bills (billing_period DESC, account_id ASC, id ASC)` |
| `idx_credit_card_bills_account_period` | 否 | 否 | `account_id`, `billing_period` | `CREATE INDEX idx_credit_card_bills_account_period<br>  ON credit_card_bills (account_id, billing_period)` |

#### DDL

```sql
CREATE TABLE "credit_card_bills" (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES "bank_accounts" (id),
  source_id TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  statement_amount INTEGER,
  minimum_payment INTEGER,
  paid_amount INTEGER,
  is_paid INTEGER,
  payment_due_date TEXT,
  statement_closing_date TEXT,
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, account_id, billing_period)
)
```

### `exchange_rates`

> 用途：將外幣換算為新台幣時使用的最新匯率。
> 注意：net_worth 計算會使用 rate_to_twd；找不到非 TWD 匯率時不會硬算。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `currency` | 外幣幣別代碼，也是此表的主鍵。 | TEXT | YES | — | 1 | — |
| 2 | `rate_to_twd` | 一單位該幣別換算成 TWD 的匯率。 | REAL | NO | — | — | — |
| 3 | `updated_at` | 匯率最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE exchange_rates (
  currency TEXT PRIMARY KEY,
  rate_to_twd REAL NOT NULL,
  updated_at TEXT NOT NULL
)
```

### `investment_positions`

> 用途：投資帳戶在特定日期的持倉與資產市值快照。
> 注意：同一 connector、source 與日期可有一組持倉；最新持倉與分頁查詢依 as_of_date。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 持倉快照的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 產生此持倉的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `source_id` | 外部來源系統提供的持倉識別碼。 | TEXT | NO | — | — | — |
| 4 | `asset_type` | 資產類型，目前限制為 stock、etf 或 fund。 | TEXT | NO | — | — | — |
| 5 | `symbol` | 證券、基金或 ETF 的代號。 | TEXT | YES | — | — | — |
| 6 | `name` | 投資標的名稱。 | TEXT | NO | — | — | — |
| 7 | `quantity` | 持有數量。 | REAL | YES | — | — | — |
| 8 | `market_value` | 持倉的市場價值。 | INTEGER | YES | — | — | — |
| 9 | `cash_balance` | 此投資帳戶或資產項目中的現金餘額。 | INTEGER | YES | — | — | — |
| 10 | `currency` | 市值與現金使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 11 | `as_of_date` | 持倉快照所代表的日期。 | TEXT | NO | — | — | — |
| 12 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 13 | `created_at` | 持倉首次寫入的時間。 | TEXT | NO | — | — | — |
| 14 | `updated_at` | 持倉最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_investment_positions_page` | 否 | 否 | `as_of_date`, `asset_type`, `name`, `id` | `CREATE INDEX idx_investment_positions_page<br>  ON investment_positions (as_of_date DESC, asset_type ASC, name ASC, id ASC)` |
| `idx_investment_positions_latest_scope` | 否 | 否 | `connector_id`, `asset_type`, `as_of_date` | `CREATE INDEX idx_investment_positions_latest_scope<br>  ON investment_positions (connector_id, asset_type, as_of_date DESC)` |
| `idx_investment_positions_asset_type` | 否 | 否 | `asset_type` | `CREATE INDEX idx_investment_positions_asset_type<br>  ON investment_positions (asset_type)` |
| `idx_investment_positions_as_of_date` | 否 | 否 | `as_of_date` | `CREATE INDEX idx_investment_positions_as_of_date<br>  ON investment_positions (as_of_date)` |

#### DDL

```sql
CREATE TABLE investment_positions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund')),
  symbol TEXT,
  name TEXT NOT NULL,
  quantity REAL,
  market_value INTEGER,
  cash_balance INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_date TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id, as_of_date)
)
```

### `investment_transactions`

> 用途：投資帳戶的買賣、配息或其他證券交易明細。
> 注意：account_id 是外部投資帳戶識別碼，不直接 FK 到 bank_accounts；effective_date 用於列表排序。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 投資交易的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 產生此交易的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `account_id` | 外部券商或投資帳戶識別碼。 | TEXT | NO | — | — | — |
| 4 | `source_id` | 外部來源系統提供的交易識別碼。 | TEXT | NO | — | — | — |
| 5 | `broker_no` | 券商或分公司代碼。 | TEXT | YES | — | — | — |
| 6 | `broker_account` | 券商帳號或交割帳號。 | TEXT | YES | — | — | — |
| 7 | `broker_name` | 券商或交易機構名稱。 | TEXT | YES | — | — | — |
| 8 | `symbol` | 交易標的代號。 | TEXT | YES | — | — | — |
| 9 | `name` | 交易標的名稱。 | TEXT | YES | — | — | — |
| 10 | `asset_type` | 資產類型，例如 stock、etf、fund、bond 或 unknown。 | TEXT | YES | — | — | — |
| 11 | `trade_date` | 交易發生日期。 | TEXT | YES | — | — | — |
| 12 | `posted_date` | 交易正式入帳日期。 | TEXT | YES | — | — | — |
| 13 | `transaction_code` | 外部系統的交易類型代碼。 | TEXT | YES | — | — | — |
| 14 | `transaction_name` | 外部系統的交易類型名稱。 | TEXT | YES | — | — | — |
| 15 | `quantity` | 交易數量。 | REAL | YES | — | — | — |
| 16 | `price` | 每單位成交或計算價格。 | REAL | YES | — | — | — |
| 17 | `amount` | 交易總金額。 | INTEGER | YES | — | — | — |
| 18 | `currency` | 交易金額使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |
| 19 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 20 | `created_at` | 交易首次寫入的時間。 | TEXT | NO | — | — | — |
| 21 | `updated_at` | 交易最後更新的時間。 | TEXT | NO | — | — | — |
| 22 | `effective_date` | 由 trade_date 優先、posted_date 備援產生的排序日期。 | TEXT | YES | — | — | virtual |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_investment_transactions_effective_updated` | 否 | 否 | `effective_date`, `updated_at`, `id` | `CREATE INDEX idx_investment_transactions_effective_updated<br>  ON investment_transactions (effective_date DESC, updated_at DESC, id DESC)` |
| `idx_investment_transactions_symbol` | 否 | 否 | `symbol` | `CREATE INDEX idx_investment_transactions_symbol<br>  ON investment_transactions (symbol)` |
| `idx_investment_transactions_trade_date` | 否 | 否 | `trade_date` | `CREATE INDEX idx_investment_transactions_trade_date<br>  ON investment_transactions (trade_date)` |

#### DDL

```sql
CREATE TABLE investment_transactions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  broker_no TEXT,
  broker_account TEXT,
  broker_name TEXT,
  symbol TEXT,
  name TEXT,
  asset_type TEXT CHECK (asset_type IN ('stock', 'etf', 'fund', 'bond', 'unknown')),
  trade_date TEXT,
  posted_date TEXT,
  transaction_code TEXT,
  transaction_name TEXT,
  quantity REAL,
  price REAL,
  amount INTEGER,
  currency TEXT NOT NULL DEFAULT 'TWD',
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, effective_date TEXT AS (COALESCE(trade_date, posted_date, '')),
  UNIQUE (connector_id, account_id, source_id)
)
```

### `invoice_line_items`

> 用途：電子發票底下的商品或服務明細。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 發票明細的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `invoice_id` | 所屬 invoices 記錄的識別碼。 | TEXT | NO | — | — | — |
| 3 | `connector_id` | 取得此明細的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 4 | `invoice_source_id` | 外部來源發票識別碼，用於同步比對。 | TEXT | NO | — | — | — |
| 5 | `source_id` | 外部來源明細識別碼。 | TEXT | NO | — | — | — |
| 6 | `line_number` | 明細在發票中的順序。 | INTEGER | NO | — | — | — |
| 7 | `description` | 商品或服務描述。 | TEXT | NO | — | — | — |
| 8 | `quantity` | 購買數量。 | REAL | YES | — | — | — |
| 9 | `unit_price` | 單位價格。 | INTEGER | YES | — | — | — |
| 10 | `amount` | 此明細的小計金額。 | INTEGER | NO | — | — | — |
| 11 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 12 | `created_at` | 明細首次寫入的時間。 | TEXT | NO | — | — | — |
| 13 | `updated_at` | 明細最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `invoice_id` | `invoices` | `id` | NO ACTION | CASCADE |

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_invoice_line_items_invoice_source` | 否 | 否 | `connector_id`, `invoice_source_id` | `CREATE INDEX idx_invoice_line_items_invoice_source<br>  ON invoice_line_items (connector_id, invoice_source_id)` |
| `idx_invoice_line_items_invoice_id` | 否 | 否 | `invoice_id` | `CREATE INDEX idx_invoice_line_items_invoice_id<br>  ON invoice_line_items (invoice_id)` |

#### DDL

```sql
CREATE TABLE invoice_line_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  invoice_source_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL,
  unit_price INTEGER,
  amount INTEGER NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  UNIQUE (connector_id, invoice_source_id, source_id)
)
```

### `invoice_transaction_preferences`

> 用途：使用者對電子發票與銀行交易是否關聯的決策。
> 注意：decision=linked 時 transaction_id 必須存在；decision=separate 表示刻意維持兩筆獨立資料。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `invoice_id` | 套用決策的 invoices 記錄識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `transaction_id` | 被關聯的 bank_transactions 識別碼；separate 時為 NULL。 | TEXT | YES | — | — | — |
| 3 | `decision` | 關聯決策，目前限制為 linked 或 separate。 | TEXT | NO | — | — | — |
| 4 | `created_at` | 決策首次建立的時間。 | TEXT | NO | — | — | — |
| 5 | `updated_at` | 決策最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_invoice_transaction_preferences_linked_transaction` | 是 | 是 | `transaction_id` | `CREATE UNIQUE INDEX idx_invoice_transaction_preferences_linked_transaction<br>  ON invoice_transaction_preferences (transaction_id)<br>  WHERE decision = 'linked'` |

#### DDL

```sql
CREATE TABLE invoice_transaction_preferences (
  invoice_id TEXT PRIMARY KEY,
  transaction_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('linked', 'separate')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (decision = 'linked' AND transaction_id IS NOT NULL)
    OR decision = 'separate'
  )
)
```

### `invoices`

> 用途：電子發票的抬頭與總額主檔。
> 注意：商品明細另存於 invoice_line_items；同一 connector 與 source_id 只保留一張發票。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 發票的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 取得此發票的外部連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `source_id` | 外部來源系統提供的發票識別碼。 | TEXT | NO | — | — | — |
| 4 | `invoice_number` | 發票字軌號碼或發票號碼。 | TEXT | YES | — | — | — |
| 5 | `invoice_date` | 發票開立日期。 | TEXT | NO | — | — | — |
| 6 | `seller_name` | 賣方或開立人名稱。 | TEXT | YES | — | — | — |
| 7 | `amount` | 發票總金額。 | INTEGER | NO | — | — | — |
| 8 | `raw_payload` | 連接器回傳的原始或正規化 JSON。 | TEXT | YES | — | — | — |
| 9 | `created_at` | 發票首次寫入的時間。 | TEXT | NO | — | — | — |
| 10 | `updated_at` | 發票最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_invoices_page` | 否 | 否 | `invoice_date`, `updated_at`, `id` | `CREATE INDEX idx_invoices_page<br>  ON invoices (invoice_date DESC, updated_at DESC, id DESC)` |
| `idx_invoices_invoice_date` | 否 | 否 | `invoice_date` | `CREATE INDEX idx_invoices_invoice_date<br>  ON invoices (invoice_date)` |

#### DDL

```sql
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  invoice_number TEXT,
  invoice_date TEXT NOT NULL,
  seller_name TEXT,
  amount INTEGER NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id)
)
```

### `manual_assets`

> 用途：使用者手動登錄、無法由銀行或投資連接器同步的資產。
> 注意：資產目前的金額與歷史值存於 net_worth_history，asset_type 對應此表的 id。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 手動資產的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `name` | 前端顯示的資產名稱。 | TEXT | NO | — | — | — |
| 3 | `category` | 資產分類，例如房產、現金或其他。 | TEXT | NO | — | — | — |
| 4 | `note` | 使用者補充的備註。 | TEXT | YES | — | — | — |
| 5 | `created_at` | 手動資產建立的時間。 | TEXT | NO | — | — | — |
| 6 | `currency` | 資產估值使用的幣別，預設為 TWD。 | TEXT | NO | 'TWD' | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE manual_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
, currency TEXT NOT NULL DEFAULT 'TWD')
```

### `net_worth_history`

> 用途：按日期保存的淨資產或資產類別歷史數值，用於圖表與歷史查詢。
> 注意：這是由銀行餘額、投資持倉與手動資產等來源整理出的讀模型，不是單一連接器的原始資料。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 歷史點的系統識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `date` | 此數值所代表的日期。 | TEXT | NO | — | — | — |
| 3 | `net_worth` | 該日期與資產類型的金額；手動資產保留其設定幣別，其餘讀模型通常以 TWD 表示。 | INTEGER | NO | — | — | — |
| 4 | `asset_type` | 資產類型，例如 total、deposit、stock、fund 或手動資產 id。 | TEXT | NO | 'total' | — | — |
| 5 | `source` | 數值來源，例如 bank 或 manual。 | TEXT | NO | — | — | — |
| 6 | `snapshotted_at` | 此歷史點實際建立或重算的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_net_worth_history_page` | 否 | 否 | `date`, `source`, `asset_type`, `id` | `CREATE INDEX idx_net_worth_history_page<br>  ON net_worth_history (date DESC, source ASC, asset_type ASC, id ASC)` |
| `idx_net_worth_history_date` | 否 | 否 | `date` | `CREATE INDEX idx_net_worth_history_date<br>  ON net_worth_history (date)` |

#### DDL

```sql
CREATE TABLE net_worth_history (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  net_worth INTEGER NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'total',
  source TEXT NOT NULL,
  snapshotted_at TEXT NOT NULL,
  UNIQUE (source, asset_type, date)
)
```

### `notification_preferences`

> 用途：此單一部署的同步推播偏好設定。
> 注意：id 固定為 default；成功通知預設關閉，失敗與需要使用者處理預設開啟。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 設定識別碼，固定為 default。 | TEXT | YES | — | 1 | — |
| 2 | `notify_success` | 是否在排程同步成功時顯示推播。 | INTEGER | NO | 0 | — | — |
| 3 | `notify_failed` | 是否在排程同步失敗時顯示推播。 | INTEGER | NO | 1 | — | — |
| 4 | `notify_needs_user_action` | 是否在同步需要 OTP、CAPTCHA 或重新登入時顯示推播。 | INTEGER | NO | 1 | — | — |
| 5 | `updated_at` | 推播偏好最後更新的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE notification_preferences (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  notify_success INTEGER NOT NULL DEFAULT 0,
  notify_failed INTEGER NOT NULL DEFAULT 1,
  notify_needs_user_action INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
)
```

### `push_subscriptions`

> 用途：瀏覽器 Web Push 裝置訂閱資料。
> 注意：訂閱 payload 使用應用程式加密金鑰保存；失效的 push endpoint 會在發送時清理。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 由 push endpoint 雜湊產生的裝置訂閱識別碼。 | TEXT | YES | — | 1 | — |
| 2 | `encrypted_subscription` | 加密保存的 endpoint、p256dh 與 auth 訂閱資料。 | TEXT | NO | — | — | — |
| 3 | `created_at` | 裝置首次登記的時間。 | TEXT | NO | — | — | — |
| 4 | `updated_at` | 裝置訂閱最後更新的時間。 | TEXT | NO | — | — | — |
| 5 | `last_success_at` | 最近一次成功送達 push service 的時間。 | TEXT | YES | — | — | — |
| 6 | `consecutive_failures` | 連續發送失敗次數，用於診斷暫時性問題。 | INTEGER | NO | 0 | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  encrypted_subscription TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
)
```

### `scheduled_sync_batch_results`

> 用途：預設排程同步批次中各工作的完成結果。
> 注意：每個 batch_id 與 job_id 只保存一筆結果；completed_at 為 NULL 表示等待排程執行，status 為 NULL 且已完成表示成員被略過。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `batch_id` | 所屬的預設排程同步批次。 | TEXT | NO | — | 1 | — |
| 2 | `job_id` | 批次成員的同步工作識別碼。 | TEXT | NO | — | 2 | — |
| 3 | `connector_id` | 此次結果所屬的連接器。 | TEXT | NO | — | — | — |
| 4 | `status` | 排程執行結果；等待執行或被略過的成員為 NULL。 | TEXT | YES | — | — | — |
| 5 | `completed_at` | 排程結果或略過決定寫入批次的時間；NULL 表示仍在等待。 | TEXT | YES | — | — | — |
| 6 | `new_invoices` | 此次工作真正新增的電子發票筆數，不包含更新既有發票。 | INTEGER | NO | 0 | — | — |
| 7 | `new_bank_transactions` | 此次工作真正新增的銀行或信用卡交易筆數，不包含更新既有交易。 | INTEGER | NO | 0 | — | — |
| 8 | `new_investment_transactions` | 此次工作真正新增的投資交易筆數，不包含更新既有交易。 | INTEGER | NO | 0 | — | — |

#### Foreign keys

| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |
| --- | --- | --- | --- | --- |
| `batch_id` | `scheduled_sync_batches` | `id` | NO ACTION | CASCADE |

#### Indexes

—

#### DDL

```sql
CREATE TABLE scheduled_sync_batch_results (
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  status TEXT CHECK (status IN ('success', 'failed', 'needs_user_action')),
  completed_at TEXT, new_invoices INTEGER NOT NULL DEFAULT 0, new_bank_transactions INTEGER NOT NULL DEFAULT 0, new_investment_transactions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (batch_id, job_id),
  FOREIGN KEY (batch_id) REFERENCES scheduled_sync_batches(id) ON DELETE CASCADE
)
```

### `scheduled_sync_batches`

> 用途：追蹤預設排程中需彙總推播的一輪同步工作。
> 注意：同一 schedule_key 同時只保留一個未 claim 批次；建立時固定整輪成員，所有成員完成或略過後只允許一個 scheduler claim 推播。建立新輪次時會清理超過 30 天的已結案批次。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 批次識別碼，由 default 與 UUID 組成。 | TEXT | YES | — | 1 | — |
| 2 | `schedule_key` | 排程類型識別碼，目前固定為 default。 | TEXT | NO | 'default' | — | — |
| 3 | `notification_claimed_at` | 彙總推播被 scheduler 取得發送權的時間。 | TEXT | YES | — | — | — |
| 4 | `created_at` | 批次建立時間。 | TEXT | NO | — | — | — |
| 5 | `completed_at` | 批次所有有效成員結束並完成財務快照的時間。 | TEXT | YES | — | — | — |
| 6 | `is_baseline` | 是否為第一份同步報告；第一份只建立比較基準，不顯示增減。 | INTEGER | NO | 0 | — | — |
| 7 | `assets_before_twd` | 批次開始前以新臺幣換算的資產總額。 | INTEGER | YES | — | — | — |
| 8 | `credit_card_debt_before_twd` | 批次開始前以新臺幣換算的信用卡負債總額。 | INTEGER | YES | — | — | — |
| 9 | `missing_currencies_before` | 批次開始前缺少匯率、以新台幣 0 元計值的幣別 JSON 陣列。 | TEXT | NO | '[]' | — | — |
| 10 | `assets_after_twd` | 批次完成後以新臺幣換算的資產總額。 | INTEGER | YES | — | — | — |
| 11 | `credit_card_debt_after_twd` | 批次完成後以新臺幣換算的信用卡負債總額。 | INTEGER | YES | — | — | — |
| 12 | `missing_currencies_after` | 批次完成後缺少匯率、以新台幣 0 元計值的幣別 JSON 陣列。 | TEXT | NO | '[]' | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_scheduled_sync_batches_completed` | 否 | 否 | `completed_at` | `CREATE INDEX idx_scheduled_sync_batches_completed<br>  ON scheduled_sync_batches (completed_at DESC)` |
| `idx_scheduled_sync_batches_open` | 是 | 是 | `schedule_key` | `CREATE UNIQUE INDEX idx_scheduled_sync_batches_open<br>  ON scheduled_sync_batches (schedule_key)<br>  WHERE notification_claimed_at IS NULL` |

#### DDL

```sql
CREATE TABLE scheduled_sync_batches (
  id TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL DEFAULT 'default' CHECK (schedule_key = 'default'),
  notification_claimed_at TEXT,
  created_at TEXT NOT NULL
, completed_at TEXT, is_baseline INTEGER NOT NULL DEFAULT 0, assets_before_twd INTEGER, credit_card_debt_before_twd INTEGER, missing_currencies_before TEXT NOT NULL DEFAULT '[]', assets_after_twd INTEGER, credit_card_debt_after_twd INTEGER, missing_currencies_after TEXT NOT NULL DEFAULT '[]')
```

### `sync_jobs`

> 用途：每個連接器與同步範圍的排程、鎖定狀態與最近執行結果。
> 注意：Worker Cron 會依 next_run_at 找到工作並取得 lease；locked_* 欄位用來避免同一工作重複執行。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 同步工作的系統識別碼，通常由 connector_id 與 scope 組成。 | TEXT | YES | — | 1 | — |
| 2 | `connector_id` | 要執行同步的連接器識別碼。 | TEXT | NO | — | — | — |
| 3 | `scope` | 同步範圍，例如 all 或特定帳戶範圍。 | TEXT | NO | — | — | — |
| 4 | `enabled` | 是否啟用此同步工作。 | INTEGER | NO | 1 | — | — |
| 5 | `interval_minutes` | 同步間隔，單位為分鐘。 | INTEGER | NO | — | — | — |
| 6 | `next_run_at` | 下一次允許執行的時間。 | TEXT | NO | — | — | — |
| 7 | `locked_until` | 目前 lease 鎖定到期時間。 | TEXT | YES | — | — | — |
| 8 | `locked_by` | 取得 lease 的同步執行識別碼。 | TEXT | YES | — | — | — |
| 9 | `lock_trigger` | 取得鎖定的觸發來源，例如 manual 或 scheduled。 | TEXT | YES | — | — | — |
| 10 | `lock_scope` | 此次執行實際鎖定的細部範圍。 | TEXT | YES | — | — | — |
| 11 | `last_run_at` | 最近一次開始執行的時間。 | TEXT | YES | — | — | — |
| 12 | `last_success_at` | 最近一次成功完成的時間。 | TEXT | YES | — | — | — |
| 13 | `last_status` | 最近一次結果，例如 success、failed 或 needs_user_action。 | TEXT | YES | — | — | — |
| 14 | `last_error` | 最近一次失敗或需要使用者處理的錯誤訊息。 | TEXT | YES | — | — | — |
| 15 | `created_at` | 同步工作建立的時間。 | TEXT | NO | — | — | — |
| 16 | `updated_at` | 同步工作最後更新的時間。 | TEXT | NO | — | — | — |
| 17 | `schedule_mode` | 排程模式；inherit 使用全域設定，custom 使用工作自己的設定。 | TEXT | NO | 'inherit' | — | — |
| 18 | `preferred_time` | 每日或每週排程偏好的台北時間。 | TEXT | NO | '06:00' | — | — |
| 19 | `preferred_weekday` | 每週排程的星期，0 代表週日、6 代表週六。 | INTEGER | NO | 1 | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_sync_jobs_due` | 否 | 否 | `enabled`, `next_run_at` | `CREATE INDEX idx_sync_jobs_due<br>  ON sync_jobs (enabled, next_run_at)` |

#### DDL

```sql
CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  locked_until TEXT,
  locked_by TEXT,
  lock_trigger TEXT CHECK (lock_trigger IS NULL OR lock_trigger IN ('manual', 'scheduled')),
  lock_scope TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, schedule_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (schedule_mode IN ('inherit', 'custom')), preferred_time TEXT NOT NULL DEFAULT '06:00', preferred_weekday INTEGER NOT NULL DEFAULT 1
  CHECK (preferred_weekday BETWEEN 0 AND 6),
  UNIQUE (connector_id, scope)
)
```

### `sync_schedule_settings`

> 用途：所有使用 inherit 模式之同步工作的全域預設排程。
> 注意：id 固定為 default；修改設定時會同步重算繼承此設定的 sync_jobs。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `id` | 設定識別碼，固定為 default。 | TEXT | YES | — | 1 | — |
| 2 | `interval_minutes` | 預設同步間隔，單位為分鐘。 | INTEGER | NO | — | — | — |
| 3 | `preferred_time` | 預設每日或每週執行時間，使用台北時間。 | TEXT | NO | — | — | — |
| 4 | `timezone` | 排程使用的時區，目前為 Asia/Taipei。 | TEXT | NO | — | — | — |
| 5 | `updated_at` | 全域排程最後更新的時間。 | TEXT | NO | — | — | — |
| 6 | `preferred_weekday` | 每週排程的預設星期，0 代表週日、6 代表週六。 | INTEGER | NO | 1 | — | — |

#### Foreign keys

—

#### Indexes

—

#### DDL

```sql
CREATE TABLE sync_schedule_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  interval_minutes INTEGER NOT NULL,
  preferred_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  updated_at TEXT NOT NULL
, preferred_weekday INTEGER NOT NULL DEFAULT 1
  CHECK (preferred_weekday BETWEEN 0 AND 6))
```

### `sync_write_staging`

> 用途：同步流程寫入正式資料表前的暫存資料。
> 注意：payload 必須是合法 JSON；同步完成或失敗後會清理，避免部分同步結果直接暴露為正式資料。

#### Columns

| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |
| ---: | --- | --- | --- | :---: | --- | ---: | --- |
| 1 | `run_id` | 此次同步執行的識別碼。 | TEXT | NO | — | 1 | — |
| 2 | `entity_type` | 暫存資料的實體類型，例如 bank_transaction。 | TEXT | NO | — | 2 | — |
| 3 | `record_key` | 該實體在此次同步中的去重與覆寫鍵。 | TEXT | NO | — | 3 | — |
| 4 | `payload` | 待寫入正式表的正規化 JSON 資料。 | TEXT | NO | — | — | — |
| 5 | `created_at` | 暫存資料建立的時間。 | TEXT | NO | — | — | — |

#### Foreign keys

—

#### Indexes

| Index | Unique | Partial | 欄位 | 定義 |
| --- | :---: | :---: | --- | --- |
| `idx_sync_write_staging_created_at` | 否 | 否 | `created_at` | `CREATE INDEX idx_sync_write_staging_created_at<br>  ON sync_write_staging (created_at)` |

#### DDL

```sql
CREATE TABLE sync_write_staging (
  run_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, entity_type, record_key)
)
```

## Other database objects

目前沒有 view 或 trigger。

## Migration history

Migration 是 schema 演進的 source of truth；若要了解某欄位的變更原因，請從對應 migration 檔案與 Git history 追查。

- [`0001_initial.sql`](../packages/db/migrations/0001_initial.sql)
- [`0002_bank_account_credit.sql`](../packages/db/migrations/0002_bank_account_credit.sql)
- [`0003_sync_jobs.sql`](../packages/db/migrations/0003_sync_jobs.sql)
- [`0004_sync_job_defaults.sql`](../packages/db/migrations/0004_sync_job_defaults.sql)
- [`0005_sinopac_sync_job.sql`](../packages/db/migrations/0005_sinopac_sync_job.sql)
- [`0006_sinopac_app_json_cleanup.sql`](../packages/db/migrations/0006_sinopac_app_json_cleanup.sql)
- [`0008_default_sync_schedule.sql`](../packages/db/migrations/0008_default_sync_schedule.sql)
- [`0009_weekly_sync_weekday.sql`](../packages/db/migrations/0009_weekly_sync_weekday.sql)
- [`0010_bank_transaction_preferences.sql`](../packages/db/migrations/0010_bank_transaction_preferences.sql)
- [`0011_classification_rule_actions.sql`](../packages/db/migrations/0011_classification_rule_actions.sql)
- [`0012_sync_staging_and_query_indexes.sql`](../packages/db/migrations/0012_sync_staging_and_query_indexes.sql)
- [`0013_invoice_transaction_preferences.sql`](../packages/db/migrations/0013_invoice_transaction_preferences.sql)
- [`0014_bank_transaction_status.sql`](../packages/db/migrations/0014_bank_transaction_status.sql)
- [`0015_push_notifications.sql`](../packages/db/migrations/0015_push_notifications.sql)
- [`0016_scheduled_sync_notification_batches.sql`](../packages/db/migrations/0016_scheduled_sync_notification_batches.sql)
- [`0017_taishin_sync_job.sql`](../packages/db/migrations/0017_taishin_sync_job.sql)
- [`0018_esun_credit_transaction_signs.sql`](../packages/db/migrations/0018_esun_credit_transaction_signs.sql)
- [`0019_rename_other_classification.sql`](../packages/db/migrations/0019_rename_other_classification.sql)
- [`0020_connector_cursor_secret_cleanup.sql`](../packages/db/migrations/0020_connector_cursor_secret_cleanup.sql)
- [`0021_ctbc_sync_job.sql`](../packages/db/migrations/0021_ctbc_sync_job.sql)
- [`0023_disable_unconfigured_sync_jobs.sql`](../packages/db/migrations/0023_disable_unconfigured_sync_jobs.sql)
- [`0024_manual_asset_currency.sql`](../packages/db/migrations/0024_manual_asset_currency.sql)
- [`0025_bank_time_deposit.sql`](../packages/db/migrations/0025_bank_time_deposit.sql)
- [`0026_obank_sync_job.sql`](../packages/db/migrations/0026_obank_sync_job.sql)
- [`0027_scheduled_sync_reports.sql`](../packages/db/migrations/0027_scheduled_sync_reports.sql)

## 程式碼導覽

- Feature-specific SQL：`apps/worker/src/features/*/repository.ts`
- 共用 D1 能力：`packages/db/src/`
- 共用資料契約：`packages/core/`
