import { sql } from "drizzle-orm";

/**
 * 集保的交易日有民國年（`0YYY-MM-DD…`）與西元兩種格式；換成 YYYY-MM-DD 才能與其他來源比對。
 */
const tradeDay = (column: string) => `CASE
  WHEN ${column} GLOB '0[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
  THEN printf('%04d', CAST(substr(${column}, 1, 4) AS INTEGER) + 1911) || substr(${column}, 5, 6)
  ELSE substr(${column}, 1, 10)
END`;

/**
 * 集保的買進（113）與賣出（123）若與永豐的成交對得上，就是同一筆交易：同券商帳戶、標的、
 * 幣別、股數、買賣方向與成交日。永豐那筆有成交價、費稅與損益，所以隱藏集保這筆。
 * 券商帳戶、日期或代碼不完整時 NULL 比較不成立，不會猜測配對；集保獨有的交易
 * （例如分割轉入／轉出）與永豐沒有的區間維持顯示。外層資料表以原名 investment_transactions 引用。
 */
export const SUPERSEDED_TDCC_TRADE_SQL = `investment_transactions.connector_id = 'tdcc'
  AND investment_transactions.transaction_code IN ('113', '123')
  AND EXISTS (
    SELECT 1 FROM investment_transactions direct
    WHERE direct.connector_id = 'sinotrade'
      AND direct.broker_no = investment_transactions.broker_no
      AND direct.broker_account = investment_transactions.broker_account
      AND direct.symbol = investment_transactions.symbol
      AND direct.currency = investment_transactions.currency
      AND direct.quantity = investment_transactions.quantity
      AND direct.transaction_code = CASE investment_transactions.transaction_code
        WHEN '113' THEN 'B' WHEN '123' THEN 'S' END
      AND ${tradeDay("direct.trade_date")} = ${tradeDay("investment_transactions.trade_date")}
  )`;

/** 排除已由永豐取代的集保買賣；外層查詢必須直接從 investment_transactions 取列。 */
export function isNotSupersededInvestmentTransaction() {
  return sql`NOT COALESCE(${sql.raw(SUPERSEDED_TDCC_TRADE_SQL)}, 0)`;
}
