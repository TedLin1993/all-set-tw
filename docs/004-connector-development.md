# Connector 開發規範

本文件定義 Taiwan Fin Hub 新增與維護 connector 的共同流程。目標是讓 connector 的識別資訊、設定欄位、同步執行、敏感狀態、前端表單與測試保持同步，避免只完成其中一層便上線。

## 共同註冊點

Connector 採三層 registry：

| 層級            | 位置                                                                      | 責任                                                  |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| 共用 catalog    | `packages/core/src/index.ts` 的 `connectorCatalog`                        | ID、顯示名稱、連接模式、scope、資料能力、設定欄位分類 |
| Config registry | `packages/connectors/src/index.ts` 的 `connectorConfigSchemas`            | Zod schema 與設定解析                                 |
| Worker runtime  | `apps/worker/src/features/sync/registry.ts` 的 `connectorRuntimeRegistry` | 手動／排程同步與互動式 challenge handler              |

三個 registry 都必須以 `Record<ConnectorId, ...>` 宣告。新增 `ConnectorId` 後，TypeScript 應立即指出尚未補齊的 config 或 runtime。

前端資料來源名稱由 `connectorCatalog` 產生；表單欄位 key 必須符合 catalog 宣告的 credential 或 public field，不得使用未受型別限制的任意字串。

## 連接模式

新增 connector 前先選擇最接近的連接模式：

| Mode                      | 適用情境                                                 | 現有範例                   |
| ------------------------- | -------------------------------------------------------- | -------------------------- |
| `api_credentials`         | 帳密登入外部 API，可自行更新 token                       | 電子發票、中信、新光       |
| `api_captcha_session`     | App API 登入含 CAPTCHA，challenge 僅短暫加密保存         | 王道銀行                   |
| `api_device_otp`          | API 登入，首次裝置需要 OTP                               | 集保 e 存摺                |
| `browser_per_sync`        | 每次同步都必須以 Browser 登入與擷取                      | 國泰世華                   |
| `browser_session`         | Browser 只負責登入，後續使用可復用的 HTTP session        | 玉山                       |
| `browser_captcha_session` | Browser 登入含 CAPTCHA，可由 AI 或人工完成並復用 session | 永豐、台新、華南、第一銀行 |

不要為單一銀行建立新的通用框架。只有登入生命週期真的不同時才新增 mode，並同時補上 catalog 說明及共同測試。

## 設定與狀態分級

每個欄位只能有一個權威儲存位置：

| 狀態           | 儲存位置                         | 允許內容                                                     |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| 公開偏好       | `public_config`                  | 使用者可調整、且不影響敏感狀態的 connector 偏好              |
| 機密設定       | `encrypted_config`               | 帳密、cookie、access token、device token、Browser session ID |
| 同步 cursor    | `sync_cursor`                    | 日期、頁碼、watermark、已完成區間等非敏感增量位置            |
| 暫時 challenge | `encrypted_config`，且必須有 TTL | CAPTCHA、OTP、待提交的 API／Browser session                  |

強制規則：

- `sync_cursor` 不得包含 cookie、token、OTP 或任何可恢復登入狀態的資料。
- Connector 可在內部 cursor 回傳 session，但 sync service 必須透過 `splitConnectorCursorState` 將 secret state 移入加密設定後才持久化。
- 舊版已存在於 cursor 的 session 不得直接由 D1 migration 刪除；應讓新版 connector 相容讀取一次，並在首次成功同步時搬入 `encrypted_config`，避免強迫使用者重新驗證。
- 公開設定透過 `parsePublicConnectorConfig` 合併後再交給 config schema；不得把相同欄位複製到 encrypted config。
- 同步回溯範圍是 connector 的 runtime policy，不得做成公開偏好：電子發票固定同步最近 2 期；銀行 connector 固定同步最近 3 個月或 3 期帳單。舊版 `periodsBack` 與 `lookbackMonths` 必須忽略並在後續設定儲存時移除。
- 電子發票品項明細是固定同步 policy，不是公開偏好：不得新增 `fetchDetails` catalog field、前端 checkbox 或 sync request override。既有 `public_config.fetchDetails` 在 migration 與下一次設定儲存時必須移除。
- 任一 credential 變更時，必須清除 catalog `resetOnCredentialChangeFields` 宣告的衍生狀態與既有 cursor。
- Challenge 成功、失敗或逾時後都必須清除 CAPTCHA、OTP 與 Browser session reference。
- Log、錯誤回應與 `raw` 不得包含帳密、完整帳號／卡號、cookie 或 token。

## Config schema

每個 connector 在 `packages/connectors` 提供：

1. `<connectorId>ConfigSchema`。
2. `<ConnectorId>Config` inferred type。
3. `parse<ConnectorId>Config`。
4. `connectorConfigSchemas` registry entry。

