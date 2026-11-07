-- 投資持倉補上安全去重所需的帳戶／市場識別與來源提供的損益欄位。
-- SQLite 無法直接修改既有欄位型別，因此重建資料表，並將市值／現金改為 REAL
-- 以保留外幣與小數股的原始精度。
CREATE TABLE investment_positions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund', 'crypto')),
  symbol TEXT,
  name TEXT NOT NULL,
  broker_no TEXT,
  broker_account TEXT,
  market TEXT,
  quantity REAL,
  market_value REAL,
  cash_balance REAL,
  cost_basis REAL,
  unrealized_pnl REAL,
  currency TEXT NOT NULL DEFAULT 'TWD',
  as_of_date TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connector_id, source_id, as_of_date)
);

-- 舊版 TDCC 股票 source_id 的固定格式是
-- brokerNo:brokerAccount:symbol:asOfDate。只有在券商代號為三至四碼英數字、帳號純數字、日期確實
-- 位於 source_id 尾端且格式無歧義時才回填；基金、外幣或未知格式維持 NULL，
-- 避免以猜測的帳戶識別跨來源合併。
WITH tdcc_source_parts AS (
  SELECT
    id,
    substr(source_id, 1, instr(source_id, ':') - 1) AS broker_no,
    substr(
      source_id,
      instr(source_id, ':') + 1,
      instr(substr(source_id, instr(source_id, ':') + 1), ':') - 1
    ) AS broker_account
  FROM investment_positions
  WHERE connector_id = 'tdcc'
    AND asset_type IN ('stock', 'etf')
    AND UPPER(COALESCE(currency, 'TWD')) = 'TWD'
    AND instr(source_id, ':') > 1
    AND instr(substr(source_id, instr(source_id, ':') + 1), ':') > 1
    AND length(substr(source_id, 1, instr(source_id, ':') - 1)) BETWEEN 3 AND 4
    AND substr(source_id, 1, instr(source_id, ':') - 1) NOT GLOB '*[^0-9A-Za-z]*'
    AND length(substr(
      source_id,
      instr(source_id, ':') + 1,
      instr(substr(source_id, instr(source_id, ':') + 1), ':') - 1
    )) BETWEEN 4 AND 20
    AND substr(
      source_id,
      instr(source_id, ':') + 1,
      instr(substr(source_id, instr(source_id, ':') + 1), ':') - 1
    ) GLOB '[0-9]*'
    AND substr(
      source_id,
      instr(source_id, ':') + 1,
      instr(substr(source_id, instr(source_id, ':') + 1), ':') - 1
    ) NOT GLOB '*[^0-9]*'
    AND source_id LIKE '%' || ':' || as_of_date
    AND source_id =
      substr(source_id, 1, instr(source_id, ':') - 1) || ':' ||
      substr(source_id, instr(source_id, ':') + 1,
        instr(substr(source_id, instr(source_id, ':') + 1), ':') - 1) || ':' ||
      COALESCE(NULLIF(symbol, ''), name) || ':' || as_of_date
)
INSERT INTO investment_positions_new (
  id,
  connector_id,
  source_id,
  asset_type,
  symbol,
  name,
  broker_no,
  broker_account,
  market,
  quantity,
  market_value,
  cash_balance,
  cost_basis,
  unrealized_pnl,
  currency,
  as_of_date,
  raw_payload,
  created_at,
  updated_at
)
SELECT
  old.id,
  old.connector_id,
  old.source_id,
  old.asset_type,
  old.symbol,
  old.name,
  parts.broker_no,
  parts.broker_account,
  CASE WHEN parts.id IS NOT NULL THEN 'TW' ELSE NULL END,
  old.quantity,
  old.market_value,
  old.cash_balance,
  NULL,
  NULL,
  old.currency,
  old.as_of_date,
  old.raw_payload,
  old.created_at,
  old.updated_at
FROM investment_positions old
LEFT JOIN tdcc_source_parts parts ON parts.id = old.id;

DROP TABLE investment_positions;
ALTER TABLE investment_positions_new RENAME TO investment_positions;

CREATE INDEX idx_investment_positions_page
  ON investment_positions (as_of_date DESC, asset_type ASC, name ASC, id ASC);
CREATE INDEX idx_investment_positions_latest_scope
  ON investment_positions (connector_id, asset_type, as_of_date DESC);
CREATE INDEX idx_investment_positions_identity_scope
  ON investment_positions (broker_no, broker_account, market, as_of_date DESC, updated_at DESC);
CREATE INDEX idx_investment_positions_asset_type
  ON investment_positions (asset_type);
CREATE INDEX idx_investment_positions_as_of_date
  ON investment_positions (as_of_date);
