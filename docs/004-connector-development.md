# Connector 開發規範

本文件定義 Taiwan Fin Hub 新增與維護 connector 的共同流程。目標是讓 connector 的識別資訊、設定欄位、同步執行、敏感狀態、前端表單與測試保持同步，避免只完成其中一層便上線。前半段是共通規範與新增流程，各來源的特殊行為集中在文末。

## 共同註冊點

Connector 採三層 registry：

| 層級            | 位置                                                                      | 責任                                                  |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| 共用 catalog    | `shared/connector-catalog.ts` 的 `connectorCatalog`                       | ID、顯示名稱、連接模式、scope、資料能力、設定欄位分類 |
| Config registry | `apps/worker/src/sources/config-registry.ts` 的 `connectorConfigSchemas`  | Zod schema 與設定解析                                 |
| Worker runtime  | `apps/worker/src/features/sync/registry.ts` 的 `connectorRuntimeRegistry` | 手動／排程同步與互動式 challenge handler              |

`ConnectorId` 由 `connectorCatalog` 的 key 推得；catalog 每筆 `id` 必須與 key 相同。Config 與 Worker runtime registry 都必須以 `Record<ConnectorId, ...>` 宣告，新增 catalog 項目後，TypeScript 應立即指出尚未補齊的 config 或 runtime。

各來源的同步、connector、protocol、API client 與專用配對／修復集中於 `apps/worker/src/sources/<connectorId>`。電子發票與集保使用該目錄的 `sync.ts`／`run-repository.ts` 執行 Queue 分段同步；runtime registry 的 `run` 拒絕單次呼叫，避免繞過 durable run 的進度與鎖。手動同步控制、排程、報告與共用資料寫入仍位於 `features/sync`。

前端資料來源名稱與顯示順序由 `connectorCatalog` 產生；表單欄位 key 必須符合 catalog 宣告的 credential 或 public field，不得使用未受型別限制的任意字串。新增 connector 應加在 catalog 末尾。

## 連接模式

新增 connector 前先選擇最接近的連接模式：

| Mode                      | 適用情境                                                 | 現有範例                         |
| ------------------------- | -------------------------------------------------------- | -------------------------------- |
| `api_credentials`         | 帳密登入外部 API，可自行更新 token                       | 電子發票、中信、新光             |
| `api_captcha_session`     | App API 登入含 CAPTCHA，challenge 僅短暫加密保存         | 王道、兆豐銀行                   |
| `api_device_otp`          | API 登入，首次裝置需要 OTP                               | 集保 e 存摺                      |
| `browser_per_sync`        | 每次同步都必須以 Browser 登入與擷取                      | 國泰世華                         |
| `browser_session`         | Browser 只負責登入，後續使用可復用的 HTTP session        | 玉山                             |
| `browser_captcha_session` | Browser 登入含 CAPTCHA，可由 AI 或人工完成並復用 session | 永豐、台新、華南、第一銀行、凱基 |

不要為單一銀行建立新的通用框架。只有登入生命週期真的不同時才新增 mode，並同時補上 catalog 說明；新增核心風險時才擴充共同測試。

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

每個 connector 在 `apps/worker/src/sources/<connectorId>/protocol.ts` 提供設定 schema 與解析，並在 `sources/config-registry.ts` 註冊：

1. `<connectorId>ConfigSchema`。
2. `<ConnectorId>Config` inferred type。
3. `parse<ConnectorId>Config`。
4. `connectorConfigSchemas` registry entry。

Schema 需要涵蓋同步期間會持久化的 secret state，否則 Zod parse 會將欄位移除。使用者可不填、但正式同步必要的 credential 可以在 schema 宣告 optional，再由 sync use case 回傳明確的 `NeedsUserActionError`。

## Protocols 與 Worker adapter 邊界

同一來源目錄保留明確的責任邊界。`protocol.ts` 與純 API client 可包含：

- 外部 API client。
- Signing、encryption、protocol parsing。
- Config schema 與 response normalization。
- 不依賴 Worker binding 的 connector。

來源的 `connector.ts` 放需要下列 runtime object 的 adapter；只使用純 HTTP client 的來源不必建立這個檔案：

- `BROWSER`、Puppeteer page 或 browser lifecycle。
- `AI` CAPTCHA recognition。
- Worker-specific session acquisition 或 capacity handling。

Protocol／client 不得依賴 Hono、D1、Worker `Env`、adapter 或 `sync.ts`，也不得直接寫入資料庫；adapter 不直接讀寫 D1。`sync.ts` 負責呼叫它們，並組合共用 persistence 與來源 repository。來源不引用另一來源的內部實作。Connector 測試與 fixtures 放在 `apps/worker/tests/sources/<connectorId>/`，由 `npm run test:backend` 執行；跨來源的同步完整性測試留在 `tests/features/sync`。

電子發票的 config、同步 primitive 與正規化實作位於 `sources/einvoice/protocol.ts`，API client 位於同一目錄；各來源的 config 註冊集中於 `sources/config-registry.ts`。Worker 與測試直接引用需要的來源檔案，不使用跨來源的實作匯出入口。

所有 Browser adapter 建立新瀏覽器時，統一呼叫
`apps/worker/src/sources/browser.ts` 的 `launchBrowserWithRetry`，不得直接呼叫
`puppeteer.launch`。共用 adapter 在 binding `fetch` 層僅針對建立瀏覽器的
`POST /v1/devtools/browser` 請求依 HTTP status `503` 判斷重試，不比對錯誤文案。
預設等待 2 秒、5 秒後重試，最多嘗試 3 次；`503` 耗盡後保留原始錯誤。
結構化 log 只記錄狀態碼、嘗試次數與重試延遲。建立請求回應 `429` 時，在 binding
層辨識每日額度，並保留 `Retry-After` 的秒數或 HTTP 日期；暫時限流缺少有效 header
時預設 20 秒，避免 Puppeteer SDK 丟失 header。回應本文不寫入 log。建立瀏覽器時遇到 Browser Run
每日額度或限流，`classifyBrowserRunCapacityError` 會轉成共用的
`BrowserRunCapacityError`；不相關錯誤原樣傳遞。每日額度依 Cloudflare 的 UTC
隔日重置，使用者訊息說明「每日台灣時間早上 8 點重置」，`Retry-After` 為距離
下一次重置的秒數。五家原有的 `puppeteer.limits` 啟動頻率預先檢查也使用共用錯誤，
並保留當下取得的等待秒數。

手動同步與驗證碼 route 對共用錯誤回應 `429 BROWSER_BUSY`；同步紀錄維持
`failed`，排程在下一輪照常重試。銀行專屬 capacity error 只處理驗證碼作業或
session 忙碌，原有專屬 API 錯誤碼仍供這些情境使用。session 重連與銀行回應不在
上述 capacity 辨識及建立重試範圍內。

玉山、國泰世華、永豐、台新、華南、第一銀行、凱基與樂天的自動瀏覽器登入，
另使用 `prepareBrowserLoginWithRetry` 復原尚未送出登入的頁面停滯。準備 callback
只做分頁設定、cookie 還原、登入表單與第一張驗證碼載入；OCR、送出登入與金融
資料查詢都在 callback 外，第一輪 OCR 重用準備好的圖片，不再重新導覽。
可復用的登入 cookie 只在首次嘗試還原；若首次準備失敗，後續新 session 直接載入
登入頁，避免每次都耗時重走失效的 session。國泰的信任裝置 cookie 仍在每次新建時還原。

- 最多三次頁面嘗試（含首次）；每次頁面準備硬逾時 60 秒，共用流程使用固定的 180 秒
  預算，取得瀏覽器與限流等待也算入預算。來源原有同步期限與取消 signal 繼續生效；
  樂天另外預留 OCR／登入時間，重試不重設整次同步期限。
- 查詢 `puppeteer.limits` 與每次取得瀏覽器各自最多 15 秒，受整體剩餘期限限制。
  限流等待在取得操作之外計時，因此 20 秒等待不會被 15 秒取得逾時截斷。
  首次額度不足或取得回應 `429` 保留原有忙碌政策；只有已確認關閉舊 session 的
  重開流程會等待。每次等待後重新查詢額度，尚無額度就繼續等待至剩餘預算不足。
  重開取得的暫時性 `429` 依 `Retry-After` 等待後重試，最多三次取得嘗試；每日額度
  立即停止。只有建立請求明確回應 `429` 才能重試；CDP 連線失敗即使含有 `429`
  也停止重開，避免重複建立狀態不明的 session。其他取得錯誤與取得逾時不觸發新一輪登入頁重試，未知取得
  逾時也會停止尚未發出的 HTTP 重試；遲到的 session 仍須關閉。
- 只重試載入逾時、分頁失去回應及暫時性網路錯誤。帳密遭拒、已辨識的銀行維護、
  登入結果不明與送出登入後的錯誤沿用來源原有政策。人工 CAPTCHA／OTP 重連保留
  原 session，不套用自動重開。
- 失敗取樣最多一秒，隨後清理最多四秒；先呼叫 `browser.close()`，並透過 binding
  `DELETE /v1/devtools/browser/:sessionId` 確認遠端關閉。清理不能確認成功就停止，
  不再開新 session。等待下一次 acquisition 額度只會發生在舊 session 已關閉後；
  診斷與最後清理可在準備預算外收尾。