Schema 需要涵蓋同步期間會持久化的 secret state，否則 Zod parse 會將欄位移除。使用者可不填、但正式同步必要的 credential 可以在 schema 宣告 optional，再由 sync use case 回傳明確的 `NeedsUserActionError`。

## Connector 與 Worker 邊界

`packages/connectors` 可包含：

- 外部 API client。
- Signing、encryption、protocol parsing。
- Config schema 與 response normalization。
- 不依賴 Worker binding 的 connector。

`apps/worker/src/connectors` 只放需要下列 runtime object 的 adapter：

- `BROWSER`、Puppeteer page 或 browser lifecycle。
- `AI` CAPTCHA recognition。
- Worker-specific session acquisition 或 capacity handling。

Connector 不得依賴 Hono、D1、Worker `Env`，也不得直接寫入資料庫。

所有 Browser adapter 建立新瀏覽器時，統一呼叫
`apps/worker/src/connectors/browser.ts` 的 `launchBrowserWithRetry`，不得直接呼叫
`puppeteer.launch`。共用 adapter 在 binding `fetch` 層僅針對建立瀏覽器的
`POST /v1/devtools/browser` 請求依 HTTP status `503` 判斷重試，不比對錯誤文案。
預設等待 2 秒、5 秒後重試，
最多嘗試 3 次；耗盡後保留原始錯誤，交由既有同步失敗流程處理。結構化 log
只記錄狀態碼、嘗試次數與重試延遲。`429` 額度／限流錯誤維持既有處理，
session 重連、瀏覽器建立後的操作與銀行登入不在此重試範圍內。

## 正規化資料契約

- Connector 回傳 `SyncResult`，資料必須符合 `@taiwan-fin-hub/core`。
- `sourceId` 必須在重複同步間穩定。一般交易不得使用本次同步時間產生 ID。
- `BankBalanceSnapshot.accountId`、`BankTransaction.accountId` 與 `CreditCardBill.accountId` 必須等於對應 `BankAccount.sourceId`。
- 日期使用 ISO 8601；帳單期間使用 `YYYY-MM`；幣別使用大寫代碼。
- `BankTransaction.authorizedAt` 與 `Invoice.invoiceDate`：來源只有日期時使用 `YYYY-MM-DD`；來源確實提供時間時使用含明確時區的 ISO timestamp。不得以補上的午夜或同步時間假造交易時間；台灣來源未標時區的交易時間以 `+08:00` 解讀。
- 補充交易時間時須保留既有 `sourceId` 算法；`postedDate` 維持入帳日期用途。未入帳轉已入帳或重新同步只提供日期時，須保留同筆交易原有的可靠時間。
- 支出與負債為負，退款與入帳為正。
- `raw` 只能保留遮罩或白名單資料，主要功能不得依賴 raw shape。
- 一般 connector 的資料必須經 `record-mapper.ts` 與 staged persistence；durable-run
  connector 可直接以其 run item table 作為 staging source。資料 promotion 與 cursor
  必須放在同一 guarded D1 batch，secret state 需以設定版本 CAS 保護。

永豐信用卡取得 `LatestTx.Items` 與 `OutstandingDetail.Detail` 後，在 `bank_transactions`
原表保存授權，以 `matched_transaction_id` 記錄已入帳關係，不另設授權表或停用欄位。
配對僅限同卡、同消費日，不跨日；排除手續費、服務費、不同金額方向與卡片識別不足的資料。
既有相同 sourceId 優先，其次同幣別同金額，再以正規化店名相似度及目前匯率金額接近度
計分；同組採最大總分的一對一分配，無合理候選則不配對。跨幣別不要求人工確認。
已配對關係不重新分配；已入帳保留正式金額、幣別、入帳日與原始 payload，繼承授權時刻。
配對後優先沿用待入帳名稱作為 description 與 counterparty，供顯示、搜尋及規則分類；
空白或預設「永豐信用卡消費」名稱不覆蓋正式名稱。每次同步也修復既有配對，即使銀行
不再回傳該交易；同 ID 入帳沿用已保存名稱。舊版已覆蓋且來源不再提供的名稱無法復原。
在同一 D1 batch upsert 交易、保存配對、補入時刻，並於首次配對移轉原授權的個別分類、
計算偏好（已入帳既有設定優先）及發票關係。原授權與設定持續保存。
活動、搜尋、發票配對候選與收支統計僅排除 `status = 'pending'` 且
`matched_transaction_id IS NOT NULL` 的授權；同 ID 升為已入帳仍正常顯示。
不處理來源消失：未配對授權即使來源不再回傳，仍保留並顯示；空清單不刪除或隱藏資料。
缺少清單或解析失敗不寫入；無有效卡與舊版解析不執行授權配對。
已在舊版永久刪除的授權，若來源不再回傳，無法從此變更復原。

