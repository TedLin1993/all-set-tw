# 中信獨立測試部署

本流程用於外幣活存餘額與限定範圍信用卡的驗收。請使用全新 Worker、D1、Queue、Access Application 與加密金鑰，不複製正式資料或憑證。

## 固定範圍

- 全部回傳外幣活存帳戶／幣別的餘額與可用餘額，包含近期沒有交易及零餘額。
- 最新一期 TWD 已結帳帳單與完整明細、當期 TWD 未出帳、目前即時授權及必要分頁。
- 不查台幣／外幣存款交易、定存、其他信用卡帳期或幣別。
- 只允許中信設定與手動同步。無 Cron，拒絕其他寫入，Queue 丟棄非手動訊息。
- 強制關閉 Demo、本機免驗證與 relay；Access JWT 驗證仍啟用。

測試入口為 `apps/worker/src/ctbc-balance-test-entry.ts`，與一般入口分開。API 回覆帶 `X-All-Set-TW-Test-Scope: ctbc-foreign-balances-and-twd-cards`。

## 步驟

1. 使用 `wrangler.ctbc-balance-test.json.example` 建立被 Git 忽略的 `wrangler.ctbc-balance-test.json`。
2. 確認模板的測試名稱未被其他用途占用，建立全新的 Worker、D1、Queue。不要連結正式資料庫或自動部署來源。
3. 對新 Worker 啟用 Access All traffic，建立僅允許測試者的政策及專用 Application／AUD。
4. 產生新的隨機 `CONFIG_ENCRYPTION_KEY`，加上新應用的 `TEAM_DOMAIN`、`POLICY_AUD`。不要用 `auto`，也不要複製正式秘密。後續部署保留該金鑰，不可重新產生覆蓋。
5. 填入新 D1 UUID，執行隔離檢查；它只驗證設定形狀，仍須唯讀核對遠端資料庫名稱及 ID。

   ```sh
   node scripts/check-ctbc-balance-test-config.mjs wrangler.ctbc-balance-test.json
   ```

6. 僅對新測試 D1 套用現有 migrations，沒有本次新增的 schema migration。

   ```sh
   XDG_CONFIG_HOME=.wrangler-config node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config wrangler.ctbc-balance-test.json
   ```

7. 建置與部署時避免一般部署腳本的資源管理及遠端遷移 hook：

   ```sh
   npm run build -w @taiwan-fin-hub/web --ignore-scripts
   XDG_CONFIG_HOME=.wrangler-config node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config wrangler.ctbc-balance-test.json --outdir dist/ctbc-balance-test
   XDG_CONFIG_HOME=.wrangler-config node node_modules/wrangler/bin/wrangler.js deploy --config wrangler.ctbc-balance-test.json
   ```

8. 確認實際綁定只有新測試 D1／Queue／Assets，無 Cron、preview URLs 或 observability；未登入首頁與 API 均須被 Access 阻擋，才可輸入銀行資料。
9. 測試者自行輸入銀行憑證及完成 App 核准。只在測試站手動同步，不代替測試者操作銀行驗證。

銀行端唯讀不代表本機或測試 D1 不保存資料：測試站會保存正規化金融資料與加密設定，原始銀行回應不保存。勿匯出資料庫、HAR、原始 payload 或含帳務內容的截圖供除錯。

## 驗收與回復

逐一私下核對原幣餘額、幣別、卡片標示、交易日期／方向、已入帳／待入帳，以及重複同步後帳戶、帳單、負債與交易是否重複。折合台幣匯率及時間差異須另行判斷；近期無交易不應讓餘額消失。

目前有限實測及缺口見[外幣研究](ctbc-foreign-deposits.md)與[信用卡研究](ctbc-credit-card-details.md)。合成測試不能取代真實帳務逐筆核對。

停止手動同步並等待已排隊工作結束即可停止新銀行查詢。需要回復時只回復測試 Worker 的前一部署，保留 Access；本次無 schema migration。清除測試資源及資料須由擁有者另行確認。不可為修復測試站而改綁正式 D1。