- `browser_login_preparation_failed` 記錄固定的準備階段（分頁初始化／設定、session
  還原、導覽、表單、驗證碼）、逾時來源（共用操作、整體預算、來源期限或來源內部操作）、
  頁面準備耗時、每輪與累計耗時。`browser_login_acquisition_wait` 與
  `browser_login_acquisition_failed` 記錄取得階段、額度查詢結果、等待時間、取得次數
  與 capacity 類型，供區分限流與頁面載入問題。其他診斷只記去除 query／fragment 的
  host/path、HTTP 狀態、網路錯誤代碼、CDP 是否回應、維護判斷與關閉結果，最多八筆
  失敗請求；不保存完整 HTML、頁面文字、截圖、帳密、cookie 或 token。

## 正規化資料契約

- Connector 回傳 `SyncResult`，資料必須符合 `@taiwan-fin-hub/shared`。
- `Connector` 與 `SyncResult` 定義於 Worker 的 `src/sources/types.ts`；其中的金融資料使用 shared 的正規化型別，與銀行 API response 契約分開。
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

## 信用卡交易階段與共用配對

交易沿用 `pending`（待入帳）與 `posted`（已入帳）兩個狀態，來源負責依銀行資料判定。
未出帳／已出帳是銀行的帳單狀態，不新增第三個交易階段；既有帳單明細仍供補抓／更新，
帳單摘要與餘額快照仍計算信用卡負債。

玉山、台新、永豐、中信、第一銀行、華南與兆豐使用 `features/sync/card-authorization-matching.ts`：
同銀行帳戶、同卡、台灣時區同消費日、同幣別及帶正負號的同金額，不比店名。
授權按時刻與 `sourceId`、明細按 `sourceId` 穩定逐一配對，每筆只使用一次；筆數不同時只配
可對應的筆數。缺卡片、消費日、幣別或有效非零金額不做基本配對；不以入帳日補消費日。
既有關係及已占用的目標不重新分配，來源消失不表示取消，未配對資料持續保存及顯示。
中信先使用可靠授權碼，明確不同的授權碼禁止基本配對；永豐精確配對後保留外幣／調整金額策略。
國泰目前只有帳單消費明細，新光只有信用卡摘要／帳單，沒有待入帳消費 feed，因此不新增配對入口。

`card-authorization-write.ts` 共用配對、補可靠時刻與分類／計算偏好／發票移轉，與金融資料
promotion 放在同一 D1 batch，沿用來源的 lock 與設定版本 guard。正式交易的既有決定優先，
發票衝突保留；中信因保留授權 ID 並移除副本，兩端都已連結發票時暫不合併。
相同 ID 入帳沿用共用 persistence；曾隱藏的授權後來以舊 ID 入帳時，更新既有目標，不讓授權
重新出現。銀行協定與來源 ID 的相容／修復仍由各來源負責，不以金額任意合併兩筆已入帳交易。

## 無信用卡情境

- 沒有信用卡是正常的產品資格狀態。同時支援存款的 connector 繼續回傳存款；僅支援信用卡的台新回傳空的金融資料，手動與排程都正常完成同步並更新 cursor。
- 只有明確持卡旗標、可確認無卡的完整清單或無卡提示才能略過信用卡流程。沒有帳單／消費、缺少清單、HTTP 失敗、session 失效與未知錯誤，不得直接當成無卡；既有可選資料的降級規則維持原行為。
- `apps/worker/src/sources/credit-card-status.ts` 的 `isNoCreditCardMessage` 只辨識以無卡敘述開頭的訊息，排除條件式申請說明；可移除銀行原生 alert 的四位數代碼前綴，但不依該代碼判定無卡。各銀行只能在信用卡階段與對應端點套用，不在共用 service 吞掉錯誤。
- 無卡時信用卡帳戶、餘額、交易與帳單為空，不建立零餘額，不刪除先前的金融歷史資料。第一銀行、台新的 `hasCreditCard: false` 是本次擷取結果，並非使用者設定或需要持久化的產品偏好。
- 無卡文案分支使用去識別的合成 fixture 驗證；目前新增的中信與台新分支尚未以真實無卡帳號驗證（第一銀行的會員登出頁分支已以真實無卡帳號確認），不將合成錯誤代碼視為銀行正式代碼。

## 路由、排程與 challenge

- 一般同步使用 `runConnectorSync`，不要在 route 或 scheduler 新增 connector switch。電子發票與集保的手動／排程入口使用各自的 durable-run service 啟動 Queue 流程。
- 所有 scope 必須先宣告在 `connectorCatalog`；排程工作目前固定使用 `all`。
- 同一 connector 的所有 scope 共用 canonical lock。
- 手動／排程必須把 `createSyncExecution` 的 scoped env 傳給來源同步，不得改用原始 DB 寫入金融資料、session、cursor 或結果。CAPTCHA preparation 同樣使用 scoped env，並維持 3 分鐘期限。Browser 透過共用 launch／connect helper 接收取消訊號；durable HTTP client 傳遞 `syncSignal`。
- 需要 CAPTCHA／OTP 時，runtime registry 提供 `prepareChallenge`，route 只處理輸入驗證與 HTTP error mapping。
- 排程不得主動寄送 OTP；需要互動時標記 `needs_user_action`。
- 若外部服務支援接管其他登入中的裝置，必須明確定義手動與排程的 `force` policy，並在介面與使用文件提示可能中斷使用者目前的工作階段。
- 新 connector 必須透過 D1 migration 建立 `<connectorId>:all` sync job，預設停用。

## 核心驗證

不再要求每個 connector 各自建立 config、parser、session、route、scheduler 與 self-check 全套測試。依後端文件的四類核心保障，只針對本次新增的風險擴充既有案例：

- 金額、繳款狀態與交易方向：先以銀行實際畫面或已確認欄位語意建立預期，再保存去識別化 response fixture。可替換帳號與金額，但不可從 parser 的輸出倒推預期；合成 fixture 本身不能證明銀行欄位語意。
- 同步去重、入帳與使用者決定：以共用 persistence 的隔離 D1 測試確認最後資料，不重複模擬每家銀行的相同寫入流程。
- 憑證安全：驗證公開設定／cursor 不含秘密、帳密變更清除舊 session，以及舊同步不能覆蓋新設定。
- 使用者驗證流程：以少量 E2E 代表案例確認，不窮舉銀行 DOM、frame、事件順序或同類錯誤碼。

自動測試統一接入正式 test command，不另維護 self-check 腳本。Catalog、config schema 與 runtime 的註冊完整性由既有型別契約與實作審查確認，不以 type assertion 或 fallback entry 規避。

## 新增流程

1. 在 `connectorCatalog` 加入 ID、mode、scope、capabilities 與欄位分類。
2. 在 `apps/worker/src/sources/<connectorId>` 建立 `protocol.ts`、必要的 client 與 parser，並在 `sources/config-registry.ts` 註冊 config schema。
3. 需要 binding 時，在同一來源目錄建立 `connector.ts` adapter。
4. 在同一來源目錄的 `sync.ts` 實作單次同步與 challenge use case，使用 `features/sync` 的共用 record mapping 與 staged persistence；需分段續跑的來源則沿用 durable sync 與 `run-repository.ts` 模式。來源專用的配對、存款生命週期與舊資料修復放在相鄰檔案。
   若來源提供直接存款帳戶，確認 `DIRECT_DEPOSIT_CONNECTOR_IDS` 是否需加入，以連結集保交割帳戶。
5. 在 Worker runtime registry 註冊 sync／challenge handler。
6. 在前端新增受 `ConnectorFormFieldKey` 約束的表單欄位與必要 challenge UI。
7. 新增 sync job migration。
8. 依上述核心風險完成必要驗證，並更新 `README.md` 支援資料來源表。
9. 執行：

```bash
npm run format:check
npm run typecheck
npm run test:backend
npm run verify:web
npm run build
```

若新增的是全新資料 entity，還必須同步更新共用契約、D1 migration、`SyncEntityType`、promotion order、entity config 與 record mapper；涉及資料完整性的新風險時擴充 persistence test。

## 各來源特殊行為

### 電子發票

#### 分段明細同步

電子發票是例外的 durable-run connector，不能使用一般 `runConnectorSync` 的單次
同步流程。`einvoice_sync_runs` 保存 run lifecycle，`einvoice_sync_run_items` 保存
已發現的發票 header 與每張明細的處理狀態；run items 本身也是 promotion 的 durable
staging source。設定儲存、登入 session 與資料 promotion 仍遵守本文件的敏感狀態與
設定版本 CAS 規則。

- 啟動手動或排程同步時只建立／取得 active run 並 enqueue `run-einvoice-chunk`；API
  可以回傳已排入同步，前端必須依 sync job lifecycle 顯示完成結果。
- 既有 run 也必須補送 continuation；新 run 初始化或首次 enqueue 失敗要補償結案與清鎖。Cron 恢復無有效 chunk lease 的停滯 run，整體期限為建立後 10 分鐘（包含 Queue 等待）；逾時先結案，再允許重新建立。
- 初始化只取得清單並 durable 地寫入 item；明細一律同步。每個 Queue invocation 最多
  claim 並擷取 35 張發票，完成狀態以 set-based D1 寫入；若尚有工作便 enqueue continuation，不能在同一 invocation
  繼續處理下一批。
- item claim、run chunk 都必須使用 owner-scoped lease，chunk owner 使用每次 invocation 的新 UUID；3 分鐘 chunk lease 每分鐘及每五張明細 rolling renew
  run lease，item 完成／釋放則以 claim token CAS。Queue 重送時只可接管已過期的 run lease
  與 item，且不得解除其他 invocation 的 lease。
