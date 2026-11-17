-- 同步報告先前沒有套用集保／永豐的成交去重：同一筆成交會被兩個來源各列為新增。
-- 規則與 src/db/investment-transactions.ts 的 supersededTdccTradeSql 相同：集保買進（113）
-- 或賣出（123）與永豐成交在同券商帳戶、標的、幣別、股數、買賣方向與成交日（集保有民國年
-- 與西元兩種日期格式）都相同，而且永豐那筆也在報告的變化紀錄裡時，只保留永豐；永豐未列入報告的成交
-- （例如首次回補）保留集保那筆。先扣新增筆數，再刪展示快照與變化紀錄。
UPDATE scheduled_sync_batch_results AS result
SET new_investment_transactions = MAX(0, new_investment_transactions - (
  SELECT COUNT(*) FROM sync_activity_changes change
  JOIN sync_activity_runs run ON run.id = change.run_id
  JOIN investment_transactions tdcc ON tdcc.id = change.record_id
  WHERE run.batch_id = result.batch_id AND run.connector_id = result.connector_id
    AND change.entity_type = 'investment_transaction'
    AND tdcc.connector_id = 'tdcc'
    AND tdcc.transaction_code IN ('113', '123')
    AND EXISTS (
      SELECT 1 FROM investment_transactions direct
      WHERE direct.connector_id = 'sinotrade'
        AND direct.broker_no = tdcc.broker_no
        AND direct.broker_account = tdcc.broker_account
        AND direct.symbol = tdcc.symbol
        AND direct.currency = tdcc.currency
        AND direct.quantity = tdcc.quantity
        AND direct.transaction_code = CASE tdcc.transaction_code WHEN '113' THEN 'B' WHEN '123' THEN 'S' END
        AND substr(direct.trade_date, 1, 10) = CASE
          WHEN tdcc.trade_date GLOB '0[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
          THEN printf('%04d', CAST(substr(tdcc.trade_date, 1, 4) AS INTEGER) + 1911) || substr(tdcc.trade_date, 5, 6)
          ELSE substr(tdcc.trade_date, 1, 10)
        END
        AND EXISTS (
          SELECT 1 FROM sync_activity_changes reported
          WHERE reported.entity_type = 'investment_transaction' AND reported.record_id = direct.id
        )
    )))
WHERE connector_id = 'tdcc' AND new_investment_transactions > 0;

DELETE FROM sync_activity_details
WHERE activity_id LIKE 'investment:%'
  AND EXISTS (
    SELECT 1 FROM investment_transactions tdcc
    WHERE tdcc.id = substr(sync_activity_details.activity_id, 12)
    AND tdcc.connector_id = 'tdcc'
    AND tdcc.transaction_code IN ('113', '123')
    AND EXISTS (
      SELECT 1 FROM investment_transactions direct
      WHERE direct.connector_id = 'sinotrade'
        AND direct.broker_no = tdcc.broker_no
        AND direct.broker_account = tdcc.broker_account
        AND direct.symbol = tdcc.symbol
        AND direct.currency = tdcc.currency
        AND direct.quantity = tdcc.quantity
        AND direct.transaction_code = CASE tdcc.transaction_code WHEN '113' THEN 'B' WHEN '123' THEN 'S' END
        AND substr(direct.trade_date, 1, 10) = CASE
          WHEN tdcc.trade_date GLOB '0[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
          THEN printf('%04d', CAST(substr(tdcc.trade_date, 1, 4) AS INTEGER) + 1911) || substr(tdcc.trade_date, 5, 6)
          ELSE substr(tdcc.trade_date, 1, 10)
        END
        AND EXISTS (
          SELECT 1 FROM sync_activity_changes reported
          WHERE reported.entity_type = 'investment_transaction' AND reported.record_id = direct.id
        )
    ));

DELETE FROM sync_activity_changes
WHERE entity_type = 'investment_transaction'
  AND EXISTS (
    SELECT 1 FROM investment_transactions tdcc
    WHERE tdcc.id = sync_activity_changes.record_id
    AND tdcc.connector_id = 'tdcc'
    AND tdcc.transaction_code IN ('113', '123')
    AND EXISTS (
      SELECT 1 FROM investment_transactions direct
      WHERE direct.connector_id = 'sinotrade'
        AND direct.broker_no = tdcc.broker_no
        AND direct.broker_account = tdcc.broker_account
        AND direct.symbol = tdcc.symbol
        AND direct.currency = tdcc.currency
        AND direct.quantity = tdcc.quantity
        AND direct.transaction_code = CASE tdcc.transaction_code WHEN '113' THEN 'B' WHEN '123' THEN 'S' END
        AND substr(direct.trade_date, 1, 10) = CASE
          WHEN tdcc.trade_date GLOB '0[0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
          THEN printf('%04d', CAST(substr(tdcc.trade_date, 1, 4) AS INTEGER) + 1911) || substr(tdcc.trade_date, 5, 6)
          ELSE substr(tdcc.trade_date, 1, 10)
        END
        AND EXISTS (
          SELECT 1 FROM sync_activity_changes reported
          WHERE reported.entity_type = 'investment_transaction' AND reported.record_id = direct.id
        )
    ));