### 中信信用卡明細與配對

中信帳單的消費日、入帳日、結帳日及繳款期限使用 `MMDDYY`；未出帳明細使用
`YYYYMMDD`，金額與商家欄位為 `purchaseAmt`、`description`。`000000` 不代表有效日期。
非零已入帳明細若無法解析日期或金額，整次同步失敗，避免靜默遺漏或寫入無日期交易。

配對要求同卡末四碼、同幣別及同方向金額，且雙向唯一；雙方都有消費日時才再要求同日，
一方缺少消費日（例如修正日期前的無日期帳單）則不因此拒絕。雙方都有授權碼時
比對其 SHA-256 摘要，缺少授權碼的舊紀錄才退回正規化商家名稱比對。不同授權碼、
不同消費日、缺少卡片或多候選不配對，不跨幣別推估。原始授權碼及交易參考號不寫入
`raw`，只保存摘要。同一次回傳內配對成功時，可見列沿用待入帳 identity，名稱改用已入帳。

中信同步會比對本次資料與已保存的授權。配對成功後可見列為待入帳原列：升為已入帳並
沿用其 ID、消費時間與使用者設定；名稱、入帳日與正式金額改用已入帳明細，再刪除已入帳
重複列。待入帳若已有分類且不是未分類，保留待入帳分類；待入帳未分類則沿用已入帳分類。
計算偏好與發票以待入帳既有設定優先，沒有時才從已入帳補上。先前以
`matched_transaction_id` 隱藏待入帳的舊配對，下次中信同步會改為此合併。
修正日期前的無日期帳單紀錄，僅在銀行再次回傳且舊 identity 可唯一對應時先修復該列；
若同時有唯一待入帳可配對，仍改以待入帳 ID 為準。無法唯一修復則不寫入本次同步。
銀行已不再回傳的舊明細無法藉此還原日期。同筆交易改由其他明細回傳時仍沿用既有 ID；
待入帳回應不會將已入帳降回待入帳。

## 路由、排程與 challenge

- 一般同步使用 `runConnectorSync`，不要在 route 或 scheduler 新增 connector switch。電子發票與集保的手動／排程入口使用各自的 durable-run service 啟動 Queue 流程。
- 所有 scope 必須先宣告在 `connectorCatalog`；排程工作目前固定使用 `all`。
- 同一 connector 的所有 scope 共用 canonical lock。
- 需要 CAPTCHA／OTP 時，runtime registry 提供 `prepareChallenge`，route 只處理輸入驗證與 HTTP error mapping。
- 排程不得主動寄送 OTP；需要互動時標記 `needs_user_action`。
- 若外部服務支援接管其他登入中的裝置，必須明確定義手動與排程的 `force` policy，並在介面與使用文件提示可能中斷使用者目前的工作階段。
- 新 connector 必須透過 D1 migration 建立 `<connectorId>:all` sync job，預設停用。

### 集保分段同步

集保與電子發票同樣使用 durable run。手動與排程入口呼叫 `startTdccSyncRun`，
並 enqueue `run-tdcc-chunk`，不以一般單次同步流程取代分段處理。

- `tdcc_sync_runs` 保存 run lifecycle、scope、設定版本及加密認證／session；
  `tdcc_sync_run_items` 保存 `bank_page`、`trade_page` 工作與結果。
- 手動啟動先初始化登入以處理 OTP；排程初始化不主動寄送 OTP。
- 同一 connector 的所有 scope 共用 active run 限制與 canonical lock；每個 chunk
  另取得 owner-scoped run lease，每次最多 claim 一個分頁 item，以 claim token
  更新或釋放該 item，尚有工作時 enqueue continuation。
- 分頁結果完成後彙整，透過一般 staging 與 promotion 寫入金融資料，並檢查設定版本、
  更新 cursor；後續完成排程結果、手動完整同步的報告修復與 run 結案。
- 暫時錯誤交給 Queue retry；需要互動或重試耗盡時終止。不得把每段 run lease 的
  釋放當成整個 connector 同步完成。