- 所有 item `done` 前不得 promotion。完成後由 run items 以固定五個 set-based statements
  一次 promotion invoice 與 line item，並以設定版本 CAS 在同一 batch 更新 cursor；後續
  finalize path 更新 sync job 和排程批次結果。`promoted_at` 必須使重送可冪等。
- 所有持久化寫入同時核對 connector 與 chunk owner；成功結案保護 owner，失敗結案另要求沒有有效 chunk lease。不得讓失鎖的舊 invocation 更新資料或清除新 owner 的鎖。
- 暫時外部錯誤釋放 item claim 並使用 Queue retry；session 過期清除已保存 session 後回到
  初始化；憑證或互動式登入需求則標記 `needs_user_action`，retry 上限後標記 `failed`。

#### 歷史身分整併

Migration `0043_merge_legacy_invoice_duplicates.sql` 以相同發票號碼整併歷史資料，
優先保留新版 UTC ID；同號碼的其他副本會刪除。
缺少的品項明細與人工配對／解除配對設定會移至保留資料；品項或人工設定衝突時
以保留資料為準。此 migration 不改變同步協定或新資料的 ID 產生方式。

### 集保 e 存摺

#### 分段同步

集保與電子發票同樣使用 durable run。手動與排程入口呼叫 `startTdccSyncRun`，
並 enqueue `run-tdcc-chunk`，不以一般單次同步流程取代分段處理。

- `tdcc_sync_runs` 保存 run lifecycle、scope、設定版本及加密認證／session；
  `tdcc_sync_run_items` 保存 `bank_page`、`trade_page` 工作與結果。
- 手動啟動先取得 run lease 並初始化登入以處理 OTP；排程初始化不主動寄送 OTP。
- 同一 connector 的所有 scope 共用 active run 限制與 canonical lock；每個 chunk
  另取得 owner-scoped run lease，每次最多 claim 一個分頁 item，以 claim token
  更新或釋放該 item，尚有工作時 enqueue continuation。
- run lease 為 3 分鐘、每分鐘續租，整體期限與停滯恢復沿用電子發票；手動重試同 scope 的既有排程 run 可補送 continuation，保留原批次。
- 分頁結果完成後彙整，透過一般 staging 與 promotion 寫入金融資料，並檢查設定版本、
  更新 cursor；後續完成排程結果、手動完整同步的報告修復與 run 結案。
- 金融資料與 cursor 使用同一 batch 的 connector／chunk owner guard；結果與結案寫入完成前保留 connector lock。失敗結案、結果、staging 清理與清鎖必須原子提交。
- 暫時錯誤交給 Queue retry；需要互動或重試耗盡時終止。不得把每段 run lease 的
  釋放當成整個 connector 同步完成。

