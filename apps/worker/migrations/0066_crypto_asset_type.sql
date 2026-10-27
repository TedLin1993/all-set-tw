-- 加密貨幣交易所持倉使用 asset_type = 'crypto'。SQLite 無法修改 CHECK，
-- 依 0044 的方式重建 investment_positions 並保留既有資料與索引。
CREATE TABLE investment_positions_new (
  id TEXT NOT NULL PRIMARY KEY,
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stock', 'etf', 'fund', 'crypto')),
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
);

INSERT INTO investment_positions_new (id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at)
SELECT id, connector_id, source_id, asset_type, symbol, name, quantity, market_value, cash_balance, currency, as_of_date, raw_payload, created_at, updated_at FROM investment_positions;

DROP TABLE investment_positions;

ALTER TABLE investment_positions_new RENAME TO investment_positions;

CREATE INDEX idx_investment_positions_page
  ON investment_positions (as_of_date DESC, asset_type ASC, name ASC, id ASC);
CREATE INDEX idx_investment_positions_latest_scope
  ON investment_positions (connector_id, asset_type, as_of_date DESC);
CREATE INDEX idx_investment_positions_asset_type
  ON investment_positions (asset_type);
CREATE INDEX idx_investment_positions_as_of_date
  ON investment_positions (as_of_date);
