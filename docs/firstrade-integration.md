# Firstrade 整合工作紀錄

## 2026-09-27：登入與唯讀投資同步

此整合以獨立功能分支向上游貢獻，不包含其他銀行實驗或產品品牌改動。

使用者有 Firstrade 帳戶，使用簡訊或 Email 驗證。先驗證登入、人工選擇 OTP 接收方式、單次送出 OTP、帳戶餘額及完整分頁持倉。程式未提供交易、下單、取消訂單或轉帳方法。

## 已取得的證據

- [Firstrade 官方 2FA 說明](https://help.firstrade.info/en/articles/9260184-two-factor-authentication-2fa)：登入需密碼及一次性驗證碼。未找到可據以宣稱官方公開開發者 API 的文件。
- [MaxxRK/firstrade-api](https://github.com/MaxxRK/firstrade-api)：明確標示非官方逆向介面。`firstrade/account.py` 及 `urls.py` 提供 `api3x.firstrade.com` 的登入、request_code、verify_pin、帳戶、餘額、持倉路徑與欄位。本原型依此觀察重新實作，未執行其下單範例。
- [Issue #85](https://github.com/MaxxRK/firstrade-api/issues/85)：有 401 回報，但維護者及另一位使用者回覆仍可使用。不能據此推論 token 已失效，也不能推論目前可登入。
- [morristai 的模型](https://github.com/morristai/firstrade/blob/36c3c3bdc3f2ff0e2b6f5537ccebc804e6458bf2/src/models/account.rs)：餘額欄位、持倉 page/pages/total 與小計的候選契約；社群範例不是本使用者的真實回應。

## 已做的保護與檢查

- 一個 client 只允許一次帳密登入；失敗不重送。OTP 僅由使用者按下寄送後送一次，驗證失敗清除本機狀態。
- 五分鐘本機 TTL；禁止跨站 redirect，請求限時二十秒。不保存帳密、session、完整回應或 OTP 至檔案。
- 本機頁綁定 loopback，檢查 Host、Origin、CSRF token；CSP、防嵌入及 no-store。
- 只輸出預先允許的欄位名稱、型別與陣列長度。核對數值只送回本機頁。
- 持倉依 page/pages 分頁，驗證帳號、總筆數與空白中途頁；不因第一頁成功就當作全部持倉。
- 沒有已驗證的登出路徑，僅清除本機憑證，不能宣稱伺服器已登出。
- 實際登入、寄送及 OTP 驗證已確認可省略 `remember_for`，不要求記住裝置。
- 正式設定中的帳密及短期 session 存於加密欄位；OTP 不持久化，cursor 只有同步時間。驗證狀態使用前先 CAS 消耗，帳密變更會清除狀態。
- 排程預設停用。排程 dispatch 不登入、不發 OTP，提示使用者手動驗證。
- 完整取得所有帳戶與持倉、每個帳戶總額核對成功後才原子寫入 D1。同日快照整批替換，已賣出部位不殘留；保留先前日期快照。設定版本不同時整批回滾。

## 資料範圍

支援 `sec_type = 1` 的美股／ETF 與美元現金。API 未提供已驗證的股票／ETF 細分類，介面先統一列在股票類別；保留代碼、商品名稱、數量、市值、成本及遮罩帳戶資訊。成本目前保留於正規化 raw metadata，既有資產頁尚無成本欄位。

現金使用 `cash_balance`，不使用 buying power。未取得獨立小計時，持倉市值加現金必須與 `total_account_value` 相符（容差為 max(0.05, (持倉筆數 + 2) × 0.005) 美元，涵蓋逐筆以美分四捨五入的誤差）；存在未涵蓋的融資／其他資產時拒絕整次寫入，不推算餘額。期權、債券等其他商品及交易歷史未接入。原幣保存 USD，資產與總覽沿用既有匯率換算。

## 下一步與驗收

首次真實登入取得的 `recipientId` 是數字，與社群 Python 型別註記不同，已修正並加回歸測試。第二次真實登入、OTP 寄送、OTP 驗證、帳戶清單、餘額及持倉查詢全部完成：一個帳戶、38 筆持倉。使用者已確認現金、帳戶總值、數量及市值與官方一致。未保存這些真實值，只保留欄位型別及筆數。

1. 執行 `node scripts/test-firstrade-local.mjs`，帳戶持有人在顯示的本機網址輸入帳密。
2. 選簡訊或 Email、寄送一次驗證碼、驗證及查詢；核對官方餘額與持倉。任何不明失敗停止，不重試帳密。
3. 正式網站：設定 → Firstrade 第一證券 → 儲存憑證 → 開始驗證 → 選擇接收方式 → 寄送驗證碼 → 驗證並同步。
4. 部署後另需核對 Cloudflare 執行、D1 正式寫入與資產頁顯示。本機 API 成功及合成 D1 測試不代表此步已完成。

程式包含 protocol self-check、正規化總額與穩定 ID 測試、D1 原子替換／失敗保留／設定變更 guard、排程無網路操作及前端 OTP 流程測試。2026-09-28 已在個人 Cloudflare 部署驗收，使用者確認股票／ETF 與美元現金，資產清冊可見且同步狀態正常。

## Cloudflare 執行環境

原生 fetch 必須綁定 globalThis；Workers 不支援 redirect:error，使用 manual 並拒絕非 2xx 回應，禁止跟隨重新導向轉送憑證。本機 workerd 測試直接打包 API client，使用合成回應驗證啟動、登入與重新導向拒絕。

## 核對失敗的恢復

2026-09-28：只有已驗證的總額核對失敗，會在同一工作階段重新讀取一次帳戶、餘額與完整持倉；不重送帳密或 OTP。第二次仍不符即保留上次完整快照，介面顯示差額、持倉筆數與容差，明確區分資料核對與登入失敗。分頁總頁數須一致，非空清單不能宣稱零頁。容差修正與一次重新查詢不代表已定位本次正式帳戶差額；後續已以去識別化真實回應核對，結果見下節。未知商品仍須先確認欄位及負債語意，不用差額冒充現金或假造資產。

## 不同報價來源

[Firstrade 官方 2026-06-03 說明](https://help.firstrade.info/en/articles/10944976-new-positions-and-balance-changes) 明確指出餘額與持倉頁使用不同報價來源，沒有交易也可能有市值差。因此跨頁總額差異不能單獨判定資料損毀。

當持倉明細對上 positions 的 `total_market_value`，且 balances 的 `cash_balance + long_stock_value` 對上 `total_account_value`，且 `margin_balance`、`long_option_value`、`short_option_value` 若提供均為數字零時，允許兩來源估值不同。每頁小計若變動則同一登入重新查詢一次；現金帳戶回應可省略上述三個選用欄位；不將缺省欄位填成金融金額。核心現金、股票餘額、帳戶總值及持倉小計仍須存在且核對一致。美元現金和每筆持倉維持原值，不把差額補進現金。cash 記錄 raw 保存券商總值、明細合計、差額及估值說明，同步回應 warnings 與設定頁呈現報價差異。融資、期權及未支援商品仍不以這個例外放行；它們需要各自確認會計契約。

## 真實回應核對：2026-09-28

去識別化核對確認：持倉明細對上持倉小計，股票餘額加現金對上帳戶總值，但兩份股票估值不同。回應省略 margin_balance、long_option_value、short_option_value；先前 schema 強制三者存在且等於零，造成誤擋。改為選用的數字零，明確非零、null 或錯誤型別仍拒絕。保留 synthetic 回歸資料，不保存使用者原始金額或帳號。

本機核對頁透過 scripts/lib/firstrade-diagnostics.mjs 輸出欄位存在性、正負號及各種加總是否一致，不輸出原始金額、帳號與股票代碼。登入與 OTP 仍由使用者完成，帳戶值只送回本機頁面。該缺省欄位修正已完成個人正式部署與人工同步驗收。