詳細流程與檔案責任參考[後端架構](002-backend-architecture.md#集保分段同步)。

### 玉山銀行

玉山網銀已改走新版 `/esb/`。登入欄位是 `input[name="id"]`、
`input[name="userName"]`、`input[name="pxssword"]`；重複登入代碼 `9005`
要再送一次「確定登入」。信用卡即時消費與近一年明細來自
`iesc.esunbank.com` 的 `realTime/getDetailResult` 與
`creditLastYear/getFilterResult`，存款明細要先呼叫任務 `home/init` 再查詢。
並非每位使用者都有信用卡或外幣帳戶：同步先呼叫 IESC `common/isCardholder`，
只有成功回傳 `rtnCode: "S"` 且 `credit: false` 時才略過全部信用卡請求，也不建立
信用卡帳戶；請求失敗或其他回應都維持原本的信用卡流程。外幣存款查詢回傳 `S001`
且說明為「查無外幣帳號，或您尚未開立外幣帳戶」時視為沒有外幣帳戶；`S001` 也用於
其他提示頁，說明不符時仍使同步失敗。瀏覽器登入後，刷卡明細頁要同時具備 IESC
`accessToken` 與「未入帳」選單或「尚未持有本行信用卡」提示才算就緒，避免在頁面
自己的初始化請求輪替 token 時送出額外請求。
信用卡 `getCardOverview` 的 `creditCardFeePaid` 為 `true` 時，將本期帳單標為已繳；
否則繳款狀態維持未知。已繳的正額帳單不再計入信用卡負債，仍保留未出帳消費
與負額帳單的溢繳餘額；帳單本身保留原應繳金額。既有餘額快照於下次同步更新。
即時授權與之後入帳必須沿用原本的消費日期、商店、金額與卡片組成 `sourceId`，
授權時間只補在 `authorizedAt`。每筆卡片交易的 `raw.esunFeed` 標記來源為
`realtime` 或 `history`；同名的即時紀錄併入明細並補上時間，不另產生流水號。

即時紀錄常以支付通道命名（如 `LINEPAY*…`），明細則是特店名稱，因此每次同步後
另在 `bank_transactions` 以 `matched_transaction_id` 把未配對的即時授權連到明細：
限同卡、同消費日、同幣別、同金額，不比對名稱，依授權時間與 `sourceId` 順序一對一
分配；正規化卡片識別後使用共用 `features/sync/card-authorization-matching.ts`。
明細（未入帳或已入帳）保留正式名稱，只補入授權時間；首次配對時移轉授權的
個別分類、計算偏好與發票關係。已配對關係不重新分配，被連到的明細不再接受其他授權。
未入帳歷史明細之後改以不同名稱入帳時，也使用共用基本規則銜接。即時授權先連到未入帳
歷史明細，再連到正式入帳；同一 batch 按順序移轉時間與使用者設定，不新增交易狀態。
沒有 `esunFeed` 的舊資料，以「待入帳且 `authorized_at` 含時間」判定為即時授權；卡號不明不配對。
同日多筆同額消費可能對調刷卡時間，但筆數與金額正確；找不到明細的授權照常顯示。

### 國泰世華銀行

登入公告清單的按鈕依序顯示「下一則」，最後一則才是「我知道了」。同步逐則點選已知動作，僅在最後確認彈窗關閉；未知動作不點擊，最多處理二十則，避免公告循環或誤觸其他功能。此流程沿用既有登入入口，不變更 OTP、信任裝置或資料查詢。

存款明細只從總覽進入一次，其餘帳戶使用明細頁的 react-select 帳號選單切換，避免反覆開啟總覽造成 `/OnlineBanking/Logout/SystemError`。帳號與期間以選單外層控制項的文字辨識，以 ArrowDown 開啟並選取完整帳號或期間文字，確認控制項已更新後繼續。找不到帳戶或指定期間時整次失敗，不沿用預設期間或略過帳戶。

進入明細頁時先完成自動送出的 30 天查詢，每個帳戶再依共用回溯 policy 選取期間並按「查詢」。選單切換後只等待存款明細請求完成及 500 毫秒無新請求，不受分析／追蹤服務的持續連線影響；逾時或請求失敗即中止。按鈕操作前註冊 request 與 response 監聽，以本次 request 物件對應 response，避免將先前查詢的空回應當成本次結果。請求的 `content.queryFilters` 必須只有所選帳戶，`startDate`／`endDate` 的含首尾天數須符合查詢期間。`B_ACCT_Q_TransferDetail` 的請求與回應帳號允許前置補零，其餘必須與所選完整帳號一致。

明細回應必須為 `returnCode: "0000"` 且包含所查帳戶的 `datas`。`queryStatus: "Success"` 或 `"NoData"` 搭配空明細才視為查無交易；`"Fail"`、缺少帳戶結果或狀態與明細矛盾時整次失敗。非 JSON、回應結構不明、帳號或期間不符、非成功 HTTP 狀態、查詢逾時或被登出時也不寫入部分資料。登出路徑比對不分大小寫。

外幣活存使用同一登入工作階段開啟 `FAcctInq/R0101_FDepInq`，監聽頁面自己送出的 `R_ACCT_Q_OverView`，並以本次 request 物件配對回應。只有 HTTP 200、`returnCode: "0000"` 且 `content.isGetDemandAccountSuccess: true` 才解析 `demandAccounts[].details[]`。依官方頁面，以 `currencyCode` 與 `balance` 保存原幣餘額，保留小數，不使用臺幣參考值 `equalTwdBalance`；同帳號不同幣別使用 `bank:cathaybk:<帳號>:<幣別>` 識別，避免互相覆寫。查詢成功且帳戶或幣別明細為空／null 時不建立金融資料；失敗旗標、未知回應或查詢逾時使整次同步失敗。此流程僅同步外幣活存帳戶與餘額，不查詢外幣交易或定存，也不清除歷史資料。帳戶與餘額快照的 `raw` 僅保存帳號末四碼 `accountSuffix`、`currencyCode` 與 `balance`，不保留完整帳號或其他回應欄位。Log 只記錄事件與幣別帳戶筆數。

開啟信用卡總覽前先監聽頁面自己送出的 `C_COM_Q_CardStatus` 請求，以同一 request 物件配對回應，不另外發送狀態查詢。只有 HTTP 200、`returnCode: "0000"` 且 `content.cardStatus: "Invalid"` 時，才依官方 C0101 前端的無卡判斷略過信用卡擷取，保留存款並正常完成同步；不建立零餘額或刪除歷史信用卡資料。狀態 API 逾時、HTTP 失敗、非 JSON 或未知回應格式仍使同步失敗。

其餘已知狀態 (`Valid`、`Positive`、`UnKnow`) 繼續原有信用卡總覽擷取，最多等待 15 秒，須出現可解析的完整「卡片末四碼」才繼續。逾時且偵測不到卡號時，必須有明確無卡提示，或具備信用卡總覽與「立即線上辦卡」的無卡頁面內容，才回傳空的信用卡資料。空白、維護、被登出或無法辨識的頁面使同步失敗，不能僅因缺少卡號就當成無卡。診斷 log 只記錄卡片狀態 enum、失敗階段、移除 query 的頁面路徑、卡片辨識與等待逾時狀態，不記錄完整頁面文字、帳號或憑證。

存款的選單操作與查詢流程已以真實登入確認可執行，請求欄位及狀態判斷另與官方前端核對；新增的帳號、期間與狀態驗證以合成資料測試。無卡狀態判斷依官方 C0101 前端實作，空金融資料與錯誤不誤判的結果已用合成狀態回應測試；真實完整同步尚未驗證。

外幣活存欄位與空帳戶／失敗旗標語意依 2026-10-06 取得的官方 `FDepInqContext-_BabElsu.js`、`index-Df9J0qxz.js` 與主程式核對。新增三個核心案例，以合成資料驗證同帳號多幣別及小數餘額、成功無帳戶與失敗不誤判；依本文件的敏感資料規則，擴充多幣別案例確認兩種 `raw` 僅保存末四碼與白名單欄位。尚未取得有外幣帳戶的真實回應，也尚未完成登入後的無外幣分支與完整同步驗證。

OTP 通過後，國泰可能先顯示「密碼已超過半年未更新」提醒頁並停在 `/MyBank/Quicklinks/Home`，擋住信任裝置設定。同步會點選「暫不變更」略過提醒，不變更使用者的密碼；該頁也視為 OTP 驗證成功。信任裝置是否完成，除頁面上的成功訊息外，也以 `CUB.eBank.DeviceId` cookie 輔助確認；該 cookie 可能是 HttpOnly，須由瀏覽器端（CDP）讀取，`document.cookie` 看不到。兩者都偵測不到時記錄不含個資的 `cathaybk_trusted_device_not_detected` 並回報未完成。

### 永豐銀行

使用一般行動網銀登入頁 `/m/member/login/m_login.aspx`，同一 App session 先取得存款，再取得信用卡資料。信用卡總覽或近期帳單明確回覆無卡時，略過信用卡 SSO 與後續請求；仍保留 `LatestTx` 的「您沒有有效卡」處理。這些情境不建立信用卡帳戶，但保留存款帳戶、餘額與交易。`查無消費紀錄` 只表示沒有消費，仍繼續原信用卡流程；SSO／授權失敗不當成無卡，存款端點不套用無卡規則。

#### 臺外幣活存

- 純查詢與解析邏輯位於 `apps/worker/src/sources/sinopac/deposit-protocol.ts`，Worker adapter 沿用 App JSON transport 與加密 session，不保存新的帳密或 session 欄位。
- 以 POST `/ws/bank/bankbal/ws_bankbal.ashx` 的 `SubInfo` 取得各帳戶與幣別；`AvailBalInt` 為活存餘額、`MaxAvail` 為可用餘額。零餘額仍建立帳戶與快照，`FixBalance` 的綜存定存不納入本次活存範圍。
- 每個帳戶依序 POST `/ws/bank/transdetail/ws_transdetailMerge.ashx`，form 欄位為 `AcctValue`、`Curr`、`QueryType=3`、`StartDate`、`EndDate`。日期格式為 `YYYYMMDD`，依臺灣當日回溯 `BANK_SYNC_MONTHS`（三個月），月底取目標月份最後一天。
- `DataText4` 保留銀行提供的金額正負號。`DataText1` 為交易日期／時間，僅有日期時不補午夜；`DataText2` 是計息日，只存於白名單 raw，不用作入帳日。HTML 先去除再正規化，摘要與備註中的完整帳號／身分證字號須遮罩。
- `RecordCount` 是最後一筆的 index，非總筆數；有交易時應等於 `SubInfo.length - 1`。筆數不符時切成不重疊的日期區間重查；單日仍不完整就失敗，不提交部分結果。僅交易端點的 `Header=FAIL`、`Message=查無資料` 且 `SubInfo=[]` 可作為明確無交易回應；缺少必要清單、session 失效與未知錯誤仍失敗。
- 帳戶 sourceId 使用末四碼、完整帳號 SHA-256 與幣別，不儲存完整帳號。交易 sourceId 由帳戶、交易日、帶正負號的金額、交易後餘額與支票號碼雜湊產生，另加同組流水號；不依賴備註或時間精度，重複同步不新增同筆交易。每日餘額快照以臺灣日期識別。
- `sinopac` 已加入直接存款來源，透過既有銀行代碼 `807`、末四碼與幣別連結集保交割帳戶，避免重複計入資產；存款交易不參與信用卡授權配對。

帳戶總覽、臺外幣三個月交易與明確無交易回應已用登入後的唯讀查詢確認，並以新 parser 實際取得帳戶、快照與交易；區間分割、無卡保留存款與重複寫入使用合成 fixture／本機測試驗證，尚未驗證部署後的完整同步。

#### 信用卡帳單與餘額

永豐信用卡使用 SinoCard `accounting/accountinginfo` 的 `BillAmounts` 取得各幣別本期帳務，
以 `CURRBAL` 保存應繳總額、`DUEAMT` 保存最低應繳、`TotalPaymentAmt` 保存本期累計已繳款。
銀行的 `TotalPaymentAmt="-"` 是本期尚無已入帳繳款的明確標記，解析為已繳款 0；
已於官方帳務頁與臺幣／日幣回應的 `PaymentRecords=[]` 核對。最近繳款 `LastPaymentAmt`
及上一期繳款 `PREVPAYAMT` 不替代本期累計已繳款。
應繳總額保留原始正負號，允許退款或溢繳形成的負帳單。餘額快照使用同幣別已繳款減去應繳總額，
負值為欠款，正值為溢繳餘額；餘額非負時標記無需繳款。已繳款為 0 且應繳總額為正時，帳單狀態為待繳。缺少已繳款欄位或無法解析時不建立該筆帳務快照，
台幣總覽的負應繳金額仍保留為正餘額，不取絕對值或歸零。
結帳日與繳款期限分別取自 `BaseData.STMTDATE`、`BaseData.DUEDATE`；保留既有台幣歷史帳單查詢。
外幣未列於本期 `BillAmounts` 時，使用銀行本次 `OutstandingDetail.SubTotal` 小計作為未出帳負債快照，
不建立帳單、不填入繳款期限；不得累加本機歷史交易替代本次小計。資產頁對未知信用卡餘額顯示
「剩餘應繳金額未取得」，相關負債合計顯示「資料不完整」。繳款狀態以銀行已入帳資料為準，
官方頁面說明付款後約需 1 至 3 個營業日入帳。

#### 授權與明細配對

永豐信用卡取得 `LatestTx.Items` 與 `OutstandingDetail.Detail` 後，在 `bank_transactions`
原表保存授權，以 `matched_transaction_id` 記錄已入帳關係，不另設授權表或停用欄位。
配對僅限同卡、同消費日，不跨日；排除手續費、服務費、不同金額方向與卡片識別不足的資料。
既有相同 sourceId 優先；同帳戶、同幣別同金額使用共用核心穩定逐一配對，不比店名。
剩餘外幣／調整金額再以正規化店名相似度及目前匯率金額接近度計分，同卡同消費日採最大總分的
一對一分配，無合理候選則不配對；跨幣別限同一信用卡摘要帳戶的不同幣別，不要求人工確認。
已配對關係不重新分配；已入帳保留正式金額、幣別、入帳日與原始 payload，繼承授權時刻。
配對後優先沿用待入帳名稱作為 description 與 counterparty，供顯示、搜尋及規則分類；
空白或預設「永豐信用卡消費」名稱不覆蓋正式名稱。每次同步也修復既有配對，即使銀行
不再回傳該交易；同 ID 入帳沿用已保存名稱。舊版已覆蓋且來源不再提供的名稱無法復原。
同 ID 入帳以 `raw.authorizationMatched` 記住配對完成；保有授權時刻的舊已入帳列也視為
已完成配對，保留時間與名稱，且不再讓另一筆待入帳授權使用該明細。
在同一 D1 batch upsert 交易、保存配對、補入時刻，並於首次配對移轉原授權的個別分類、
計算偏好（已入帳既有設定優先）及發票關係。原授權與設定持續保存。
活動、搜尋、發票配對候選與收支統計僅排除 `status = 'pending'` 且
`matched_transaction_id IS NOT NULL` 的授權；同 ID 升為已入帳仍正常顯示。
不處理來源消失：未配對授權即使來源不再回傳，仍保留並顯示；空清單不刪除或隱藏資料。
缺少清單或解析失敗不寫入；無有效卡與舊版解析不執行授權配對。
已在舊版永久刪除的授權，若來源不再回傳，無法從此變更復原。

#### 交易識別與金額方向

- 交易 sourceId 為 `sinopac:card:tx:v2:<幣別>:<消費日>:<簽名金額>:<卡號末四碼>:<序號>`。繳款入帳
  （正數且摘要含「自扣」或「繳款」）是整份帳單的扣繳，銀行每次查詢可能掛在不同張卡下，卡號位置
  改為 `payment-<摘要雜湊>`：同一筆跨卡繳款識別碼相同，同日同額但摘要不同的繳款不共用序號。
  舊版繳款列（含卡號或 `:payment:`）由 `reconcileSinopacCardPaymentStatements` 併入新版列。
- 已入帳明細（`OutstandingDetail.Detail`）的 `AMT`（沒有時 `TXAMT`）帶正負號（正數為消費、負數為
  退款／回饋／繳款），直接採用，不以關鍵字推測：「回饋金入帳戶」是把回饋從卡片轉出，摘要含「回饋」
  但其實是扣款。最新授權（`LatestTx.Items`）的金額不帶正負號，方向只比對摘要與授權結果
  （`AuthResult`），不比對整筆記錄：卡名可能含「回饋」等關鍵字（例如現金回饋卡）。
- 金額與序號都是識別碼的一部分，方向改正或同組序號重排時，同一筆明細會換成新識別碼。
  `reconcileSinopacCardStaleStatements` 把這次同步沒有寫入、但與這次寫入的列屬於同一筆銀行明細的
  過期列併入新列：已入帳以卡號末四碼、消費日、原始金額、幣別代碼與摘要核對，授權以卡號、授權日、
  授權時間、授權金額與摘要核對，同身分多筆依序號一對一配對；缺卡號或日期時不合併。
- 以上合併都沿用 `mergeLegacyTransactionStatements`（保留使用者偏好、分類與發票關係），並排在授權
  寫入之後：授權寫入沿用同步前讀到的交易 ID，合併再把配對改指向留下的列。

### 台新銀行

- 先在同一登入 session 取得存款，再查信用卡。信用卡端點的 `error` 字串或 `error.message` 明確回覆無卡時，以 `hasCreditCard: false` 略過信用卡，仍回傳存款；不建立預設信用卡帳戶。存款僅接受成功回應內的完整空產品清單，不將未知錯誤當成無存款。session 檢查不套用無卡規則。
- 台新登入後若出現「訊息通知／每三個月變更一次密碼」彈窗，必須點「關閉」後再抓資料。不得點「前往修改」或「3個月後提醒」，也不得停在彈窗卻因為 session API 仍可用而回報同步成功。
- session 確認成功後重新取得當前 frame，最多等待 15 秒讓登入後頁面掛載 `popupLoginChangePwd`。`PwdExpired` cookie 尚在時需等待通知顯示，直接觸發該通知內 `button[data-action="hide"]` 的官方 click handler；最多等 5 秒確認 `active` 已移除且銀行的關閉處理已清除 `PwdExpired`，才查詢資料。頁面未就緒、按鈕缺失或關閉失敗均中止同步，不吞掉錯誤。
- 重用已確認有效的 session 時，經 session 檢查的 frame 不一定掛載登入後通知元件；該 frame 沒有通知與 `PwdExpired` 時可直接查詢，不等待一次並未發生的新登入。已有通知或提醒 cookie 時仍須完成上述關閉流程。
- 自動登入分別限制最多辨識六張新驗證碼、最多向銀行送出三次登入請求。辨識結果若不符合頁面要求的數字位數，不送出登入，也不扣登入額度；重新載入頁面取得新驗證碼。只有明確的驗證碼錯誤可以重試，帳密遭拒或登入結果不明時立即停止。耗盡辨識或登入額度時改由使用者人工驗證，訊息分別說明辨識上限與實際送出次數。
- 驗證碼圖片在就緒檢查後消失、隱藏或變成零尺寸，視為登入前驗證碼未就緒；首次準備沿用共用流程最多三次新 session 嘗試，後續換圖沿用原有頁面重載上限。圖片取得失敗不辨識、不送出登入，也不扣登入請求額度；保留原始錯誤供準備診斷，最終訊息說明圖片尚未顯示或已更新。
- 每輪自動登入記錄辨識次數、當輪及累計登入請求數、結果分類與耗時；日誌不得記錄驗證碼、圖片或帳密。

#### 存款查詢

協定欄位與請求依 2026-10-07 [官方網銀 RWD 前端](https://my.taishinbank.com.tw/TIBNetBank/svc/rwd/index.html) 的 RB0100/0101/0102、RB0800/0802 查證；fixtures 使用合成帳務。存款範圍以同一網銀 session 回傳的臺外幣活期性帳戶為準，不含定存、貸款或投資；Richart 是否出現在相同 session 的清單仍待驗收。

以下均為 POST，相對於 `/TIBNetBank/svc`；物件 body 使用 JSON，無參數呼叫依官方 axios helper 使用空字串。

| 端點                                                                             | 請求／解析                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web1/rb0100/query`                                                              | `RESULT = NORMAL`，`OUTPUTDATA.SavingAccount` 提供 `accountNo`、`accountTypeName`；不使用定存總額。                                                                                 |
| `web1/rb0101/query`                                                              | `{ account }`；`balance` 為帳戶餘額，`availbalance` 為可用餘額，`dtltamt` 不加進活存。                                                                                              |
| `web1/rb0102/listaccount`、`web1/rb0102/query`                                   | 先以 `{}` 初始化並確認帳號，再以 `{ account, start, end }` 查近三個月，日期為 `YYYYMMDD`；解析 `userList`。                                                                         |
| `web2/rb0800/getRB08000100Data`                                                  | `error = null`，`data.FCS_ACCOUNT[].FCS_ACCOUNT_DETAIL` 列出帳號與各幣別活存；不使用 `FTS_ACCOUNT` 或 `ALL_BALANCE`。                                                               |
| `web2/rb0800/getRB08000100QueryRealtimeBalance`                                  | `{ requestAccount, requestAccountAlias, requestCcyCode }`；核對回應 `ACCT_NO`、`CURRENCY_CODE`，保存 `BALANCE`；官方未提供可用餘額，保持未知。                                      |
| `web2/rb0812/getRB08120100Options`、`web2/rb0802/getRB08020100ForeignTranDetail` | 官方 RB0802 初始化使用 RB0812 options。按各幣別以 `requestAcctNo`、`requestCurrency`、`requestStartDate`、`requestEndDate`、`requestDateType = I` 查詢；解析 `data.TRANS_DETAILS`。 |

外幣總覽的 `FCS_ACCOUNT` 接受陣列或物件映射，包含空 `[]`／`{}`。清單 schema 驗證失敗時仍中止同步，訊息使用「格式驗證失敗」並附第一筆去識別診斷，不將錯誤推定為銀行改版或空產品。Worker 日誌以 `event = taishin_deposit_schema_validation_failed`、`endpoint = getRB08000100Data` 提供最多五筆去重後的診斷；超過時標記 `truncated: true`。

每筆診斷僅含白名單欄位路徑、錯誤碼、預期型別與收到的型別。帳戶動態鍵與陣列索引按位置替換為 `[*]`，即使鍵名等於白名單欄位也不能保留；未知欄位／型別以 `unknown` 表示，缺省型別以 `missing` 表示。群組欄位僅允許 `ACCOUNT_NO`、`ACCOUNT_NAME`、`FCS_ACCOUNT_DETAIL`，明細欄位僅允許 `ACCOUNT_NO`、`ACCOUNT_ALIAS`、`CURRENCY_CODE`、`BALANCE`。Zod union 子錯誤接上外層路徑，優先呈現符合容器形狀的分支；金額型別合併為 `string|number`。錯誤與日誌不保存 Zod 原始 message/input、動態鍵、欄位值或原始回應。回報者可提供下列形式的診斷定位欄位，不需提供帳務資料：

```json
{
  "path": "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
  "code": "invalid_type",
  "expected": "string",
  "received": "null"
}
```

臺幣 `txnamtOut` 非 `-` 是支出、`txnamtIn` 非 `-` 是存入；`sysdate` 為交易日／時刻，`dateNew` 為帳務日。`inNo + outNo` 必須與清單筆數一致，截斷時拆分不重疊期間重查；單日仍不完整即失敗。外幣 `DRWAMT` 是支出、`DEPAMT` 是存入，`ACCT_BAL` 是交易後餘額；交易日／時刻採官方顯示的 `TRANSACTION_DATE_TIME_DSC`，`TX_DATE` 為帳務日。前端表格在本機分頁，外幣查詢未見伺服器 continuation 或筆數欄位，要求完整 `TRANS_DETAILS`，不猜測分頁端點。

每個帳號與幣別使用 `bank:taishin:{last4}:{sha256(accountIdentity)}:{currency}`，完整帳號只用於當次請求。交易 ID 依帳戶、消費日期、正負金額、交易後餘額及臺幣 `procSeq` 摘要，再按完整候選集合分配 occurrence；排序、備註或時間精度不影響 ID。快照按台灣日期每天更新，原幣小數與零餘額均保留。末四碼、銀行代碼 `812`、幣別沿用共用 canonical linking，集保同帳戶不重複計入資產。

#### 完整即時消費與入帳配對

- 「即時消費」指每次同步取得銀行當下提供的信用卡授權清單，更新頻率沿用既有同步排程。官方總覽的 `qryRealTime` 只供最近消費摘要；完整清單改用 `web4/rb0708rwd/queryRealTime`，在摘要／當期帳單初始化後查詢 `value.fmtRealTxListMap`。列 `[3]` 是「新臺幣消費金額」，`[5]` 須精確等於 `成功`；拒絕、取消或 `未成功` 不計入消費。店名顯示採 `[6]`，v2 identity 保留舊版的 `[2]`，補時間不換 ID。
- 同步 `web4/rb0708rwd/qryUnposted` 的 `value.unpostedTx`，連結授權離開清單後至正式出帳之間的交易。幣別分組以 `001TWD` 或 `USD` 等 key 與列 `[7]` 核對；`[0]` 為消費日、`[1]` 為入帳起息日、`[2]` 為明細、`[3]` 為約定幣別金額。同份未出帳與帳單重疊時按 identity 的 occurrence 去重，同日同額多筆仍保留。
- 完整空清單或明確 `(CRXTIKE004)無消費資料` 可成功。即時消費忙碌／暫時性網路錯誤重試最多三次，耗盡即失敗；缺少必要清單、未知格式、未出帳幣別錯誤不可由可選帳單降級吞掉。必要查詢途中 session 失效時，沿用一次重新登入政策，重抓整份存款及信用卡資料後才寫入。
- `authorizations.ts` 讀取歷史未配對授權與本次正式交易，使用共用 `features/sync/card-authorization-matching.ts`。同帳戶、同信用卡末四碼、同消費日、同幣別同額同方向的群組，依授權時間及 `sourceId` 與正式交易的 `sourceId` 順序逐一建立 `matched_transaction_id`，每筆正式交易只配一次；兩側筆數不等時，剩餘資料仍保留並顯示。同日同額多筆可能對調個別消費時間，但筆數與金額保留。授權摘要可能是類別或公司名，正式入帳則是分店名，因此不要求店名相同；名稱仍沿用原本的顯示與 v2 identity，不改交易 ID。卡片或消費日不明、跨日、跨幣別均不配對。來源消失本身不代表取消，不刪除歷史授權；已建立關係不重新分配。
- 相同 ID 由共用 persistence 提升為 `posted` 並保留可靠時刻；不同 ID 保留原 pending 列，活動與統計沿用共用規則隱藏已配對授權。首次配對在同一 guarded promotion batch 補時刻並移轉個別分類、排除與發票關係，正式交易既有決定優先，發票衝突保留。舊版曾借用授權店名 ID 的已入帳紀錄，只在唯一對應時重用原 ID，不換使用者引用。
- 存款、配對、canonical linking 與 cursor finalize 受相同憑證版本保護；查詢或 promotion 失敗不更新金融資料／cursor。
- 信用卡負債合計當期帳單剩餘應繳與 `qryUnposted.value.showRB0712_SUBTOTAL` 的官方新臺幣未出帳總額，快照保存合計的相反號；帳單繳清及無需繳款仍依當期帳單判斷。未出帳總額保留退款的正負號，銀行合計已排除繳款／繳款更正，不加總明細列以免重扣繳款或混入未換算外幣，也不加入即時授權。非空明細缺少總額或總額格式無效時同步失敗；完整空清單或明確無消費可採 0。

2026-10-07 已以真實帳戶通過本機自動登入、密碼通知關閉、完整手動同步、session 重用及重複同步不新增副本；帳單已繳清時的未出帳負債已與官方畫面、本機 D1、API 及資產頁核對一致。其他帳務逐項核對、Richart 可見範圍、人工驗證、排程與 Cloudflare 部署環境的實際操作仍待驗收。

### 中國信託銀行

信用卡帳單端點 `/twrbm-card/qu002/010` 的 `cardDataList` 明確為空陣列且 `billData` 為空物件，或其 `message` 明確回覆無卡時，保留存款與交易，略過信用卡摘要、未出帳與即時消費查詢。缺少欄位不觸發此判斷；需要驗證的回應優先保留原分類。無卡文案只用於此端點，不把 `8888` 或 `ESB/9201` 直接解讀為無卡，登入後仍執行登出。

中信帳單的消費日、入帳日、結帳日及繳款期限使用 `MMDDYY`；未出帳明細使用
`YYYYMMDD`，金額與商家欄位為 `purchaseAmt`、`description`。`000000` 不代表有效日期。
非零已入帳明細若無法解析日期或金額，整次同步失敗，避免靜默遺漏或寫入無日期交易。

配對優先使用雙方相同授權碼的 SHA-256 摘要、同幣別及同方向金額，且雙向唯一；
雙方卡號已知時必須同卡，不比商家名稱。雙方都有消費日期時必須同日，允許一方或雙方缺少
消費日期，不以入帳日代替消費日期。其餘候選使用共用同卡、同日、同幣別同方向同額的逐一配對；
授權碼明確不同時禁止金額 fallback，卡片或日期不足時也不能靠基本規則推測。
不跨幣別推估。原始授權碼及交易參考號不寫入 `raw`，只保存摘要。
同一次回傳內配對成功時，可見列沿用待入帳 identity，名稱改用已入帳。

中信同步會比對本次資料與已保存的授權。配對成功後可見列為待入帳原列：升為已入帳並
沿用其 ID、消費時間與使用者設定；名稱、入帳日與正式金額改用已入帳明細，再刪除已入帳
重複列。待入帳若已有分類且不是未分類，保留待入帳分類；待入帳未分類則沿用已入帳分類。
計算偏好與發票以待入帳既有設定優先，沒有時才從已入帳補上；兩端都連結發票時保留原交易
與設定、不合併，避免刪除使用者決定。先前以
`matched_transaction_id` 隱藏待入帳的舊配對，下次中信同步會改為此合併。
原列以 `raw.authorizationMatched` 保存配對完成，並以 `syncSourceId` 記住正式來源識別；
後續更新沿用原 ID，不把已完成的授權拿去配另一筆同額消費。中信正式明細只提供日期；
舊版保有授權時刻且未記錄配對完成的原列仍可修復漏合併副本，保留原 ID、時刻及設定。
修正日期前的無日期帳單紀錄，僅在銀行再次回傳且舊 identity 可唯一對應時先修復該列；
若同時有唯一待入帳可配對，仍改以待入帳 ID 為準。無法唯一修復則不寫入本次同步。
銀行已不再回傳的舊明細無法藉此還原日期。同筆交易改由其他明細回傳時仍沿用既有 ID；
待入帳回應不會將已入帳降回待入帳。

### 新光銀行

資產總覽 `HasValidCreditCard: false` 時不查詢信用卡 API，仍同步臺外幣存款與交易。未知旗標型別仍視為協定錯誤。

新光信用卡 `RemainingDue` 回傳 `NA` 時視為欠款金額未提供，仍同步帳戶與歷史帳單，
但不建立本次信用卡餘額快照、不推算已繳金額或繳清狀態。既有快照保留原時間，
不得將 `NA` 當成零；其他無法辨識的欠款文字仍使同步失敗。

### 王道銀行

#### 定存生命週期

王道公開網頁的 [FAO01012 controller](https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/html/FAO/FAO01012.js) 以 `repeats` 建立完整存單選擇器，再以 `tdAccountNumber` 查詢各筆 `tdDetail`；[頁面欄位](https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/html/FAO/FAO01012_010.html) 使用 `contractDate`（起息日）與 `maturityDate`（到期日）。連接器沿用清單的帳戶識別碼與餘額，明細只補日期，不保存完整存單號碼。

- 僅完整清單及逐筆明細全部成功後，才撤下未再出現的定存。缺少清單、明細不符或解析不完整時整次同步失敗；明確空陣列可撤下全部舊定存。
- `inactive_at` 是確認來源不再列出存單的時間，不是實際結清日。同期寫入零餘額快照，與狀態變更一同提交；保留之前的餘額歷史。到期日不作為自動結清條件，來源重新列出時恢復有效。
- 成立活動須有銀行起息日及唯一的同幣別活存扣款；本金轉回須有前次有效快照、存單消失與其間唯一的活存本金入帳。同幣別有多個活存帳戶、同額候選不唯一、同日無法判定先後或本金利息合併入帳時，不推算活動。
- 衍生活動以 `transfer_peer_id` 綁定該活存交易，優先一對一配對；定存不參加一般同額配對。本金排除收支，另筆利息保留原有分類及計算。缺少來源日期或交易證據的歷史資料不自動補造。
- 本地 migration 與 fixture 測試不代表真實銀行同步成功；部署 migration 後仍須一次實際同步取得日期與更新有效清單。

### 華南銀行

信用卡 v2 交易由 `sync.ts` 提供 sourceId 的卡號末四碼，再交給共用 preparation 配對待入帳與
已入帳；跨階段明細序號或名稱不同不影響基本配對，存款、舊交易與摘要帳戶修復沿用既有流程。

- 信用卡未出帳回應只含明確無卡提示時，不再查歷史信用卡帳單，仍解析已取得的存款；其他查詢回應維持既有解析與錯誤處理。
- 華南登入頁沿用一般導覽：先前 CDP 取樣曾在 1.5 秒內看到 `readyState` 為 `complete`，`USERIDTEXT` 與 `doSubmit` 皆就緒，但遠端 Browser Run 仍可能停在 `chromewebdata/` 錯誤頁。改動登入頁載入方式前必須先以 CDP 取樣確認實際停滯點，不得以推測為依據：`setRequestInterception` 會讓導覽停在 `about:blank`、`setJavaScriptEnabled(false)` 會讓 `waitForFunction`／`evaluate` 失效、`document.write` 移植會摧毀執行環境，三者都已實測不可行。Worker `fetch` 若用於輔助抓取必須設 `AbortSignal.timeout`，否則會在有 proxy 的環境無限等待。導覽的 Puppeteer timeout 外另設 6 秒硬逾時，避免 CDP 操作超時卻持續等待。登入表單或驗證碼沒出現時記導覽狀態及失敗請求的網路錯誤；自動同步在送出登入前依共用政策關閉舊 session 後重開，最多三次準備，耗盡才以連線失敗結束；只有明確的驗證碼錯誤才重試 OCR，不明登入結果不重送帳密。驗證碼準備工作限 35 秒、同步工作限 120 秒，逾時先清理 Browser session 再回報失敗（清理最多另需四秒）；透過 Browser binding 確認遠端 session 已關閉。新建的自動同步 session 使用 60 秒閒置期限，準備人工驗證碼則保留 150 秒。
- 華南分頁必須常駐 dialog 自動關閉 handler。未預期的 `alert` 會凍結頁面 JavaScript 並使自動化停止回應；送出登入時另有 handler 記錄訊息做成敗分類，兩者並存。

### 第一銀行

信用卡交易由 `sync.ts` 提供帳戶的卡號末四碼，使用共用 preparation 銜接待入帳與帳單明細。
同一 feed 內相同 identity 的多筆消費以 occurrence 保留，第一筆沿用舊 ID，第二筆起加序號；
不再因去重而遺失同日同額同店的真實消費。

第一銀行遇到 `MULTI_SESSION_LOGIN` 回覆時，視為目前登入受阻並標記
`needs_user_action`；不將「您已成功登入」文案視為可用 session 的證據，
不點擊該回覆頁的確認、不重送帳密、不重試 OCR，也不歸類為驗證碼錯誤。
既有／人工驗證 session 亦須先檢查此回覆，不能被舊登入標記略過。

第一銀行信用卡切換必須保留頂層網銀 frameset，確認其
`getMenuObjById` 函式可用；遺失時以既有 session 回到 `/NetBank/frame.html`
並等待導覽環境載入，之後只在子頁框開啟功能總覽。
不得把頂層內容頁直接導到 `01.jsp`，也不得直接導到信用卡 bridge 作為 fallback，
以免缺少官方選單／SSO 初始化而落入登出頁。
信用卡入口直接觸發既有 `a[data-func]` 的 click handler，不依賴服務總覽
選單展開或元素可見性，也不改寫銀行表單或自行組裝信用卡請求。
只有入口不存在時重新取得功能頁並最多重試一次；觸發後導覽／context 中斷
則等待原查詢回應，不重複送出。未確認無卡時，三種預期 API 回應仍須完整取得才算成功；
入口失敗以 `card-entry-*` log 區分，錯誤內容須遮罩。

信用卡階段的原生 alert、功能頁明確無卡提示，或預期信用卡 API 的 `HEAD.RETURNDESC` 明確回覆無卡時，保留存款與交易，以 `hasCreditCard: false` 略過信用卡流程。只有入口缺失、頁面未就緒或 API 未回應仍失敗；`未申請網服會員` 不代表無卡。HTTP 非成功回應不接受為無卡資料。

真實無卡帳號點擊信用卡功能後，銀行不顯示無卡文案，而是經 `/cmsweb/conn/netbanktrust` → `/cmsweb/Detail/BillingQuery` 轉到 `/cmsweb/Home/Logout`（「您已登出信用卡會員服務系統」），之後不會有任何信用卡 API 回應。信用卡階段尚未取得任何信用卡回應時被導到此登出頁，視為無卡並記錄 `card-member-logout`；已取得任一信用卡回應後才出現登出頁時不視為無卡，仍依未回應規則失敗，避免丟棄已取得的帳務。

同一個無卡帳號從 Cloudflare Browser Run 連線時，銀行不轉到登出頁，而是停在 `BillingQuery`：帳單月份清單 `/cmsweb/Common/sendCMSQRY9999` 回 `ResultCount: "0"` 且 `Result` 為空，頁面因此不送 `CMSQRY0014`。帳單月份為空只代表沒有可查的帳單，記錄 `card-bill-dates-empty` 後繼續查近期繳款與未出帳；`CMSQRY0006` 的 `REFRETURNDESC`「查無卡人」或 `CMSQRY0008` 的 `RETURNDESC`「查無卡片資訊」才視為無卡。同一帳號、同一 Chrome 版本、同樣的 Browser Run 請求標頭從住宅網路連線仍走登出頁，兩種回應的差異來自連線來源，本機重現 Cloudflare 行為需把 `BROWSER` binding 設為 `remote = true`。

信用卡會員系統登出後，網銀 session 已無法續用，但銀行仍保留約十分鐘的單一登入鎖，期間重新登入會收到 `MULTI_SESSION_LOGIN`。此情況在擷取結束時呼叫網銀頁框自己的 `logout()`（送出至 `/NetBank/logout.html`）釋放登入並記錄 `netbank-logout`；有卡帳號維持既有的 session 續用，不主動登出。

交易明細頁的說明文字（如「帳戶交易明細查詢提供交易時間資訊」）可能比「帳號 …」先出現，解析頁面帳號時逐一檢查每個帳號／帳戶標籤，取第一個帶帳號數字的值；多個存款帳戶時才能正確對應明細。

交易明細查詢頁一次只查下拉選單中的一個帳號。同步時依序查詢選單中每個非 placeholder 帳號（上限十個），每個帳號各送一次查詢並記錄 `0101-account-complete`，`transactionHistoryHtml` 為各帳號頁面的陣列。前一個帳號的 CDP／HTTP／Fetch 事件可能在下一個帳號開始查詢後才抵達，因此每個帳號使用新的擷取狀態，並在銀行送出請求時把該請求綁定到當時的擷取狀態（CDP 以 request id，Puppeteer page response 以 request 物件）；之後同一請求的回應、完成與失敗事件都寫回同一份狀態，不會被下一個帳號誤用。

第一銀行同一帳號同時只能有一個操作中的網路銀行登入。若頁面顯示「已登入導致無法操作」等占用訊息，與上述 `MULTI_SESSION_LOGIN` 回覆不同，同步會先嘗試一次確認／接管；仍無法進入時標記 `needs_user_action`，不得再當成圖形驗證碼失敗而重試 OCR。排程與手動都不強制登出其他裝置上的工作階段。

### 凱基銀行

- 凱基每次同步都需要 6 位數圖形驗證碼。手動與排程同步預設以 Workers AI 自動辨識，每次登入最多嘗試三張新驗證碼；連續失敗時標記 `needs_user_action`。`prepareChallenge` 保留人工 fallback，以 Browser Run 開啟登入頁、填入帳密並回傳驗證碼圖片，同步時接回同一 Browser session 送出。
- 凱基登入頁以 Ionic `ion-img.recaptcha-image` 顯示驗證碼，base64 圖片可能位於 host `src` property 或 Shadow DOM 內的 `<img>`；connector 必須同時支援這兩種位置，並保留舊版一般 `<img>` fallback。
- 凱基新版登入按鈕沒有 `type="submit"`，以 `button.btn.btn-primary.w-100` 識別，並保留舊版 `button[type="submit"]` fallback。按鈕不存在或表單驗證尚未使按鈕啟用時必須停止，不得視為已送出登入。
- 凱基身分證與密碼欄位會在輸入過程動態改成遮罩值，不得以 Puppeteer `type()` 逐字輸入，否則後續字元會寫入遮罩後的文字。必須一次設定完整值並派送單一 `input` / `change` event，再以 Angular `ng-valid` 與登入按鈕狀態確認。
- 凱基同一身分證只允許單一登入。遇到 `connect/token` 回應 `isSSOExsit` 時，手動與排程同步都比照使用者操作確認「繼續登入」，會登出行動銀行 App；同步結束（成功或失敗）都呼叫 `Account/AccountLogout/Logout` 釋放登入。
- 凱基連續三次密碼錯誤會停權。`connect/token` 被拒絕或頁面顯示密碼／代號錯誤時一律標記 `needs_user_action` 並清除驗證狀態，不得重試；只有尚未送出帳密且頁面明確顯示驗證碼錯誤時才視為驗證碼錯誤。
- 凱基資料由登入後頁面自身 API 請求的授權 header（`authorization`、`ocp-apim-subscription-key`、`x-c-*`）於頁面內呼叫 `TwdDemandDepositDetail/AcctQuery` 與 `TxnQuery`；交易 `sourceId` 以帳號、秒精度交易時間、金額與交易後餘額雜湊，不依賴 `recNo`。

### 樂天國際銀行

- 樂天每次同步都需要 4 位英數圖形驗證碼，並重新以 Browser Run 登入（`browser_captcha_session`，但不復用 session）。手動與排程同步預設以 Workers AI 自動辨識，只有「驗證碼錯誤」（含辨識結果長度或字元不符）會重試，最多三次；連續失敗、辨識服務不可用或剩餘時間不足時拋出 `ManualCaptchaRequiredError`（HTTP 400 `MANUAL_CAPTCHA_REQUIRED`），標記 `needs_user_action`，前端接著呼叫 `prepareChallenge` 取得人工驗證碼。人工驗證碼有效時優先使用，逾時則退回自動辨識。
- 同步臺幣活存帳戶、每日餘額快照與臺幣活存交易明細。登入後由頁面在載入前注入的攔截器讀取網頁自己解密後的首頁 API（`CHMQU0001`）回應，取不到時才改讀「臺幣存款」頁面文字。存款採白名單：只接受主帳號或明確標示為樂天（銀行代碼 826）的臺幣帳戶，他行、外幣與轉入對手帳號一律排除；解析不到存款視為頁面結構改變並整次失敗。
- 餘額快照 `sourceId` 帶上 UTC 日期（`snapshot:rakuten:<帳號>:TWD:YYYY-MM-DD`），每天保留一筆，同一天多次同步只覆寫當天那筆。
- 臺幣活存明細在首頁存款讀取完成後才進行：點頁首選單「存款」→「臺幣存款」，讀取頁面攔截到的 `CTWQU0001/010`（當月）回應；再開頁面的月份下拉選單，依按鈕顯示的當月往前選月份，讀取 `CTWQU0001/011` 回應，共取 `BANK_SYNC_MONTHS`（3）個月。下拉按鈕與選項由 Angular 在回應到達後才渲染，找不到時每 200 毫秒重試、最多等 3 秒，且不得點彈出視窗裡的元素。每月的 `txDetails` 由 `apps/worker/src/sources/rakuten/deposit-transactions.ts` 解析：`amt` 沒有正負號、`amtSign` 語意也沒有保證，因此收支方向由相鄰兩筆交易後餘額的差推得，每月最舊一筆沒有前筆可比，只有在其他筆的餘額差與 `amtSign` 一致印證時才採用 `amtSign`，仍得不到方向的月份整月略過而不猜測。交易 `sourceId` 以 17 碼 `pk` 為主，沒有時才以日期、時間、金額、類型與餘額組合，交易對象若有非數字的約定帳號暱稱就用暱稱，否則對手帳號只保留末四碼（`****1234`），不寫入完整帳號；備註夠短才附在交易類型後。目前尚未實作分頁：回應標示 `dataEnd === false` 或 `dataLimit === true` 時保留已回傳的資料並記錄 `rakuten_tx_truncated`；沒有交易的月份不算截斷。
- 明細只是附加資料：找不到選單、月份下拉、回應逾時、時間不足或整月解析失敗，都只記錄事件（`rakuten_tx_fetch_skipped`、`rakuten_tx_fetch_failed`、`rakuten_tx_skipped`，內容只有原因代碼與月數、筆數），不讓同步失敗，餘額快照照常寫入。
- 同步逾時上限為 55 秒（登入與首頁存款）；活存明細與其後的解析階段使用延長後的 75 秒期限，並固定保留 8 秒給登出與收尾，剩餘時間不足 5 秒就不再抓下一個月份。每次同步結束一律點頁首「登出」並確認，再關閉瀏覽器，登出失敗只記錄事件，不影響同步結果。同步摘要 log 另含 `depositTxnMonthsFetched`、`depositTxnCount` 與各階段耗時 `loginMs`、`dashboardMs`、`depositTxnMs`、`logoutMs`。
- 安全規則：
  - 不重用銀行 session／cookie。`browserSessionId`、`captcha` 是一次性 challenge state，成功或失敗後都清除；設定 schema 不得新增 `sessionCookies`、`sessionCreatedAt` 之類的欄位。
  - 只有「驗證碼錯誤」可以自動重試。帳密錯誤、重複登入、新裝置驗證（簡訊／Email／晶片卡綁定）、系統維護與結果不明一律立即中止，避免帳號被鎖。
  - 遇到「其他裝置已登入」等確認視窗絕不點擊接管或強制登入；原生對話框只接受 `alert`，`confirm`／`prompt`／`beforeunload` 一律 dismiss。
  - log 不得包含帳號、餘額、交易金額、對手帳號、姓名、頁面內容、API 回應內容或帳密，只記錄事件名稱、欄位名稱、數量、長度、狀態碼、原因代碼、耗時與去掉 query 的路徑。
  - 每次同步結束一律 `browser.close()`；只有 prepare（人工驗證碼）階段可以 `disconnect` 保留瀏覽器。
  - 測試與 fixture 只使用合成帳號與金額。

### 兆豐銀行

- 使用 App 2.5.19 的 MobileFirst API：OAuth client credentials、`/main/init`、App 初始化、五位數字驗證碼、E2EE RSA／TripleDES 帳密登入。一般登入不要求快速登入或裝置綁定。
- 人工驗證碼的待登入 session 只保存於 `encrypted_config`，兩分鐘到期，成功或失敗後清除；排程同步使用 Workers AI 辨識。`sync_cursor` 只含同步時間。
- 登入回應的 `resultType` 與官方網銀前端相同：`0` 成功、`1` 重複登入、`3` 提示綁定裝置、`6` 已有兩台裝置、`7` 已綁定等；`3` 不影響查詢權限，連接器不做裝置綁定。`isTrustUser` 是信託戶旗標，與裝置信任無關。
- 登入後依官方前端 `do2FactorCheck` 判斷：`secondFactorFlag=Y` 為雙重驗證，連接器不支援，登出並中止；否則 `isHighIpFar=true` 表示異地登入，必須完成簡訊或 Email 驗證碼，未驗證前查詢回 `SYS014`「權限不足」。簡訊驗證只在短時間內有效：驗證後約 15 分鐘內再登入不需簡訊，約一小時後同一個虛擬裝置再登入仍會被標為異地，因此排程同步無法長期免簡訊。
- 異地登入只在手動同步處理：以 `megapmb` 呼叫 `/fco/fco00001/getverifycode`（`type=sms`）請銀行寄簡訊，回應的 `checkCode`（簡訊檢核碼）放入 `MEGABANK_SMS_OTP_REQUIRED` 訊息供使用者對照；已登入的工作階段以 `authenticated=true` 序列化後寫回 `encrypted_config` 的 `pendingSession`，三分鐘到期、只供這一次驗證使用。使用者送出 `otp` 後呼叫 `/fco/fco00001/validatecode`，`success=true` 才接續同一個登入查詢並登出；`success=false` 回 `MEGABANK_OTP_INVALID` 並保留工作階段讓使用者重輸；非 `0000` 代碼、逾時或其他錯誤一律登出並清除狀態。排程同步遇到異地登入直接登出、標記需要使用者處理，不觸發簡訊。
- 新一輪同步若發現上一輪等待驗證碼的已登入工作階段仍在設定中，會先盡力登出再重新登入。
- 虛擬裝置識別（`deviceCode`、`deviceUKey`、`deviceSeed`）在第一次人工取得驗證碼時產生並寫入 `encrypted_config`，之後的驗證碼 session 與登入都沿用同一組，比照 App 同一台裝置，讓短時間內的連續同步沿用剛完成的簡訊驗證；它不等於 App 的「綁定裝置」（登入回應 `resultType=3` 的提示），無法讓之後的登入長期免簡訊；帳密變更時依 `resetOnCredentialChangeFields` 重設。它只是裝置識別，不含 cookie 或 token，不屬於重用銀行 session。
- 登入後無論同步成功或失敗，都依 App 流程呼叫 `/fco/fco02011/logout` 釋放銀行工作階段；登出失敗不覆蓋同步結果或原始錯誤。
- 查詢回 `SYS014` 時會提示先登出網銀再試，連接器不自動接管其他登入。
- 驗證碼準備及同步後的設定寫入會比對當初讀取的加密設定；promotion batch 也先檢查同一版本，期間若憑證已更新，不寫入舊帳務、舊憑證或同步游標。
- 兆豐同步工作建立時停用；首次成功同步後會比照永豐、台新與王道自動啟用。若使用者之後手動停用，再次手動同步不會重新啟用。
- 存款清單取 `/fco/fco10001/home`；臺幣交易按帳戶查 `/fao/fao01001/query`，最多回溯三個月並處理 `tsqName` 分頁。外幣帳戶與餘額會同步，不查詢外幣交易。
- 信用卡總覽與餘額取 `/fco/fco10007/home`，近三期帳單取 `/fao/fao01009/home`，消費取 `/fao/fao01010/home` 與 `query`。總覽 `creditCardBillInfoList` 為空時視為沒有信用卡，不查帳單與卡片清單、只同步存款；總覽有卡但帳單或卡片清單缺少預期欄位時仍整次失敗。
- 總覽 `creditCardBillInfoList` 依 `ACCT_TYPE` 與 `CURR_CODE` 區分；`ACCT_MON=999912` 是未出帳，其餘僅取各組最新一期計算目前應繳，不累加歷史帳單。消費的 `acctMon=999912` 表示未入帳。
- 信用卡消費由 `sync.ts` 提供 `raw.cardLast4`，使用共用 preparation 銜接待入帳與已入帳。同次回應兩個階段的 occurrence 不同時保留原授權列並隱藏；之後舊 sourceId 改以已入帳回傳時更新既有配對目標，避免重複顯示。配對與偏好移轉受同一加密設定版本保護。
- 存款交易 sourceId 為 `megabank:deposit:tx:<hash(帳戶|日期|金額|摘要)>:<occurrence>`，不含 `serialNo`／`seq`：這兩欄是當天的交易順序，同日稍後有新交易入帳就會變動，納入會讓同一筆被重複寫入。舊格式 sourceId 在寫入前由 `syncMegabank` 對帳（`sources/megabank/transaction-reconcile.ts`）：同帳戶、同日、同金額、同摘要的既有列（最舊 `created_at` 優先）沿用其舊 sourceId，使寫入路徑更新既有列而非新增，既有列的 id、使用者偏好與分類覆寫不受影響；不刪除、不改寫既有列，log 只記 `megabank_tx_source_reconciled` 的 `remapped` 筆數。
- 帳戶與卡號只用於請求和雜湊識別；持久化的 `raw` 只保留末四碼。任何關鍵回應無法解析時整次同步失敗，避免部分更新。

## 將來銀行

使用網銀帳密，直接呼叫網銀內部 Web API 登入與查詢；圖形驗證碼支援 AI 自動辨識或人工輸入。單次登入、查詢後登出，不接管其他工作階段。主帳戶查詢最近三個月，活存口袋讀取所有分頁後依日期篩選；定存口袋同步餘額，基金與美股未接入。排程預設停用。設定 CAS 與原子寫入 guard 防止查詢期間變更帳密後仍寫入舊結果。
