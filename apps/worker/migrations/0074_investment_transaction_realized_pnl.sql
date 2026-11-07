-- 投資交易補上來源提供的已實現損益。只有賣出且來源有完整買進成本時才有值；
-- 買進與來源沒有成本的賣出維持 NULL，不能轉成 0。
ALTER TABLE investment_transactions ADD COLUMN realized_pnl REAL;