詳細流程與檔案責任參考[後端架構](002-backend-architecture.md#集保分段同步)。

### 電子發票分段明細同步

電子發票是例外的 durable-run connector，不能使用一般 `runConnectorSync` 的單次
同步流程。`einvoice_sync_runs` 保存 run lifecycle，`einvoice_sync_run_items` 保存
已發現的發票 header 與每張明細的處理狀態；run items 本身也是 promotion 的 durable
staging source。設定儲存、登入 session 與資料 promotion 仍遵守本文件的敏感狀態與
設定版本 CAS 規則。

- 啟動手動或排程同步時只建立／取得 active run 並 enqueue `run-einvoice-chunk`；API
  可以回傳已排入同步，前端必須依 sync job lifecycle 顯示完成結果。
- 初始化只取得清單並 durable 地寫入 item；明細一律同步。每個 Queue invocation 最多
  claim 並擷取 35 張發票，完成狀態以 set-based D1 寫入；若尚有工作便 enqueue continuation，不能在同一 invocation
  繼續處理下一批。
- item claim、run chunk 都必須使用 owner-scoped lease；明細處理期間每五張 rolling renew
  run lease，item 完成／釋放則以 claim token CAS。Queue 重送時只可接管已過期的 run lease
  與 item，且不得解除其他 invocation 的 lease。
- 所有 item `done` 前不得 promotion。完成後由 run items 以固定五個 set-based statements
  一次 promotion invoice 與 line item，並以設定版本 CAS 在同一 batch 更新 cursor；後續
  finalize path 更新 sync job 和排程批次結果。`promoted_at` 必須使重送可冪等。
- 暫時外部錯誤釋放 item claim 並使用 Queue retry；session 過期清除已保存 session 後回到
  初始化；憑證或互動式登入需求則標記 `needs_user_action`，retry 上限後標記 `failed`。

## 測試最低要求

每個 connector 至少需要：

1. Config schema 正常與錯誤案例。
2. 外部 response fixture parser 測試。
3. Stable `sourceId` 與重複同步去重測試。
4. 金額方向、日期與 pending／posted lifecycle 測試。
5. Session 復用、失效、credential change cleanup 測試。
6. OTP／CAPTCHA／rate limit 等 typed error 測試（適用時）。
7. Route manual sync 與 scheduler dispatch 測試。
8. Cursor 不含 secret、encrypted config 不含 public field 的 state boundary 測試。
9. Synthetic self-check，並接入 `test:selfcheck` 或正式 test command。

`apps/worker/tests/features/sync/registry.test.ts` 會檢查 catalog、config schema 與 Worker runtime 是否完整；不得以 type assertion 或 fallback entry 規避。

## 新增流程

1. 在 `connectorCatalog` 加入 ID、mode、scope、capabilities 與欄位分類。
2. 在 `packages/connectors` 建立 config、client、parser 與 config registry entry。
3. 需要 binding 時，在 `apps/worker/src/connectors` 建立 adapter。
4. 在 sync service 實作 normalized result、record mapping 與 staged persistence。
5. 在 Worker runtime registry 註冊 sync／challenge handler。
6. 在前端新增受 `ConnectorFormFieldKey` 約束的表單欄位與必要 challenge UI。
7. 新增 sync job migration。
8. 完成上述最低測試並更新 `README.md` 支援資料來源表。
9. 執行：

```bash
npm run typecheck
npm run test:backend
npm run verify:web
npm run build
```

若新增的是全新資料 entity，還必須同步更新 core contract、D1 migration、`SyncEntityType`、promotion order、entity config、record mapper 與 persistence test。

## 王道定存生命週期

王道公開網頁的 [FAO01012 controller](https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/html/FAO/FAO01012.js) 以 `repeats` 建立完整存單選擇器，再以 `tdAccountNumber` 查詢各筆 `tdDetail`；[頁面欄位](https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/html/FAO/FAO01012_010.html) 使用 `contractDate`（起息日）與 `maturityDate`（到期日）。連接器沿用清單的帳戶識別碼與餘額，明細只補日期，不保存完整存單號碼。

- 僅完整清單及逐筆明細全部成功後，才撤下未再出現的定存。缺少清單、明細不符或解析不完整時整次同步失敗；明確空陣列可撤下全部舊定存。
- `inactive_at` 是確認來源不再列出存單的時間，不是實際結清日。同期寫入零餘額快照，與狀態變更一同提交；保留之前的餘額歷史。到期日不作為自動結清條件，來源重新列出時恢復有效。
- 成立活動須有銀行起息日及唯一的同幣別活存扣款；本金轉回須有前次有效快照、存單消失與其間唯一的活存本金入帳。同幣別有多個活存帳戶、同額候選不唯一、同日無法判定先後或本金利息合併入帳時，不推算活動。
- 衍生活動以 `transfer_peer_id` 綁定該活存交易，優先一對一配對；定存不參加一般同額配對。本金排除收支，另筆利息保留原有分類及計算。缺少來源日期或交易證據的歷史資料不自動補造。
- 本地 migration 與 fixture 測試不代表真實銀行同步成功；部署 migration 後仍須一次實際同步取得日期與更新有效清單。

## 電子發票歷史身分整併

Migration `0043_merge_legacy_invoice_duplicates.sql` 以相同發票號碼整併歷史資料，
優先保留新版 UTC ID；同號碼的其他副本會刪除。
缺少的品項明細與人工配對／解除配對設定會移至保留資料；品項或人工設定衝突時
以保留資料為準。此 migration 不改變同步協定或新資料的 ID 產生方式。
