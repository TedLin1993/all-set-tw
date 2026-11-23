# Connector 開發規範

新增資料來源先看[新增流程](#新增流程)。維護既有來源時，可直接查[各來源特殊行為](#各來源特殊行為)的帳務規則與限制。

## 共同註冊點

Connector 採三層 registry，直接提供自家存款帳戶的銀行另有存款 sourceId registry：

| 層級            | 位置                                                                      | 責任                                                                                            |
| --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 共用 catalog    | `shared/connector-catalog.ts` 的 `connectorCatalog`                       | ID、顯示名稱、直接存款銀行代碼、連接模式、scope、資料能力、設定欄位分類、表單欄位標籤與顯示順序 |
| Config registry | `apps/worker/src/sources/config-registry.ts` 的 `connectorConfigSchemas`  | Zod schema、設定解析與設定頁 session 狀態判斷                                                   |
| Worker runtime  | `apps/worker/src/features/sync/registry.ts` 的 `connectorRuntimeRegistry` | 手動／排程同步與互動式 challenge handler                                                        |
| 存款 sourceId   | `apps/worker/src/sources/deposit-source-registry.ts`                      | 依約定解析直接存款 sourceId 的帳號段，註冊格式例外，並提供直接存款來源清單                      |

`ConnectorId` 由 `connectorCatalog` 的 key 推得；catalog 每筆 `id` 必須與 key 相同。Config 與 Worker runtime registry 都必須以 `Record<ConnectorId, ...>` 宣告，新增 catalog 項目後，TypeScript 應立即指出尚未補齊的 config 或 runtime。

Catalog 的 `bankCode` 是直接存款銀行代碼的唯一來源：前端資產依銀行分組、API 顯示的銀行名稱、跨來源帳戶比對，以及集保交割帳戶連結直接存款帳戶（`linkCanonicalBankAccountsStatement`）都由此推得；非銀行或尚未接入跨來源存款比對的來源填 `null`。同步通知的來源名稱直接使用 catalog 的 `title`。

宣告 `bankCode` 的來源，存款帳戶 sourceId 必須遵守 `bank:<connectorId>:<帳號或末四碼>:...` 約定：第三段是完整帳號或末四碼（可為 `unknown`），其後可接帳號雜湊、幣別等識別段。`deposit-source-registry.ts` 依此約定取出帳號段，用於推得 `bank_accounts.account_last4` 與顯示「末四碼／末五碼」。既有格式無法遵守時（例如王道多一段帳戶類型），在來源 `protocol.ts` 匯出解析函式並註冊於該 registry 的 `depositAccountOverrides`；第三段不是帳號或末四碼（例如將來銀行使用帳號雜湊）的來源不得宣告 `bankCode`。`features/bank/display.ts` 不逐一判斷來源。

各來源的同步、connector、protocol、API client 與專用配對／修復集中於 `apps/worker/src/sources/<connectorId>`。電子發票與集保使用該目錄的 `sync.ts`／`run-repository.ts` 執行 Queue 分段同步；runtime registry 的 `run` 拒絕單次呼叫，避免繞過 durable run 的進度與鎖。手動同步控制、排程、報告與共用資料寫入仍位於 `features/sync`。

前端資料來源頁直接使用 `connectorList`（依 catalog 宣告順序排列）顯示名稱、說明與順序，設定表單直接使用 catalog 的 `credentialFields`（`key`、標籤與 `text`／`password`／`select` 輸入類型），前端不另外維護 connector 清單或欄位標籤。`select` 欄位須提供 `options`（`value`／`label`），第一個選項為預設值；欄位未設定視同預設，不算憑證不完整，也不列入 `resetOnCredentialChangeFields`（否則會清掉剛送出的值）。例如台北富邦的 `loginMode`（一般登入／信用卡網路會員）。catalog 依資料來源加入的時間排列，越新越下面；新增 connector 一律加在 catalog 末尾。

## 連接模式

新增 connector 前先選擇最接近的連接模式：

| Mode                      | 適用情境                                                 | 現有範例                                                       |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| `api_credentials`         | 帳密或 API Key 呼叫外部 API，可自行更新 token            | 電子發票、中信、新光、聯邦 New New Bank、Binance、MAX          |
| `api_captcha_session`     | App API 登入含 CAPTCHA，challenge 僅短暫加密保存         | 王道、兆豐銀行                                                 |
| `api_device_otp`          | API 登入，首次裝置需要 OTP                               | 集保 e 存摺                                                    |
| `browser_per_sync`        | 每次同步都以 Browser 擷取，可還原來源允許的認證狀態      | 國泰世華、永豐金證券                                           |
| `browser_session`         | Browser 只負責登入，後續使用可復用的 HTTP session        | 玉山                                                           |
| `browser_captcha_session` | Browser 登入含 CAPTCHA，可由 AI 或人工完成並復用 session | 永豐、台新、華南、第一銀行、凱基、台北富邦、遠東商銀、彰化銀行 |

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
- 只在特定身分欄位變更時才重設的狀態（例如中信切換身分證字號或使用者代號時的虛擬裝置）在來源的 `protocol.ts` 宣告，並註冊於 `connectorIdentityResets`；`features/connectors` 不判斷個別來源。
- Challenge 成功、失敗或逾時後都必須清除 CAPTCHA、OTP 與 Browser session reference。
- Log、錯誤回應與 `raw` 不得包含帳密、完整帳號／卡號、cookie 或 token。

## Config schema

每個 connector 在 `apps/worker/src/sources/<connectorId>/protocol.ts` 提供設定 schema 與解析，並在 `sources/config-registry.ts` 註冊：

1. `<connectorId>ConfigSchema`。
2. `<ConnectorId>Config` inferred type。
3. `parse<ConnectorId>Config`。
4. `connectorConfigSchemas` registry entry。
5. `connectorSessionDescriptors` registry entry：依解密後的設定回報 `sessionAvailable`、`verificationPending`、`verificationChannel` 與 `verificationExpiresAt`，不回傳任何 secret。不保存 session 的來源使用 `noSession`，只看 Browser session cookie 的來源使用 `browserCookieSession`；其他判斷放在來源 `protocol.ts` 的 `describe<ConnectorId>Session`。

Schema 需要涵蓋同步期間會持久化的 secret state，否則 Zod parse 會將欄位移除。使用者可不填、但正式同步必要的 credential 可以在 schema 宣告 optional，再由 sync use case 回傳明確的 `NeedsUserActionError`。

## Protocols 與 Worker adapter 邊界

在 `sources/<connectorId>/` 依需要選擇檔案：

- `protocol.ts` 與 client 負責協定、設定 schema、解析與正規化，可獨立於 Worker 執行。
- `connector.ts` 管理 Browser、AI 等 runtime binding，僅在需要時建立。
- `sync.ts` 組合 adapter、共用寫入流程與來源專用 repository。D1 存取留在這一層及 repository。

來源之間透過共用工具協作，不引用彼此的內部實作。新增不同命名的 protocol 或 client 時，需讓根目錄 `.oxlintrc.json` 的相依檢查涵蓋它。

### 瀏覽器與重試

| 階段         | 可以重試的範圍                                                                                                                                                                                                                                                           | 何時停止                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 取得瀏覽器   | 由 `sources/browser.ts` 的 `launchBrowserWithRetry` 建立。建立請求回應 503 時等待 2 秒、5 秒再試；回應 429 時直接拋出 `BrowserRunCapacityError`，不在此函式內等待。使用 `prepareBrowserLoginWithRetry` 的登入準備會依 `Retry-After` 等待後再取得，每次準備最多取得三次。 | 每日額度耗盡、剩餘期限不足或無法確認是否已建立 session 時停止。額度於台灣時間早上 8 點重置。    |
| 準備登入頁   | 使用 `prepareBrowserLoginWithRetry` 的來源，只在送出登入前復原分頁、表單或驗證碼載入。每次最多 60 秒，最多三次，取得與等待共用 180 秒預算，來源較短的期限優先。                                                                                                          | 先確認舊 session 已關閉才重開。人工驗證沿用原 session，帳密遭拒、登入結果不明或已知維護時停止。 |
| 已登入後查詢 | `retryPostLoginStep` 在同一 session 內，對可重入的讀取步驟遇到暫時逾時或網路錯誤時補試一次。                                                                                                                                                                             | 需要重新登入、人工操作、session 已關閉或資料格式不符時結束。                                    |

容量錯誤使用共用的 `BROWSER_BUSY` 與等待秒數。登入頁準備與登入後查詢沿用整次同步期限。診斷只記錄階段、耗時、狀態碼與已去除敏感資訊的路徑。

## 正規化資料契約

- Connector 回傳 `SyncResult`，資料必須符合 `@taiwan-fin-hub/shared`。
- `Connector` 與 `SyncResult` 定義於 Worker 的 `src/sources/types.ts`；其中的金融資料使用同目錄 `financial-types.ts` 的正規化型別，與 `shared/api/bank.ts` 的銀行 API response 契約分開。
- `sourceId` 必須在重複同步間穩定。一般交易不得使用本次同步時間產生 ID。
- `BankBalanceSnapshot.accountId`、`BankTransaction.accountId` 與 `CreditCardBill.accountId` 必須等於對應 `BankAccount.sourceId`。
- 日期使用 ISO 8601；帳單期間使用 `YYYY-MM`；幣別使用大寫代碼。
- 存款帳戶名稱：銀行提供帳戶種類、別名或暱稱時，以 `sources/deposit-account-name.ts` 的 `depositAccountName` 組成「名稱 末四碼 xxxx」，方便分辨同銀行的多個帳戶；沒有名稱時沿用各來源的預設名稱。API 顯示層（`features/bank/display.ts`）只保留名稱與末碼以空格分隔、且末碼與 sourceId 帳號結尾一致的名稱（定存也不再重複附加末碼），其他名稱改顯示 sourceId 推得的「末四碼／末五碼 xxxx」。目前使用的欄位：台新 `accountTypeName`／`ACCT_TYPE_NAME`、永豐 `AcctText`、國泰 `accountTypeName`、玉山 `alias`、中信 `accountNickName`、兆豐 `NAME`、華南帳戶類別、第一銀行暱稱、新光暱稱或產品名、凱基暱稱或帳戶類別、王道 `aliasName`／`accountName`／`productName`（名稱可能帶完整帳號，先移除 6 碼以上數字再組合）；富邦、遠東商銀沿用既有「類別 末四碼」名稱；彰化銀行為固定的「新臺幣活存／外幣活存 幣別 末四碼」。
- 貸款帳戶名稱：各來源一律以 `sources/loan-account-name.ts` 的 `loanAccountName` 依 `loanCategory` 組成「信用貸款／房屋貸款／其他貸款 末四碼 xxxx」（分類未知為「貸款」，缺末四碼時只顯示分類），不使用銀行自帶的產品名稱；銀行產品名稱如需保留，寫入 `raw.productName`。
- `BankTransaction.authorizedAt` 與 `Invoice.invoiceDate`：來源只有日期時使用 `YYYY-MM-DD`；來源確實提供時間時使用含明確時區的 ISO timestamp。不得以補上的午夜或同步時間假造交易時間；台灣來源未標時區的交易時間以 `+08:00` 解讀。
- 補充交易時間時須保留既有 `sourceId` 算法；`postedDate` 維持入帳日期用途。未入帳轉已入帳或重新同步只提供日期時，須保留同筆交易原有的可靠時間。
- 多張卡共用一個信用卡帳戶時，以 `BankTransaction.cardLast4` 標示實際刷卡的末四碼；只有能唯一對應到具名卡片時才填 `cardName`，無法確定就留空，不猜測。兩者只供顯示（交易帳戶名稱顯示為「卡名 · 末四碼」，缺卡名時為「帳戶名稱 · 末四碼」），不得納入 `sourceId`、配對或負債計算，也不改變帳戶與帳單的拆分方式。
  - 共用帳戶名稱不得使用其中一張卡的卡名或末四碼。
  - 目前中信、台新、永豐填卡名與末四碼：中信對照 `cardDataList`；台新取 `cardname`／`order` 去除遮蔽卡號後的文字，同一末四碼出現不同名稱時不填，已入帳沿用同卡名稱；永豐取每筆交易自帶的 `CardName`／`CARDNAME`，但帳單繳款（`自扣`／`繳款`）可能掛在任一張卡下，兩個欄位都不填。
  - 兆豐、華南、富邦、遠東商銀只填末四碼；繳款等不帶卡號的列留空。
  - 第一銀行、玉山以卡片帳戶區分，不需這兩個欄位；國泰、新光的交易資料沒有卡號，未填。
- 支出與負債為負，退款與入帳為正。
- `raw` 只能保留遮罩或白名單資料，主要功能不得依賴 raw shape。
- 信用卡／貸款帳戶的 `autopayAccount` 回報銀行頁面揭露的自動扣繳帳戶：只能放銀行代碼、末四碼，以及能以完整帳號算出的自家存款 sourceId，不得放入完整帳號。頁面明確顯示未設定時填 `null`；該頁未取得或解析失敗時保持 `undefined`，讓既有資料保留。對應與手動覆寫規則見後端文件「信用卡與貸款扣款帳戶」。
- 一般 connector 的資料必須經 `record-mapper.ts` 與 staged persistence；durable-run
  connector 可直接以其 run item table 作為 staging source。資料 promotion 與 cursor
  必須放在同一 guarded D1 batch，secret state 需以設定版本 CAS 保護。

信用卡帳單的缺欄保留是所有 connector 的共用 persistence 行為：`statement_amount`、
`minimum_payment`、`paid_amount`、`payment_due_date`、`statement_closing_date` 均以
`COALESCE(excluded.x, credit_card_bills.x)` 更新；新值為 NULL（含 mapper 正規化後的缺值）
時保留既有值，明確提供的 0、負金額及新日期仍可更新。`is_paid` 共用「一旦已繳，維持已繳」
規則，未知狀態不清除已知狀態；銀行明確回報的已繳狀態修正由該來源的 repository 與
`sync.ts` 組合於 `afterPromoteStatements` 處理，不在共用 persistence 中以 connector ID 分支。

## 信用卡負債

信用卡負債快照一律使用 `sources/credit-card-liability.ts` 的 `creditCardLiabilityBalance`：
**帳單剩餘應繳 + 未出帳總額**，以相反號保存（負數為欠款、正數為溢繳），四捨五入到小數兩位。

- 帳單剩餘應繳是當期帳單扣除已繳後仍待繳的金額；溢繳可為負數。繳款狀態與 `noPaymentNeeded` 仍只依當期帳單判斷。
- 未出帳總額是已入帳但尚未結帳的消費淨額，退款與回饋保留正負號；不含繳款，避免與帳單已繳金額重複扣除；也不含即時授權（待入帳）。
- 優先採用銀行的官方未出帳總額；銀行沒有總額時，只能加總本次回應的完整未出帳明細，不得累加本機歷史交易。任一部分無法確認時不建立快照，不把未知部分當成 0。
- 各來源只負責解析這兩個金額；國泰、新光沒有未出帳資料，遠東商銀改用額度頁「已使用額度」，見各來源說明。

## 信用卡交易階段與共用配對

交易沿用 `pending`（待入帳）與 `posted`（已入帳）兩個狀態，來源負責依銀行資料判定。
未出帳／已出帳是銀行的帳單狀態，不新增第三個交易階段；既有帳單明細仍供補抓／更新，
帳單摘要與餘額快照仍計算信用卡負債。

玉山、台新、永豐、中信、第一銀行、華南、兆豐與台北富邦使用 `features/sync/card-authorization-matching.ts`：
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
- 無卡文案分支以去識別的合成 fixture 驗證，不將合成錯誤代碼視為銀行正式代碼。

## 路由、排程與 challenge

- 一般同步使用 `runConnectorSync`，不要在 route 或 scheduler 新增 connector switch。電子發票與集保的手動／排程入口使用各自的 durable-run service 啟動 Queue 流程。
- 所有 scope 必須先宣告在 `connectorCatalog`；排程工作目前固定使用 `all`。
- 同一 connector 的所有 scope 共用 canonical lock。
- 手動／排程必須把 `createSyncExecution` 的 scoped env 傳給來源同步，不得改用原始 DB 寫入金融資料、session、cursor 或結果。CAPTCHA preparation 同樣使用 scoped env，並維持 3 分鐘期限。Browser 透過共用 launch／connect helper 接收取消訊號；durable HTTP client 傳遞 `syncSignal`。
- 一般同步的 connector 在登入成功、開始取得資料時呼叫 `reportSyncProgress("fetching")`（`sources/sync-progress.ts`）；登入與儲存階段由共用執行流程回報。
- 需要 CAPTCHA／OTP 時，runtime registry 提供 `challenge`（`prepare` 與保底的 `failureCode`），route 依此註冊 `POST /connectors/:id/captcha`。準備失敗的錯誤沿用 `classifySyncError`，錯誤未宣告代碼時回傳該來源的 `failureCode`（HTTP 502）；route 只處理輸入驗證，不新增來源錯誤判斷。
- 手動同步一律由 route 依 runtime registry 註冊 `POST /connectors/:id/sync`，不在 `features/sync/route.ts` 為個別來源新增路由。需要驗證碼、OTP 等接續參數時，在 registry 該來源的 `syncBody` 宣告 Zod schema 與格式錯誤訊息；沒有接續參數的來源省略 `syncBody`，route 不讀取 body。
- API 型 CAPTCHA 來源（兆豐、王道、將來銀行）的自動辨識使用 `sources/captcha-retry.ts` 的 `runAutoCaptchaAttempts`，規則與台新相同：每輪取得新驗證碼、辨識並登入，最多辨識六張、最多向銀行送出三次登入。辨識結果不符格式時拋出 `CaptchaUnreadableError`，不送出登入、不扣登入額度；只有銀行明確回覆驗證碼錯誤時扣登入額度並換新驗證碼。帳密遭拒、登入結果不明或辨識服務不可用立即停止，不重送帳密；耗盡時分別提示登入送出次數或辨識上限，並標記 `needs_user_action`。人工輸入的驗證碼只使用一次。重試只記 `auto_captcha_retry` 的來源、結果分類、累計辨識與登入次數。Browser 型來源因換圖、重開頁面與時間預算各不相同，仍維持各自的重試實作。
- 排程不得主動寄送 OTP；需要互動時標記 `needs_user_action`。
- 若外部服務支援接管其他登入中的裝置，必須明確定義手動與排程的 `force` policy，並在介面與使用文件提示可能中斷使用者目前的工作階段。
- 新 connector 必須透過 D1 migration 建立 `<connectorId>:all` sync job，預設停用並跟隨預設排程。所有來源首次成功同步後自動啟用；失敗或等待驗證不啟用，之後手動停用及既有自訂排程都會保留。

## 核心驗證

不再要求每個 connector 各自建立 config、parser、session、route、scheduler 與 self-check 全套測試。依後端文件的四類核心保障，只針對本次新增的風險擴充既有案例：

- 金額、繳款狀態與交易方向：先以銀行實際畫面或已確認欄位語意建立預期，再保存去識別化 response fixture。可替換帳號與金額，但不可從 parser 的輸出倒推預期；合成 fixture 本身不能證明銀行欄位語意。
- 同步去重、入帳與使用者決定：以共用 persistence 的隔離 D1 測試確認最後資料，不重複模擬每家銀行的相同寫入流程。
- 憑證安全：驗證公開設定／cursor 不含秘密、帳密變更清除舊 session，以及舊同步不能覆蓋新設定。
- 使用者驗證流程：以少量 E2E 代表案例確認，不窮舉銀行 DOM、frame、事件順序或同類錯誤碼。

自動測試統一接入正式 test command，不另維護 self-check 腳本。Catalog、config schema 與 runtime 的註冊完整性由既有型別契約與實作審查確認，不以 type assertion 或 fallback entry 規避。

## 新增流程

1. 在 `connectorCatalog` 末尾加入 ID、`bankCode`、mode、scope、capabilities、欄位分類，以及含標籤與輸入類型的 `credentialFields`。
   設定頁的支援範圍標籤（例如「存款・信用卡・貸款」）由 `capabilities` 產生，須列出實際寫入的資料種類（含 `loan`），並同步更新 README「支援資料來源」表格。
2. 在 `apps/worker/src/sources/<connectorId>` 建立 `protocol.ts`、必要的 client 與 parser，並在 `sources/config-registry.ts` 註冊 config schema 與 session 狀態判斷。
3. 需要 binding 時，在同一來源目錄建立 `connector.ts` adapter。
4. 在同一來源目錄的 `sync.ts` 實作單次同步與 challenge use case，使用 `features/sync` 的共用 record mapping 與 staged persistence；需分段續跑的來源則沿用 durable sync 與 `run-repository.ts` 模式。來源專用的配對、存款生命週期與舊資料修復放在相鄰檔案。
   若來源提供直接存款帳戶，在 catalog 填入 `bankCode`，並確認存款 sourceId 符合「共同註冊點」的格式約定；無法遵守時才在 `sources/deposit-source-registry.ts` 註冊例外。
5. 在 Worker runtime registry 註冊 sync／challenge handler；需要接續參數時一併宣告 `syncBody`，手動同步路由會自動註冊。
   前端需要依代碼接續流程或顯示專屬提示的錯誤，在 `shared/api/errors.ts` 宣告代碼，並讓錯誤類別實作 `sources/sync-error.ts` 的 `toSyncError()`；需要使用者回來處理的錯誤同時宣告 `needsUserAction: true`。不在 `features/sync/error-response.ts` 或 `features/sync/errors.ts` 新增來源判斷。
6. 在前端補上必要的 challenge UI；一般帳密表單由 catalog 的 `credentialFields` 產生，不需另外新增欄位。
7. 透過 migration 建立預設停用的 `all` sync job。
8. 依上述核心風險驗證，更新 README 的支援資料來源表。
9. 執行：

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:backend
npm run verify:web
npm run build
```

若新增的是全新資料 entity，還必須同步更新共用契約、D1 migration、`SyncEntityType`、promotion order、entity config 與 record mapper；涉及資料完整性的新風險時擴充 persistence test。

## 各來源特殊行為

這一節只記錄各來源與共通規則不同的協定、欄位意義、配對規則與已知限制。

### 電子發票

電子發票不使用一般的 `runConnectorSync`。初始化只取得發票清單並寫入 durable item，品項明細一律分段擷取，每段最多 35 張。Run items 同時是 promotion 的 staging，所有 item 完成前不得 promotion；Queue 重送只能接管已過期的 run lease 與 item，不得解除其他 invocation 的 lease。排隊、續跑、寫入與結案見[後端架構](002-backend-architecture.md#電子發票分段同步)。

### 集保 e 存摺

集保的銀行與投資交易按頁擷取，每段最多處理一頁。同一來源的不同 scope 共用鎖及進行中的 run。排程需要 OTP 時，以 `needs_user_action` 結案；使用者提交 OTP 後，在該次手動請求內驗證。排隊、續跑、寫入與失敗結案見[集保分段同步](002-backend-architecture.md#集保分段同步)。

### 玉山銀行

- **登入**：新版網銀走 `/esb/`，欄位為 `input[name="id"]`、`input[name="userName"]`、`input[name="pxssword"]`。重複登入代碼 `9005` 時再送一次「確定登入」。
- **資料端點**：信用卡即時消費與近一年明細來自 `iesc.esunbank.com` 的 `realTime/getDetailResult` 與 `creditLastYear/getFilterResult`；存款明細須先呼叫任務 `home/init` 再查詢。
- **沒有信用卡或存款帳戶**：先呼叫 IESC `common/isCardholder`，只有成功回傳 `rtnCode: "S"` 且 `credit: false` 才略過全部信用卡請求，其他回應照常查詢。外幣存款查詢回 `S001` 且說明為「查無外幣帳號，或您尚未開立外幣帳戶」時視為沒有外幣帳戶，臺幣的對應說明同理；`S001` 也用於其他提示頁，說明不符該幣別時仍使同步失敗。
- **頁面就緒**：刷卡明細頁要同時有 IESC `accessToken`，以及「未入帳」選單或「尚未持有本行信用卡」提示，才開始查詢，避免在頁面初始化輪替 token 時送出額外請求。
- **繳款狀態**：`getCardOverview` 的 `creditCardFeePaid` 為 `true` 時本期帳單標為已繳，否則維持未知。已繳的正額帳單不再計入負債，仍保留未出帳消費與負額帳單的溢繳；帳單保留原應繳金額。
- **交易識別**：即時授權與之後的入帳沿用消費日期、商店、金額與卡片組成 `sourceId`，授權時間只補在 `authorizedAt`。`raw.esunFeed` 標記來源為 `realtime` 或 `history`；同名的即時紀錄併入明細並補上時間。
- **授權配對**：即時紀錄常以支付通道命名（如 `LINEPAY*…`），明細則是特店名稱，因此以共用配對連結，不比對名稱。明細保留正式名稱，只補入授權時間；首次配對時移轉授權的分類、計算偏好與發票關係。即時授權先連到未入帳明細，再連到正式入帳，同一個 batch 依序移轉。沒有 `esunFeed` 的舊資料以「待入帳且 `authorized_at` 含時間」判定為即時授權；卡號不明不配對。同日多筆同額消費的時間可能對調，筆數與金額正確。

### 國泰世華銀行

#### 登入

- **登入公告**：逐則點「下一則」，最後一則點「我知道了」；未知動作不點，最多處理二十則。公告以 Bootstrap 動畫開啟，動畫結束前的點擊會被忽略，所以最多等 3 秒，直到公告完全顯示（`show`、不透明且 `transform` 回到 `none`）才點選，等不到就視為沒有公告。關閉後在同一頁記下旗標，後續登入嘗試不再等待。
- **OTP 之後**：國泰可能先顯示「密碼已超過半年未更新」並停在 `/MyBank/Quicklinks/Home`。同步點「暫不變更」略過，不變更密碼，並把這個頁面視為 OTP 成功。信任裝置以成功訊息或 `CUB.eBank.DeviceId` cookie 確認；這個 cookie 可能是 HttpOnly，須以 CDP 讀取。兩者都沒有時回報未完成。
- **登入後重試**：存款、外幣活存、信用卡與貸款四個階段各自套用共用的登入後步驟重試。階段重來時捨棄前一次收集的資料；銀行因此導向登出頁時，仍以被登出失敗。

#### 存款

- 只從總覽進入明細頁一次，其他帳戶以明細頁的 react-select 帳號選單切換，避免反覆開啟總覽而被導到 `/OnlineBanking/Logout/SystemError`。帳號與期間以完整文字選取並確認控制項已更新；找不到帳戶或指定期間時整次失敗。
- 公告對話框蓋住選單時，只點「下次再提醒」「我知道了」「關閉」等明確的關閉按鈕。「不要再顯示」會改變帳戶偏好，不點；內容涉及登入、裝置、驗證、授權、密碼或轉帳的對話框也不點。
- 存款總覽 15 秒內沒有出現任何帳號按鈕時，視為未載入完成並失敗，不當成沒有存款帳戶；帳號列讀不到數字金額時也整次失敗，不當成 0 元。目前沒有明確的「無存款帳戶」判斷。
- 進入明細頁先等自動送出的 30 天查詢完成，再依共用回溯期間查詢每個帳戶。只等存款明細請求完成及 500 毫秒內沒有新請求，不受追蹤服務的持續連線影響。以本次 request 物件配對 response，避免拿先前查詢的空回應當結果。
- 請求的 `content.queryFilters` 只能有所選帳戶，`startDate`／`endDate` 的天數須符合期間；`B_ACCT_Q_TransferDetail` 的帳號允許前置補零，其他須與所選帳號一致。
- 回應須為 `returnCode: "0000"` 且包含所查帳戶的 `datas`。`queryStatus` 為 `Success` 或 `NoData` 且明細為空才視為查無交易；`Fail`、缺少帳戶結果、狀態與明細矛盾、非 JSON、帳號或期間不符、HTTP 失敗、逾時或被登出時都不寫入部分資料。

#### 外幣活存

在同一登入工作階段開啟 `FAcctInq/R0101_FDepInq`，監聽頁面自己送出的 `R_ACCT_Q_OverView`。只有 HTTP 200、`returnCode: "0000"` 且 `content.isGetDemandAccountSuccess: true` 時，才解析 `demandAccounts[].details[]`：以 `currencyCode` 與 `balance` 保存原幣餘額（保留小數，不使用臺幣參考值 `equalTwdBalance`），同帳號不同幣別使用 `bank:cathaybk:<帳號>:<幣別>`。成功但清單為空時不建立資料；失敗旗標、未知回應或逾時使整次同步失敗。只同步外幣活存帳戶與餘額，不查外幣交易或定存；`raw` 只保存 `accountSuffix`、`currencyCode` 與 `balance`。

#### 信用卡

- **無卡判斷**：開啟信用卡總覽前，監聽頁面自己送出的 `C_COM_Q_CardStatus`。只有 HTTP 200 且回應為 `returnCode: "0000"` 加上 `cardStatus: "Invalid"`，或 `returnCode` 結尾為 `702` 時，才依官方前端的判斷視為無卡，保留存款並正常完成。其他錯誤或未知格式使同步失敗，並記錄只含 `returnCode` 的 `cathaybk_card_status_unrecognized`。
- **有卡狀態**（`Valid`、`Positive`、`UnKnow`）：最多等 15 秒出現完整的「卡片末四碼」。逾時且沒有卡號時，必須有明確無卡提示，或同時具備信用卡總覽與「立即線上辦卡」內容，才回傳空的信用卡資料；空白、維護、被登出或無法辨識的頁面一律失敗。
- **帳單**：當期與歷史帳單在單次同步內按帳戶、期別與幣別合併，當期優先；當期應繳總額無法解析時，保留同一期的歷史總額（包含 0 與負值）。`HistoryBillList` 只在 `twdAmount` 為有限數值時更新應繳總額。本次明確回報未繳的當期帳單，由 `afterPromoteStatements` 呼叫 `reconcileCathayUnpaidCurrentBillStatements`，把被標為已繳的該帳單改回未繳；歷史帳單與未知狀態不觸發。
- **自動扣繳帳戶**：取自 `C_BILL_Q_RecentBillInfo` 的 `twBillInfo`／`foreignBillInfo`（`autoDebitStatus`、`bankId`、`account`），分別寫入臺幣與外幣帳單帳戶。`Enable` 且有三碼銀行代碼與末四碼時寫入；`NotApply`、`Disable` 為 `null`；`Close`、缺欄或未知值為 `undefined`。帳號在頁面內就只取末四碼。

#### 貸款

在已登入的 OnlineBanking 頁面以官方 API `L_ACCT_Q_OverView` 讀取總覽。先以 `GetJWT` 取得工作階段，缺少 `idType` 時再以 `G_COMM_Q_UserProfile` 取得；token、customerId 與 idType 只在頁面呼叫之間傳遞，扣款帳戶查詢沿用同一個工作階段。每次請求逾時 15 秒，無回應或非 JSON 時重試一次。回應須為 `returnCode: "0000"`，`content.status` 為字串且 `content.accountList` 為陣列。`status: "MaintainTime"` 視為維護。

| API 欄位                                       | 對應                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `account`                                      | 貸款帳號，sourceId 為 `loan:cathaybk:<account>`                                                            |
| `loanType`                                     | 官方 14 種列舉分為三組：房貸類為 `housing`，其他貸款為 `other`，理財型不設類別；未知列舉視為結構不符       |
| `interestRate`、`amountPayable`、`loanBalance` | 利率、本期應繳、餘額                                                                                       |
| `overTimePeriod`                               | 大於 0 時為 `collection_incomplete` 且不帶扣款日；否則取 `nextDeductionDate` 的日期為扣款日（`scheduled`） |
| `alreadyPayPeriod`／`loanTerm`                 | 已繳與總期數，只在官方會顯示期數時帶入（呆帳、`ElasticityLoan*` 與 `Cycle*Loan` 不帶）                     |
| 幣別                                           | API 沒有幣別欄位，與官方總覽一致固定為 TWD                                                                 |

- `isBadDebt: true` 的貸款略過並標記總覽不完整，不停用其他貸款。`status: "Normal"` 的空清單表示沒有貸款，會停用已不存在的貸款。API 取不到工作階段、失敗、維護或結構不符時，改以總覽頁 DOM 解析。
- **扣款帳戶**：逐筆（不並行）呼叫 `L_ACCT_Q_OverViewDetail`，單筆逾時 15 秒，無回應或非 JSON 時重試一次；整體超過 45 秒後不再送出新請求。回應須為 `success: true`、`returnCode: "0000"` 且含 `deductionAccount`。銀行代碼採三碼 `bankId`；沒有 `bankId` 時，只有 `isOtherBankDeduct === false` 才視為國泰世華 `013`。有代碼與末四碼時寫入，`deductionAccount` 為空字串時為 `null`，失敗或缺欄為 `undefined`。只有所有貸款都取不到 API 回應時，才逐筆開啟 `L0101_LoanInqDetail?account=` 明細頁讀取「扣款行庫」「扣款帳號」；部分失敗不開頁補查，避免逼近 Worker CPU 上限。

診斷事件（`cathaybk_loan_overview`、`cathaybk_loan_autopay`、`cathaybk_card_autopay`、`cathaybk_detail_dialog`、`cathaybk_deposit_overview_unavailable` 等）只記錄方法、筆數、結果與回應代碼，不記帳號、金額、日期、token 或頁面內容。

外幣活存與信用卡無卡判斷依官方前端程式與合成回應實作，尚未完成完整同步驗證。

### 永豐銀行

使用一般行動網銀登入頁 `/m/member/login/m_login.aspx`，同一 App session 先取得存款，再取得信用卡資料。信用卡總覽或近期帳單明確回覆無卡時，略過信用卡 SSO 與後續請求，仍保留 `LatestTx` 的「您沒有有效卡」處理；這些情況不建立信用卡帳戶，但保留存款。`查無消費紀錄` 只表示沒有消費；SSO 或授權失敗不當成無卡，存款端點不套用無卡規則。

#### 臺外幣活存

- 查詢與解析位於 `sinopac/deposit-protocol.ts`，Worker adapter 沿用 App JSON transport 與加密 session，不保存新的帳密或 session 欄位。
- 以 POST `/ws/bank/bankbal/ws_bankbal.ashx` 的 `SubInfo` 取得各帳戶與幣別；`AvailBalInt` 為活存餘額、`MaxAvail` 為可用餘額。零餘額仍建立帳戶與快照，`FixBalance` 的綜存定存不納入。帳戶名稱為 `AcctText`（帳戶種類）加「末四碼 xxxx」。
- 每個帳戶依序 POST `/ws/bank/transdetail/ws_transdetailMerge.ashx`，欄位為 `AcctValue`、`Curr`、`QueryType=3`、`StartDate`、`EndDate`（`YYYYMMDD`），依臺灣日期回溯三個月，月底取目標月份最後一天。
- `DataText4` 保留銀行的金額正負號；`DataText1` 為交易日期與時間，只有日期時不補午夜；`DataText2` 是計息日，只存在白名單 raw。HTML 先去除再正規化，摘要與備註中的完整帳號、身分證字號須遮罩。
- `RecordCount` 是最後一筆的 index，有交易時應等於 `SubInfo.length - 1`。筆數不符時切成不重疊的日期區間重查，單日仍不完整就失敗，不提交部分結果。只有交易端點回 `Header=FAIL`、`Message=查無資料` 且 `SubInfo=[]` 才是明確無交易。
- 帳戶 sourceId 使用末四碼、完整帳號 SHA-256 與幣別，不儲存完整帳號。交易 sourceId 由帳戶、交易日、帶正負號的金額、交易後餘額與支票號碼雜湊，另加同組流水號，不依賴備註或時間精度。每日餘額快照以臺灣日期識別。
- 銀行代碼 `807`，透過末四碼與幣別連結集保交割帳戶；存款交易不參與信用卡授權配對。

#### 信用卡帳單與餘額

- SinoCard `accounting/accountinginfo` 的 `BillAmounts` 提供各幣別本期帳務：`CURRBAL` 為應繳總額（保留正負號，可為退款或溢繳形成的負帳單）、`DUEAMT` 為最低應繳、`TotalPaymentAmt` 為本期累計已繳。`TotalPaymentAmt="-"` 表示本期尚無已入帳繳款，解析為 0；最近繳款 `LastPaymentAmt` 與上一期 `PREVPAYAMT` 不替代本期累計已繳。結帳日與繳款期限取自 `BaseData.STMTDATE`、`BaseData.DUEDATE`。
- 餘額快照為同幣別已繳款減應繳總額，負值為欠款、正值為溢繳，非負時標記無需繳款；已繳為 0 且應繳為正時為待繳。缺少或無法解析已繳款時不建立該筆快照；台幣的負應繳仍保留為正餘額，不取絕對值或歸零。
- **未出帳總額**：已請款明細 `OutstandingDetail.Detail` 會包含本期繳款（如「永豐自扣已入帳」），無法確認小計 `SubTotal` 是否已扣掉繳款。因此取本次明細扣除繳款列（摘要含「自扣」或「繳款」的貸方）後的加總，並要求小計等於明細全部加總或扣除繳款後的加總；對不上時該幣別負債視為未知，不建立快照。
- 外幣未列於本期 `BillAmounts` 時，負債只有該幣別的未出帳總額，不建立帳單或繳款期限，也不累加本機歷史交易。繳款狀態以銀行已入帳資料為準，官方說明付款後約 1 至 3 個營業日入帳。

#### 貸款帳戶與應繳資訊

- 依序 POST `/ws/bank/loan/ws_loanaccount.ashx` 列出帳戶，再對每筆呼叫 `ws_loaninfo.ashx` 與 `ws_paydetail.ashx`。`ws_loaninfo` 使用 `AcctValue`、`AcctValueFormat`；`ws_paydetail` 的 `LNMAINACNO` 對應 `AcctValue`、`LNALTNO` 對應 `Sub1_Sub2`，其餘參數取自該筆貸款資料。
- **清單完整性**：回應通過 HTTP、JSON 與 `Header=SUCCESS` 驗證後，處理所有有效的 `SubInfo` 列。有 `RecordCount` 時必須等於末列索引（空清單為 0），不符或有無效列時計為清單錯誤，但仍處理其他有效列。沒有 `RecordCount` 表示完整性未知：不算錯誤，但不得據此停用或刪除舊貸款。
- **欄位**：`LoanKind` 依房屋貸款、信用貸款與其他映射為 `housing`、`personal`、`other`；`BeginLoanDate` 為 `opened_date`；`LoanBalance` 以負值保存；`Currency` 用於帳戶與快照；`LoanRate` 已是百分點，不再乘除 100。`ws_paydetail.TopInfo` 中明確「應繳金額」標籤後的總計值為 `loan_payment_amount`，無法唯一解析時留空；`HeadInfo` 的 `DataValue3`（計息起日／止日）第二個日期為 `payment_due_date`。「繳息金額」與「現有本金餘額」只保留在 raw。
- 單筆失敗只略過無法確認的欄位或帳戶，其他貸款、存款與信用卡照常同步；缺值不以 NULL 覆蓋既有的非空欄位。`Currency` 無法解析時幣別留空、不建立本次快照。

#### 授權與明細配對

- 授權（`LatestTx.Items`）與已請款明細（`OutstandingDetail.Detail`）都存在 `bank_transactions`，以 `matched_transaction_id` 記錄已入帳關係。
- 配對限同卡、同消費日，排除手續費、服務費、不同金額方向與卡片識別不足的資料。既有相同 sourceId 優先；同帳戶、同幣別同金額使用共用配對。剩餘的外幣與調整金額，再以正規化店名相似度及目前匯率下的金額接近度計分，同卡同消費日取總分最大的一對一分配，沒有合理候選就不配對；跨幣別只限同一信用卡摘要帳戶的不同幣別。
- 已入帳保留正式金額、幣別、入帳日與原始 payload，繼承授權時刻；名稱優先沿用待入帳的名稱（空白或預設「永豐信用卡消費」不覆蓋）。每次同步也修復既有配對，即使銀行不再回傳該交易。同 ID 入帳以 `raw.authorizationMatched` 記住配對完成；保有授權時刻的舊已入帳列也視為已完成，不再讓另一筆授權使用。
- 配對、時刻，以及首次配對時的分類、計算偏好（已入帳既有設定優先）與發票移轉，都在同一個 D1 batch。缺少清單或解析失敗不寫入；沒有有效卡時不執行配對。

#### 交易識別與金額方向

- 交易 sourceId 為 `sinopac:card:tx:v2:<幣別>:<消費日>:<簽名金額>:<卡號末四碼>:<序號>`。繳款入帳（正數且摘要含「自扣」或「繳款」）是整份帳單的扣繳，可能掛在不同張卡下，卡號位置改為 `payment-<摘要雜湊>`。舊版繳款列由 `reconcileSinopacCardPaymentStatements` 併入新版列。
- 已入帳明細的 `AMT`（沒有時 `TXAMT`）帶正負號，直接採用，不以關鍵字推測：「回饋金入帳戶」是把回饋從卡片轉出，摘要含「回饋」但其實是扣款。授權（`LatestTx.Items`）的金額不帶正負號，方向只比對摘要與授權結果（`AuthResult`），不比對整筆記錄，因為卡名可能含「回饋」。
- 金額與序號都是識別碼的一部分，方向修正或序號重排會換成新識別碼。`reconcileSinopacCardStaleStatements` 把本次沒有寫入、但屬於同一筆銀行明細的過期列併入新列：已入帳以卡號末四碼、消費日、原始金額、幣別與摘要核對，授權以卡號、授權日、授權時間、授權金額與摘要核對；缺卡號或日期時不合併。
- 合併沿用 `mergeLegacyTransactionStatements`（保留使用者偏好、分類與發票關係），並排在授權寫入之後。

### 台新銀行

#### 存款與無卡

- 先在同一登入工作階段取得存款，再查信用卡。信用卡端點的 `error` 字串或 `error.message` 明確回覆無卡時，以 `hasCreditCard: false` 略過信用卡，仍回傳存款。存款只接受成功回應中的完整空清單為沒有存款。
- **沒有交易權限（`EBF0015`）**：網銀無法查詢某些帳戶的即時餘額，例如證券交割戶，或只有查詢權限的網銀會員。
  - 臺幣：`web1/rb0101/query` 回 `RESULT = ERROR` 與 `(EBF0015)無交易權限` 時，改用 `web1/rb0100/query` 清單中同一帳戶的 `balance`，可用餘額保持未知，不查明細，記錄 `taishin_deposit_overview_balance_used`。
  - 外幣：即時餘額 `getRB08000100QueryRealtimeBalance` 回 EBF0015 時，改用 `getRB08000100Data` 同幣別的 `BALANCE`（活存，不含定存的 `ALL_BALANCE`），不查明細，記錄 `taishin_fx_overview_balance_used`；明細 `getRB08020100ForeignTranDetail` 回 EBF0015 時保留即時餘額，只略過該幣別明細，記錄 `taishin_fx_detail_no_permission_skipped`。`RESULT`／`ERRORMSG` 與 `error` 兩種外層格式都接受。
  - 其他錯誤仍使同步失敗。
- 同步錯誤會遮罩 24 字元以上的 token，因此錯誤訊息以「程式代號 動作」標示端點（例如 `rb0800 QueryRealtimeBalance`），避免長端點名稱被遮成 `[redacted]`。

#### 登入

- **密碼通知**：登入後若出現「每三個月變更一次密碼」彈窗，必須點「關閉」，不點「前往修改」或「3個月後提醒」，也不得停在彈窗就回報成功。session 確認後最多等 15 秒讓 `popupLoginChangePwd` 掛載；`PwdExpired` cookie 存在時，觸發通知內 `button[data-action="hide"]` 的官方 click handler，最多等 5 秒確認通知關閉且 cookie 已清除才查詢。任一步驟失敗都中止同步。重用既有 session 時，若 frame 上沒有通知元件也沒有 `PwdExpired`，可以直接查詢。
- **自動驗證碼**：每次登入最多辨識六張、最多向銀行送出三次登入。辨識結果位數不符時不送出，改用表單的官方 `genAuth` click handler 換圖。每輪在記憶體比對本次已辨識圖片的 SHA-256；重複圖片再換一次，仍重複則停止。只有明確的驗證碼錯誤可重試，帳密遭拒或結果不明立即停止；耗盡時改由使用者人工驗證。
- **換圖配對**：換圖前先註冊等待，只接受目前登入 frame 的 `POST /TIBNetBank/svc/web/login/getToken`，並以同一個 request 配對 response。Token 回應須為 HTTP 成功、`RESULT = NORMAL` 且 `ECTOKEN` 非空；圖片回應須屬於同一 frame 與台新 origin 的 `/TIBNetBank/svc/web/shuffle/NonSessionShuffle`，且 `TOKEN` 對應本次 `ECTOKEN`。只擷取完整載入且可見的 `img._field_item__verify-code`；DOM 圖片來源須等於配對的圖片網址，截圖後再確認圖片仍在文件中且來源未變。
- **圖片未就緒**：驗證碼圖片在檢查後消失、隱藏、尺寸為 0、解碼失敗或在截圖時更新，視為登入前未就緒，沿用共用登入準備的三次嘗試。人工驗證與未帶初始圖片的登入，首次擷取失敗後最多換圖一次。取得圖片失敗時不辨識、不送出，也不扣登入次數。
- **iframe 重建**：台新可能在登入前重建登入 iframe，使已取得的 frame 失效（`Attempted to use detached Frame`）。填入帳密時重新取得 frame，同一頁最多三次；擷取驗證碼、換圖或輸入驗證碼時失效，歸類為 `TaishinLoginFrameDetachedError`，自動登入會重開登入頁，每次登入最多兩次。只在點擊登入前復原，點擊後失效不重送；人工驗證保留的表單失效時，要求重新取得驗證碼。
- **診斷**：`taishin_captcha_captured`、`taishin_captcha_refresh` 與共用的 `captcha_ocr_failed` 只記錄次數、圖片尺寸與位元組數、HTTP 狀態、結果分類與耗時；不得記錄完整圖片網址、Token、驗證碼、模型回覆、圖片、圖片摘要或帳密。

#### 存款查詢

協定依官方網銀 RWD 前端的 RB0100／0101／0102、RB0800／0802 整理，fixtures 使用合成帳務。範圍為同一網銀工作階段回傳的臺外幣活期性帳戶，不含定存、貸款或投資。以下均為 POST，路徑相對於 `/TIBNetBank/svc`；物件 body 使用 JSON，無參數呼叫依官方 axios helper 送空字串。

| 端點                                                                             | 請求／解析                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web1/rb0100/query`                                                              | `RESULT = NORMAL`，`OUTPUTDATA.SavingAccount` 提供 `accountNo`、`accountTypeName`；不使用定存總額。                                                                                 |
| `web1/rb0101/query`                                                              | `{ account }`；`balance` 為帳戶餘額，`availbalance` 為可用餘額，`dtltamt` 不加進活存。                                                                                              |
| `web1/rb0102/listaccount`、`web1/rb0102/query`                                   | 先以 `{}` 初始化並確認帳號，再以 `{ account, start, end }` 查近三個月，日期為 `YYYYMMDD`；解析 `userList`。                                                                         |
| `web2/rb0800/getRB08000100Data`                                                  | `error = null`，`data.FCS_ACCOUNT[].FCS_ACCOUNT_DETAIL` 列出帳號與各幣別活存；不使用 `FTS_ACCOUNT` 或 `ALL_BALANCE`。                                                               |
| `web2/rb0800/getRB08000100QueryRealtimeBalance`                                  | `{ requestAccount, requestAccountAlias, requestCcyCode }`；核對回應 `ACCT_NO`、`CURRENCY_CODE`，保存 `BALANCE`；官方未提供可用餘額，保持未知。                                      |
| `web2/rb0812/getRB08120100Options`、`web2/rb0802/getRB08020100ForeignTranDetail` | 官方 RB0802 初始化使用 RB0812 options。按各幣別以 `requestAcctNo`、`requestCurrency`、`requestStartDate`、`requestEndDate`、`requestDateType = I` 查詢；解析 `data.TRANS_DETAILS`。 |

- **帳戶名稱**：臺幣取 RB0100 的 `accountTypeName`，外幣取即時餘額回應的 `ACCT_TYPE_NAME`，再加「末四碼 xxxx」；沒有種類時只用末四碼。外幣群組的 `ACCOUNT_NAME` 可能是自訂別名，不用於命名。
- **格式驗證**：外幣總覽的 `FCS_ACCOUNT` 接受陣列或物件映射（含空的 `[]`、`{}`）。清單格式驗證失敗時中止同步，Worker 日誌以 `taishin_deposit_schema_validation_failed` 提供最多五筆去重的診斷。診斷只含白名單欄位路徑（動態鍵與陣列索引替換為 `[*]`）、錯誤碼、預期型別與收到的型別，不含欄位值或原始回應。回報問題時可提供下列形式的診斷，不需要帳務資料：

```json
{
  "path": "FCS_ACCOUNT[*].FCS_ACCOUNT_DETAIL[*].CURRENCY_CODE",
  "code": "invalid_type",
  "expected": "string",
  "received": "null"
}
```

- **臺幣明細**：`txnamtOut` 非 `-` 是支出，`txnamtIn` 非 `-` 是存入，兩欄皆為 `-` 時失敗；`sysdate` 為交易日與時刻，`dateNew` 為帳務日。`inNo + outNo` 須等於清單筆數，截斷時拆分期間重查，單日仍不完整即失敗。
- **外幣明細**：`DRWAMT` 是支出，`DEPAMT` 是存入，`ACCT_BAL` 是交易後餘額；零元存款息可能兩欄皆為 `-`，記為 0 元存入。交易日與時刻採 `TRANSACTION_DATE_TIME_DSC`，`TX_DATE` 為帳務日。外幣查詢沒有伺服器分頁，要求完整的 `TRANS_DETAILS`。
- **識別**：帳戶為 `bank:taishin:{last4}:{sha256(accountIdentity)}:{currency}`，完整帳號只用於當次請求。交易 ID 依帳戶、消費日期、正負金額、交易後餘額及臺幣 `procSeq` 產生摘要，再依完整候選集合分配序號；排序、備註或時間精度不影響 ID。快照依台灣日期每天更新，原幣小數與零餘額都保留。銀行代碼 `812`，與集保同帳戶不重複計入資產。

#### 信用卡即時消費與入帳配對

- **即時消費**：每次同步取得銀行當下的完整授權清單 `web4/rb0708rwd/queryRealTime`（官方總覽的 `qryRealTime` 只是最近消費摘要），在摘要與當期帳單初始化後查詢 `value.fmtRealTxListMap`。列 `[3]` 是新臺幣消費金額，`[5]` 須精確等於 `成功`；拒絕、取消或 `未成功` 不計入。店名顯示採 `[6]`，v2 identity 保留 `[2]`，補時間不換 ID。
- **未出帳**：同步 `web4/rb0708rwd/qryUnposted` 的 `value.unpostedTx`，連結授權離開清單後到正式出帳之間的交易。幣別分組以 `001TWD`、`USD` 等 key 與列 `[7]` 核對；`[0]` 為消費日、`[1]` 為入帳起息日、`[2]` 為明細、`[3]` 為約定幣別金額。未出帳與帳單重疊時按 identity 的序號去重，同日同額多筆仍保留。
- **錯誤處理**：完整空清單或明確 `(CRXTIKE004)無消費資料` 可成功。即時消費忙碌或暫時性網路錯誤最多重試三次；缺少必要清單、未知格式或未出帳幣別錯誤不可被可選帳單的降級吞掉。必要查詢途中 session 失效時，沿用一次重新登入，重抓整份存款與信用卡資料後才寫入。
- **配對**：`authorizations.ts` 以共用配對連結歷史未配對授權與本次正式交易（同帳戶、同卡末四碼、同消費日、同幣別同額同方向）。授權摘要可能是類別或公司名，正式入帳是分店名，因此不要求店名相同。卡片或消費日不明、跨日、跨幣別都不配對；來源消失不代表取消。不同 ID 時保留原待入帳列並由共用規則隱藏；舊版借用授權店名 ID 的已入帳紀錄，只在唯一對應時重用原 ID。
- 存款、配對、帳戶關聯與 cursor finalize 受同一個憑證版本保護；查詢或 promotion 失敗時不更新金融資料與 cursor。
- **負債**：當期帳單剩餘應繳加上 `qryUnposted.value.showRB0712_SUBTOTAL` 的官方新臺幣未出帳總額，快照保存合計的相反號。銀行合計已排除繳款與繳款更正，因此不加總明細列，也不加入即時授權。非空明細缺少總額或總額格式無效時失敗；完整空清單或明確無消費可採 0，總額本身為 `(CRXTIKE004)無消費資料` 時視同缺少總額。

Richart 帳戶是否出現在同一份存款清單、人工驗證流程與部署環境的排程同步尚未驗證。

### 中國信託銀行

#### 存款、貸款與信用卡

- **外幣**：先沿用總覽的 `fxAcctSummaryResponse`，缺少時查 `/twrbm-fx/qu001/010`，再以 `/twrbm-fx/qu002/010`、`/011` 取得原幣餘額與近三個月交易。sourceId 為 `bank:ctbc:<末四碼或unknown>:<完整帳號SHA-256>:<幣別>`，`raw` 只保存末四碼與幣別。`9002`、`9004` 視為沒有活存；要求重新驗證時原樣拋出 `CtbcVerificationRequiredError` 並中止；其他失敗略過整個外幣區塊並保留舊資料，臺幣與信用卡照常更新。
- **貸款**：外幣之後以 `/twrbm-invest/qu010/010`（body `{}`）讀取 `rsData.ebLoanAcctSummaryP`／`H`／`LA`／`O`。回應以 `loanType` 代碼為鍵包裝陣列，沒有貸款時為 `{}` 或 `[]`，因此攤平處理；P 為信用貸款，H 為房屋貸款，其他為 `other`。每筆輸出 `loan:ctbc:<loanAcctId SHA-256>`：`loanBalAmt` 以負值保存，`pmtAmt`、`repayDt`、`loanTerm` 分別為應繳金額、應繳日與總期數，已繳期數為總期數減 `remTerm`（缺少時用 `period`）。扣款帳號欄位語意未確認，不寫 `autopayAccount`。貸款是附加資料：查詢失敗或任一筆缺帳號、餘額時略過全部貸款並記 `ctbc_loans_skipped`；要求重新驗證的錯誤照常中止。
- **信用卡**：補查帳期與完整分頁，缺日期、金額或分頁不完整時失敗。每個幣別一個共用帳戶「中國信託信用卡」。`cardLast4` 取自 `cardNoSuffixFour`、`cardNo`、`fullCardNo`（移除尾端 `_…` 標記），欄位互相矛盾時留空；`cardName` 只在 `cardDataList` 中該末四碼唯一且有卡名時填入。
- **已繳金額**：帳單 `pmtAmt` 是該結帳區間入帳的繳款，屬於前一期（`prevBal`）。較早期別的已繳金額取下一期的 `pmtAmt`，且下一期 `prevBal` 須等於該期 `billAmt`，否則未知；最新一期以 `qu006` 未出帳中摘要含「繳款」「扣繳」「自扣」的貸方合計為已繳，沒有未出帳明細時為未知。已繳達 `billAmt` 即為已繳。
- **負債**：最新一期應繳（`currPmtAmt`，缺少時用 `billAmt`）扣除上述未出帳繳款，加上 `qu006` 已入帳未結帳明細的淨額。中信沒有官方未出帳總額，因此加總本次完整分頁明細，排除繳款貸方，不含即時授權。剩餘應繳不大於 0 時標記無需繳款；尚無帳單的幣別只計未出帳淨額。
- **無卡**：登入回應的 `haveCC` 為 `"0"` 時，比照官方 App 不查詢任何信用卡端點。其他情況照常查詢 `/twrbm-card/qu002/010`，若 `cardDataList` 為空陣列且 `billData` 為空物件、`message` 明確回覆無卡，或回傳 `SVC/9902`（官方 App 卡片首頁視為無卡的代碼），保留存款並略過其餘信用卡查詢。登入回應 `haveCC` 為 `"1"` 時，`9902` 仍視為失敗，避免漏掉持卡人的未出帳與即時消費。缺少欄位不觸發。不把 `8888` 或 `ESB/9201` 直接解讀為無卡，登入後仍執行登出。
- **日期**：帳單的消費日、入帳日、結帳日與繳款期限為 `MMDDYY`，未出帳明細為 `YYYYMMDD`，金額與商家欄位為 `purchaseAmt`、`description`；`000000` 不是有效日期。非零已入帳明細無法解析日期或金額時整次失敗。

#### App 版本與登入

- **版本**：`appVer` 須與 Google Play 台灣版公開的 Android 套件版本一致（目前 `5.2.28`），`webVer` 使用 `UtilsService.getWebVersion()` 的回傳值（目前 `(1020)`），不以商店更新日期推測。版本落後時，「我的貸款」等功能會回 `SVC` `0131` 要求更新。
- **登入參數**：`/twrbm-general/ot001/010` 的 `rqData` 須另帶 `version`（同 `appVer`）、`twoStageVerify: true`、`userAgent` 與 `checkDeviceShare: "Y"`；envelope 的 `appVer` 不能代替 `version`。`userAgent` 與 HTTP `User-Agent` 使用與連接器裝置資訊一致的 Android WebView 值。
- **裝置識別**：首次同步在任何銀行請求前產生 `deviceCode` UUID，首次握手後保存銀行發出的 `deviceSeed`，兩者都以設定版本 CAS 寫入 `encrypted_config`；之後所有請求沿用，不以新握手的 seed 覆蓋。初始化、登入或驗證失敗也保留；修改密碼只清除 `pendingSession`，修改身分證字號或使用者代號才清除兩者。銀行把未綁定設備的行銀視為陌生裝置，App 核准只完成當次登入；連接器沒有做設備綁定或網銀信任登記，行銀握手也回傳空 seed，因此目前每次同步都需要核准。
- **兩階段驗證**：回應含 `isTwoStageLogin: true` 時，把這次登入的 OAuth／驗證 token、seed、clientNo、原始加密登入資料、驗證方式與期限存入 `encrypted_config.pendingSession`，期限依 `twoStageCountDownSec`，最多五分鐘。不保存 OTP、Email、Email 驗證識別或完整回應，也不放入 `sync_cursor`、公開設定、錯誤或日誌。設定 API 只提供驗證中狀態、App／Email 方式與到期時間。
- 手動同步接續同一次登入，不重新 bootstrap 或產生加密 PIN：
  - **App**：使用者在已綁定 App 核准後，按「我已確認，繼續同步」才呼叫 `/ot001/002`；`keepListen: true` 保留等待，`keepListen: false` 且 `twoStageVerifySuccess: true` 才接續，沒有背景輪詢。
  - **Email**：使用者按「改用 Email 驗證」才呼叫 `/ot001/003`（`genType: "2"`），回應的 Email 與驗證識別都非空才切換，同一 challenge 不重送寄信；四位數 OTP 送至 `/ot001/004` 的 `twoStageVerifyEmailAuthCode`，銀行明確回覆成功才接續。
  - 成功後以原始加密登入資料向 `/ot001/010` 傳入 `loginType: "TWO_STAGE_VERIFY"`。過期、拒絕或失敗時清除暫存，由使用者重新開始；成功登入後清除，查詢結束仍登出，不跨次重用。
- **需要官方 App 處理**：`verifyData.verify` 為 `11` 或 `21`（聯絡方式驗證），或有 `verifySharedDeviceTimestamp`、`deviceBindBlackListCheckTimestamp` 時，停止並提示使用官方 App；後兩者的確認可能解除其他裝置綁定，不自動送出。`forcePwdChange` 非 null 時停止，提示至官方 App 變更密碼並更新設定。沒有這些訊號時才送出重複登入時間戳確認，驗證後的確認沿用 `TWO_STAGE_VERIFY` 與同一工作階段。上述狀態都標記 `needs_user_action`，暫停排程直到手動同步成功。
- **連線**：正式環境與遠端開發由 Worker 直接連線 `https://eb.ctbcbank.com/IMP/`，本機 `npm run dev` 使用 loopback Node TLS relay。銀行以是否為已綁定裝置判斷兩階段驗證，與連線機房無關，因此不經 Durable Object 代發。免費 Cloudflare 無法保證固定的台灣出口 IP。
- **診斷**：`ctbc_mobile_resource_failed` 與 `ctbc_login_verification_required` 只記錄銀行 HTTP 狀態、登入請求次數、版本欄位、回應碼型別、描述分類與固定的驗證旗標，不記錄帳密、帳號、cookie、token、OTP、原始 HTML 或確認時間戳。`SVC/0131` 與更新提示的分類只描述回應訊號，不代表已確認根因。
- 寫入在同一個 promotion batch 核對登入時的設定版本；期間帳密已更新時，回滾金融資料、授權合併與 cursor。

#### 授權與入帳合併

- **配對**：優先使用雙方相同授權碼的 SHA-256 摘要、同幣別、同方向金額且雙向唯一；卡號已知時必須同卡，雙方都有消費日時必須同日，不以入帳日代替。其餘使用共用配對；授權碼明確不同時禁止金額配對，不跨幣別推估。原始授權碼與交易參考號不寫入 raw，只保存摘要。
- **合併**：配對成功後保留待入帳原列，升為已入帳並沿用其 ID、消費時間與使用者設定；名稱、入帳日與正式金額改用已入帳明細，再刪除已入帳的重複列。卡號、卡名、分類、計算偏好與發票以待入帳的既有設定優先，沒有時才從已入帳補上；兩端都連結發票時不合併。原列以 `raw.authorizationMatched` 記住配對完成，`syncSourceId` 記住正式來源識別。舊版以 `matched_transaction_id` 隱藏的配對，會在下次同步改為合併。待入帳回應不會將已入帳降回待入帳。
- **無授權碼的明細**：繳款、年費等明細在未出帳（`qu006`）與帳單（`qu002`）的來源識別不同，結帳後會以新識別回傳。寫入前比對本次未回傳的舊列與本次回傳的列：同帳戶、同幣別、同方向同額、正規化名稱相同；雙方都有消費日時須同日，否則比入帳日；卡號已知時須同卡。先合併互為唯一的兩列，其餘只有完全可互換且筆數相同時才逐一合併，否則保留。合併保留舊列的 ID 與設定，並以 `syncSourceId` 記住帳單識別。
- 日期解析修正前寫入的無日期帳單紀錄，只在銀行再次回傳且能唯一對應時修復；無法唯一修復時不寫入本次同步。

Email 驗證與部署環境的同步尚未驗證。網銀的「信任此瀏覽器」流程無法以直接 HTTP 或 Browser Run 載入登入表單，目前未採用。

### 新光銀行

資產總覽 `HasValidCreditCard: false` 時不查詢信用卡 API，仍同步臺外幣存款與交易；未知的旗標型別視為協定錯誤。

信用卡 `RemainingDue` 回傳 `NA` 時視為欠款金額未提供，仍同步帳戶與歷史帳單，但不建立本次信用卡餘額快照，也不推算已繳金額或繳清狀態；既有快照保留原時間。其他無法辨識的欠款文字仍使同步失敗。

### 王道銀行

排程與未帶人工驗證碼的手動同步以 Workers AI 辨識四位英數驗證碼，依共用自動驗證碼重試政策；只有 `ObankCaptchaRejectedError` 會重試。

#### 定存生命週期

依官方 FAO01012 頁面，以 `repeats` 取得完整存單清單，再以 `tdAccountNumber` 查詢各筆 `tdDetail`；`contractDate` 為起息日，`maturityDate` 為到期日。連接器沿用清單的帳戶識別碼與餘額，明細只補日期，不保存完整存單號碼。

- 完整清單及逐筆明細全部成功後，才撤下未再出現的定存。缺少清單、明細不符或解析不完整時整次失敗；明確的空陣列可撤下全部舊定存。
- `inactive_at` 是確認來源不再列出存單的時間，不是實際結清日。同時寫入零餘額快照，保留之前的餘額歷史。到期日不作為自動結清條件，來源重新列出時恢復有效。
- 成立活動須有銀行起息日，以及唯一的同幣別活存扣款；本金轉回須有前次有效快照、存單消失，以及其間唯一的活存本金入帳。同幣別有多個活存帳戶、同額候選不唯一、同日無法判定先後，或本金與利息合併入帳時，不推算活動。
- 衍生活動以 `transfer_peer_id` 綁定該活存交易，定存不參加一般同額配對。本金排除收支，另筆利息保留原有分類與計算。缺少來源日期或交易證據的歷史資料不自動補造。
- 既有定存須在部署後同步一次，才會補上起息日與到期日。

### 華南銀行

- **信用卡配對**：v2 交易由 `sync.ts` 提供 sourceId 的卡號末四碼，交給共用配對銜接待入帳與已入帳；跨階段的明細序號或名稱不同不影響配對。
- **帳單應繳**：依序取「累積應繳金額」「本期應繳總額」「本期應繳金額」，值為「-」視為 0；明細表第一列「上期應繳總額」不可當成本期應繳。只有缺少應繳欄位時，才以明細淨消費推算（扣除繳款與退款，最低為 0）。新臺幣正數為消費（存為負數），負數為繳款或退款（存為正數）；未出帳只有退款或繳款時淨額為 0，仍寫入 0 元快照。
- **交易識別**：sourceId 以金額絕對值組成，沒有序號時，同卡同日等額的消費與退款會撞號：消費沿用原 ID，只有撞號的退款或繳款加上 `:credit`。
- **無卡**：未出帳回應只含明確無卡提示時，不再查歷史帳單，仍解析已取得的存款。
- **登入頁載入**：遠端 Browser Run 可能停在 `chromewebdata/` 錯誤頁。修改登入頁載入方式前，先以 CDP 取樣確認實際停滯點；`setRequestInterception`、`setJavaScriptEnabled(false)` 與 `document.write` 移植都已確認不可行。輔助用的 Worker `fetch` 必須設定 `AbortSignal.timeout`。導覽在 Puppeteer timeout 之外另設 6 秒硬逾時。
- **登入失敗**：表單或驗證碼沒出現時，記錄導覽狀態與失敗請求的網路錯誤，自動同步依共用政策重開，最多三次準備；只有明確的驗證碼錯誤才重試 OCR，結果不明不重送帳密。驗證碼準備限 35 秒、同步限 120 秒，逾時先清理 Browser session（最多另需四秒）再回報；自動同步的 session 閒置期限為 60 秒，人工驗證碼保留 150 秒。
- 分頁必須常駐 dialog 自動關閉 handler，否則未預期的 `alert` 會凍結頁面；送出登入時另有 handler 記錄訊息供成敗分類。

### 第一銀行

- **信用卡交易**：由 `sync.ts` 提供帳戶的卡號末四碼，使用共用配對銜接待入帳與帳單明細。同一 feed 內相同 identity 的多筆消費以序號保留，第一筆沿用舊 ID，第二筆起加序號。
- **重複登入**：`MULTI_SESSION_LOGIN` 視為登入受阻並標記 `needs_user_action`：不把「您已成功登入」當成可用 session，不點確認、不重送帳密、不重試 OCR；既有或人工驗證的 session 也要先檢查。頁面顯示「已登入導致無法操作」等占用訊息時，先嘗試確認或接管一次，仍無法進入才標記 `needs_user_action`。排程與手動都不強制登出其他裝置。
- **信用卡入口**：切換時保留頂層網銀 frameset，確認 `getMenuObjById` 可用；遺失時回到 `/NetBank/frame.html` 等待載入，只在子頁框開啟功能總覽。不得把頂層頁直接導到 `01.jsp` 或信用卡 bridge，以免缺少官方 SSO 初始化而被登出。入口直接觸發既有 `a[data-func]` 的 click handler；入口不存在時重新取得功能頁並最多重試一次，觸發後的導覽中斷則等待原查詢回應，不重複送出。
- **查詢逾時**：已觸發的查詢 30 秒沒有回應時，依共用的登入後步驟重試回到信用卡功能頁再查一次。重試前清除已收到的結果；每個請求以送出當下的輪次標記，前一輪晚到的回應一律捨棄。未確認無卡時，三種預期 API 回應都要取得才算成功；入口失敗以 `card-entry-*` log 區分。
- **無卡**：信用卡階段的原生 alert、功能頁的無卡提示，或預期 API 的 `HEAD.RETURNDESC` 明確回覆無卡時，以 `hasCreditCard: false` 略過。`未申請網服會員` 不代表無卡，HTTP 失敗也不當成無卡。無卡帳號依連線來源有兩種畫面：
  - 住宅網路：經 `/cmsweb/conn/netbanktrust`、`/cmsweb/Detail/BillingQuery` 轉到 `/cmsweb/Home/Logout`。尚未取得任何信用卡回應就被導到此頁時視為無卡（`card-member-logout`）；已取得回應後才出現則依未回應規則失敗。
  - Browser Run：停在 `BillingQuery`，帳單月份清單 `/cmsweb/Common/sendCMSQRY9999` 回 `ResultCount: "0"`。這只代表沒有可查的帳單（`card-bill-dates-empty`），仍繼續查近期繳款與未出帳；`CMSQRY0006` 的「查無卡人」或 `CMSQRY0008` 的「查無卡片資訊」才視為無卡。本機重現需把 `BROWSER` binding 設為 `remote = true`。
- **登出**：信用卡會員系統登出後，網銀 session 無法續用，但銀行仍保留約十分鐘的單一登入鎖。此時在擷取結束呼叫網銀頁框的 `logout()` 釋放登入（`netbank-logout`）；有卡帳號維持既有的 session 續用。
- **存款明細**：解析頁面帳號時逐一檢查每個帳號標籤，取第一個帶帳號數字的值。明細查詢頁一次只查一個帳號，依序查詢選單中每個帳號（上限十個）；每個帳號使用新的擷取狀態，並把銀行送出的請求綁定到當時的狀態（CDP 以 request id，Puppeteer 以 request 物件），避免前一個帳號遲到的事件被誤用。

### 凱基銀行

- 每次同步都需要 6 位數圖形驗證碼。手動與排程同步預設以 Workers AI 辨識，每次登入最多三張；連續失敗時標記 `needs_user_action`。`challenge.prepare` 保留人工 fallback，以 Browser Run 開啟登入頁、填入帳密並回傳驗證碼圖片，同步時接回同一 session 送出。
- 驗證碼由 Ionic `ion-img.recaptcha-image` 顯示，base64 圖片可能在 host 的 `src` property 或 Shadow DOM 內的 `<img>`，兩者都要支援，並保留一般 `<img>` fallback。
- 登入按鈕沒有 `type="submit"`，以 `button.btn.btn-primary.w-100` 識別並保留 `button[type="submit"]` fallback。按鈕不存在或尚未啟用時必須停止，不得視為已送出。
- 身分證與密碼欄位會在輸入過程改成遮罩值，不得以 Puppeteer `type()` 逐字輸入；須一次設定完整值並派送單一 `input`／`change` event，再以 Angular `ng-valid` 與按鈕狀態確認。
- 同一身分證只允許單一登入。`connect/token` 回 `isSSOExsit` 時，手動與排程都比照使用者確認「繼續登入」，會登出行動銀行 App；同步結束一律呼叫 `Account/AccountLogout/Logout`。
- 連續三次密碼錯誤會停權。`connect/token` 被拒或頁面顯示密碼、代號錯誤時一律標記 `needs_user_action` 並清除驗證狀態，不得重試；只有尚未送出帳密且頁面明確顯示驗證碼錯誤時才算驗證碼錯誤。
- 資料由登入後頁面自身請求的授權 header（`authorization`、`ocp-apim-subscription-key`、`x-c-*`）在頁面內呼叫 `TwdDemandDepositDetail/AcctQuery` 與 `TxnQuery`；交易 sourceId 以帳號、秒精度交易時間、金額與交易後餘額雜湊，不依賴 `recNo`。

### 樂天國際銀行

- **驗證碼**：每次同步都需要 4 位英數驗證碼，並重新以 Browser Run 登入（`browser_captcha_session`，但不復用 session）。自動辨識只在「驗證碼錯誤」（含長度或字元不符）時重試，最多三次；耗盡、辨識服務不可用或時間不足時拋出 `ManualCaptchaRequiredError`（`MANUAL_CAPTCHA_REQUIRED`），前端改用人工驗證碼。人工驗證碼有效時優先使用，逾時則退回自動辨識。
- **存款**：登入後以載入前注入的攔截器讀取網頁自己解密後的首頁 API（`CHMQU0001`），取不到時改讀「臺幣存款」頁面文字。只接受主帳號或明確標示為樂天（銀行代碼 826）的臺幣帳戶，他行、外幣與轉入對手帳號一律排除；解析不到存款時視為頁面改版並失敗。快照 sourceId 帶 UTC 日期（`snapshot:rakuten:<帳號>:TWD:YYYY-MM-DD`），每天保留一筆。
- **貸款**：點頁首「我的貸款」，讀取完整版 `CLNQU0001/010`（帶 `initPeriod` 等條件的回應）；等不到才退回首頁的精簡版，並以畫面文字補利率、期數與下次扣款；API 取不到時改讀頁面。輸出 `loan:rakuten:<hash>`（個人信用貸款，`personal`）與剩餘本金快照，sourceId 只由貸款名稱雜湊。只有貸款、沒有存款時仍視為失敗。
- **活存明細**：讀取當月的 `CTWQU0001/010`，再以月份下拉選單取得前兩個月的 `CTWQU0001/011`，共 3 個月；下拉由 Angular 在回應後才渲染，每 200 毫秒重試、最多 3 秒，不得點彈出視窗裡的元素。`amt` 沒有正負號、`amtSign` 語意沒有保證，收支方向由相鄰交易後餘額的差推得；每月最舊一筆只有在其他筆印證 `amtSign` 一致時才採用，仍無法判斷的月份整月略過；解析位於 `rakuten/deposit-transactions.ts`。sourceId 以 17 碼 `pk` 為主；交易對象使用約定帳號暱稱或末四碼，不寫入完整帳號。尚未實作分頁：`dataEnd === false` 或 `dataLimit === true` 時保留已回傳資料並記錄 `rakuten_tx_truncated`。
- 明細是附加資料，任何失敗只記錄事件，不影響同步結果與餘額快照。
- **時間預算**：登入、首頁存款與貸款共 55 秒；活存明細延長到 75 秒，固定保留 8 秒給登出，剩不到 5 秒就不再抓下一個月。結束時一律點「登出」並確認再關閉瀏覽器，登出失敗只記錄事件。
- **安全規則**：
  - 不重用銀行 session 或 cookie；`browserSessionId`、`captcha` 是一次性狀態，成功或失敗後都清除，設定 schema 不得新增保存 session 的欄位。
  - 只有驗證碼錯誤可以自動重試。帳密錯誤、重複登入、新裝置驗證、系統維護與結果不明一律立即中止，避免帳號被鎖。
  - 遇到「其他裝置已登入」等確認視窗絕不接管；原生對話框只接受 `alert`，`confirm`、`prompt`、`beforeunload` 一律 dismiss。
  - Log 只記錄事件、欄位名稱、數量、狀態碼、原因代碼、耗時與去掉 query 的路徑，不記帳號、金額、姓名、頁面或 API 內容。
  - 同步結束一律 `browser.close()`；只有準備人工驗證碼時可以 `disconnect` 保留瀏覽器。

### 兆豐銀行

- **協定**：使用 App 2.5.19 的 MobileFirst API：OAuth client credentials、`/main/init`、App 初始化、五位數字驗證碼，以及 E2EE RSA／TripleDES 帳密登入。不要求快速登入或裝置綁定。
- **固定機房**：對 `https://mobile.megabank.com.tw` 的 POST 由 SQLite Durable Object `MegabankEgress` 轉送，物件名稱固定為 `megabank`、`locationHint` 為 `apac`，只允許這個 host 的 POST。這固定的是執行機房；同一機房可能有多個出口 IP，不保證銀行永遠不要求簡訊。
- **驗證碼**：人工驗證碼的待登入 session 只存於 `encrypted_config`，兩分鐘到期。自動辨識依共用重試政策，只有 `0113`（驗證碼錯誤）會重試，每輪重新初始化並沿用同一組虛擬裝置。`sync_cursor` 只含同步時間。
- **登入結果**：`resultType` 為 `0` 成功、`1` 重複登入、`3` 提示綁定裝置（不影響查詢）、`6` 已有兩台裝置、`7` 已綁定。`isTrustUser` 是信託戶旗標，與裝置無關。`secondFactorFlag=Y` 為雙重驗證，連接器不支援，登出並中止。
- **異地簡訊**：即使 `isHighIpFar=true` 也先查詢帳務。只有存款或信用卡查詢回 `SYS014`（權限不足）且登入帶有異地旗標時，才進入簡訊驗證；以回應碼判斷，不比對文字。
  - 手動同步以 `megapmb` 呼叫 `/fco/fco00001/getverifycode`（`type=sms`）請銀行寄簡訊，回應的 `checkCode` 放進 `MEGABANK_SMS_OTP_REQUIRED` 訊息供使用者對照；已登入的工作階段存入 `pendingSession`，三分鐘到期。
  - 使用者送出 `otp` 後呼叫 `/fco/fco00001/validatecode`：`success=true` 才在同一登入重新查詢；`success=false` 回 `MEGABANK_OTP_INVALID` 並保留工作階段；其他錯誤登出並清除。
  - 排程只登出並標記需要使用者處理，不寄簡訊。沒有異地旗標的 `SYS014`，或簡訊後仍回 `SYS014`，提示確認官方登入狀態，不再寄簡訊。
- **虛擬裝置**：`deviceCode`、`deviceUKey`、`deviceSeed` 在首次連線前產生並以設定版本 CAS 寫入 `encrypted_config`，失敗也保留，帳密變更才依 `resetOnCredentialChangeFields` 重設。它只是裝置識別，不含 cookie 或 token，不等於 App 正式綁定，也不保證免簡訊；簡訊驗證只對當次工作階段有效。正式綁定每位客戶只能一支裝置，且會取代使用者手機上的快速登入，連接器不實作，仍送 `isDeviceBinded=false`。
- **工作階段**：新一輪同步發現上一輪等待驗證的工作階段時，先盡力登出。登入後無論成敗都呼叫 `/fco/fco02011/logout`，登出失敗不覆蓋原結果。不自動接管其他登入。驗證碼準備、同步後的設定寫入與 promotion 都核對設定版本。
- **存款**：清單取 `/fco/fco10001/home`；臺幣交易按帳戶查 `/fao/fao01001/query`，最多回溯三個月並處理 `tsqName` 分頁。外幣只同步帳戶與餘額。交易 sourceId 為 `megabank:deposit:tx:<hash(帳戶|日期|金額|摘要)>:<occurrence>`，不含當天會變動的 `serialNo`／`seq`；舊格式 sourceId 在寫入前由 `transaction-reconcile.ts` 對應到既有列，不新增重複。
- **信用卡**：總覽與餘額取 `/fco/fco10007/home`，近三期帳單取 `/fao/fao01009/home`，消費取 `/fao/fao01010/home` 與 `query`。總覽 `creditCardBillInfoList` 為空時視為沒有信用卡。有卡但沒有消費時，`query` 回 `1120`，或回 `0000` 但沒有任何非空清單，都視為 0 筆；回 `0000`、缺 `detailList` 卻有其他非空清單時，視為欄位改名並失敗（記 `megabank_card_transactions_shape`）。總覽依 `ACCT_TYPE` 與 `CURR_CODE` 分組，`ACCT_MON=999912` 是未出帳，其他只取各組最新一期，不累加歷史帳單；消費的 `acctMon=999912` 表示未入帳。消費以 `raw.cardLast4` 使用共用配對，同次回應兩階段序號不同時保留原授權列並隱藏。
- **貸款**：剩餘本金來自 `/fco/fco10001/home` 的 `loanInfoList`，條件來自「我的貸款」`/fln/fln01001/home`，以貸款帳號對應。輸出 `loan:megabank:<hash>` 帳戶與每日剩餘本金快照；種類含住宅、購屋、房屋或房貸為 `housing`，其他為 `other`。`loanInfoList` 為空時不查。貸款是附加資料，失敗只略過貸款並記 `megabank_loans_skipped`（連線錯誤除外）。
- **診斷**：`megabank_device_state`、`megabank_login_result`、`megabank_sms_gate` 只記錄識別來源與指紋、回應碼、旗標與處置，不輸出原始回應、裝置識別、帳密或帳務。`raw` 只保留末四碼；存款與信用卡等關鍵回應無法解析時整次失敗。

### 台北富邦銀行

#### 登入

- 使用網銀 `CMFQU021_Home.faces?menuId=CMF06&showLogin=true` 的「一般登入」（`m1_` 前綴）。三個帳密欄位的 id 與 name 每次隨機產生，只能依 `#tab1 .m1_login_input table.login_tb` 內的位置定位；不使用動態鍵盤。單獨載入登入頁時沒有外層 `ContextFrame`，登入框預設隱藏，連接器補上外層框架的空函式後依官方順序呼叫 `checkLogin('CMF06')` 與 `showLogin()`。
- 送出時呼叫頁面自己的 `doLogin()`，由官方程式加密帳密並 POST `/B2C/B2CLoginServlet`。只讀取該請求的 JSON 分類：`result=true` 成功、`0290` 驗證碼錯誤、`EP32`／`EP40` 帳號或代碼錯誤、`EP34X`／`WP34X`／`WP39X`／`0213` 暫停登入、`0212` 重複登入、`0240` 閒置、`0241` 雙重驗證。
- 驗證碼為 6 位數字，使用共用 Workers AI 辨識，結果不是 6 位數字時不送出。只有 `0290` 會換圖重試（最多三張），其他錯誤一律停止，避免累積錯誤次數。
- `0212` 時官方以 `confirm` 詢問是否接管，連接器一律拒絕並標記 `needs_user_action`。
- 登入後的頂層頁面 `ContextFrame.faces` unload 時會自動登出，因此只在內容頁框（`frame1`／`txnFrame`）切換功能頁，優先使用官方選單中含當次 `ParamValue` 的連結。同步結束都呼叫 `doLogout()`。不復用 session，`browserSessionId`、`captcha`、`otpBrowserSessionId`、`otp` 都是一次性狀態，結束後清除。

#### 網銀代發（FubonEgress）

- Browser Run 直接連 `https://ebank.taipeifubon.com.tw` 會得到 `net::ERR_CONNECTION_RESET`，Worker `fetch()` 則正常。因此以 CDP `Fetch.enable` 攔截每個頁面的請求（`sources/fubon/egress.ts`），改由 SQLite Durable Object `FubonEgress`（名稱 `fubon`、`locationHint` 為 `apac`）代發，再以 `Fetch.fulfillRequest` 回填狀態碼、標頭與內容。
- 只代發該 host 的 GET 與 POST，且只限 `document`、`script`、`stylesheet`、`xhr`、`fetch` 與驗證碼圖片 `/B2C/captchaImage`；其他圖片、字型、媒體與第三方 host 一律中止。Durable Object 再檢查一次 host 與方法，以 `redirect: "manual"` 轉送，由瀏覽器自己跟隨轉址。網銀點擊追蹤 `POST /B2C/click` 固定回 500，直接在本地回 204。
- Cookie 以瀏覽器為準：送出前以 `Network.getCookies` 組成 `Cookie` 標頭，回應的每筆 `Set-Cookie` 交給 `Fetch.fulfillRequest` 由 Chrome 儲存（含 HttpOnly），人工驗證重新連線同一個 session 時也沿用。攔截綁在 CDP 連線上，每次連線都重新開啟。
- **快取**：同一 isolate 以記憶體快取沒有 `Set-Cookie` 的 `.js`、`.css`（上限 8 MB）；Durable Object 另在 SQLite 保存網銀的 `.js`、`.css` 12 小時，只限 GET、HTTP 200、沒有 `Set-Cookie` 且未標示 `no-store`、`private` 的回應。頁面、XHR、驗證碼與帶 cookie 的回應不快取。
- **額度**：Durable Object 的子請求上限為 1,000，一次完整同步的代發次數遠低於此。CDP 回填的 Worker CPU 高於免費方案標示的 10 ms，目前未被中止，屬已知風險。
- 不記錄請求、回應內容或 cookie，只記錄 `fubon_egress_stats` 的筆數統計。

#### 雙重驗證（非信任裝置）

- 官方程式在 `0241` 時會立即寄送 OTP 或 Fubon+ App 推播。連接器在送出登入前，把 `sendTwoFactorOtp` 與 `insertTwoFactorAuth` 換成只記錄的 no-op，由連接器決定是否寄送。
- 排程絕不寄送 OTP 或推播；偵測到雙重驗證即關閉瀏覽器並標記 `needs_user_action`。
- 手動同步依官方畫面的順序（App 推播後改用簡訊或 Email OTP）請銀行寄送 OTP，保留 Browser session（閒置 300 秒、加密保存約 4.5 分鐘），以 `FUBON_OTP_REQUIRED` 結束。使用者送出 6 位數 `otp` 後重新連線同一 session，填入 `#m1_inputOTP` 並呼叫 `doOtp()`，成功後由官方程式接續登入。錯誤未達上限回 `FUBON_OTP_INVALID` 並保留 session；`maxFlag`、逾時或其他錯誤一律清除。連接器不做信任裝置綁定。

#### 資料

| 頁面                         | 用途                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CBOQU003`（menu `CDS0102`） | `form1:resultGrid_DataGridBody` 的帳號、存款類別、幣別、即時餘額與可用餘額。只同步存款類別含「活」且不含「定」的列；同帳號不同幣別各自成為帳戶。                                                                                                                                                                                            |
| `CDSQU001`（menu `CDS0401`） | 帳號選單來自 JS `comboAccountItems`（值為 `012-<16 碼補零帳號>-<幣別>-<類別>`），只查臺幣帳戶。由選單進入時可能只列部分帳戶，選單沒有的臺幣帳戶改由 `CBOQU003` 該帳戶列的「交易明細查詢」進入。以自訂期間查近三個月，回應的帳號與起迄日須與查詢一致；資料列達 `resultGrid:dataGridCurrentPageSize` 時平分期間重查，單日仍滿頁即該帳戶失敗。 |
| `CCCQU002`（menu `CCC0201`） | 正卡人信用額度、本期帳單結帳日、應繳總金額、最低應繳、繳款截止日、繳款狀態、已繳金額與本期帳單剩餘應繳金額。                                                                                                                                                                                                                                |
| `CCCQU003`（menu `CCC0202`） | 近三期帳單，以 `doChangePeriodAction('1'..'3')` 切換並核對 hidden `form1:period`。日期為民國年；卡片列（如「…末４碼1234」，全形數字）切換卡號，無日期的摘要列略過。                                                                                                                                                                         |
| `CCCQU004`（menu `CCC0203`） | 未出帳消費、`消費卡號後四碼` 與官方「臺幣加總金額」。                                                                                                                                                                                                                                                                                       |

- **識別**：存款帳戶為 `bank:fubon:<末四碼>:<完整帳號 SHA-256 前 16 碼>:<幣別>`，銀行代碼 `012`，已加入直接存款來源；快照依台灣日期每天一筆。臺幣交易以帳戶、交易時間、帶正負號金額與交易後餘額雜湊並加序號，`交易時間` 以 `+08:00` 保存為 `authorizedAt`，`帳務日期` 為 `postedDate`。信用卡交易為 `fubon:card:tx:v1:<卡號末四碼或 account>:<消費日>:<帶正負號金額>:<序號>`，不含店名；帳單明細為 `posted`、未出帳為 `pending`，透過共用配對銜接。帳單中出現在卡片列之前的繳款列以 `account` 代替卡號，不參與配對。
- **金額方向**：銀行臺幣金額正數為消費（存為負數），負數為繳款或退款（存為正數）。
- **負債**：快照為 `-(本期帳單剩餘應繳金額 + 未出帳臺幣加總金額)`，帳單保留原應繳總額（可為負的溢繳）。
- **繳款狀態**（`raw.paymentState`，對應 `isPaid`）：與 `CCCQU002` 結帳日相同的帳單依繳款頁判定；較早期別以下一期的「前期應繳總額」（須等於該期應繳總額）與「繳(退)金額」推得，對不上時為未知。`paid`、`payment_processing`（狀態仍「未繳款」但已繳金額已達應繳總額，例如自動扣繳當日）、`no_payment_needed`、`credit_balance` 為已繳；`autopay_pending`（約定自動扣繳且未過截止日）、`unpaid`、`partial`、`below_minimum`、`overdue` 為未繳；缺少金額時為未知。
- **無卡**：只有 `CCCQU002` 缺少繳款欄位且頁面提示符合 `isNoCreditCardMessage` 時才略過信用卡；未知頁面一律失敗。
- **自動扣繳帳戶**：`CCCQU002` 的「自動扣繳帳號」（例如「台北富邦012345****4321」）以開頭的銀行名稱推得銀行代碼並取末四碼；名稱無法辨識時只留末四碼，不自動對應。空白或「未約定」為 `null`；繳款頁未取得、欄位缺少或沒有帳號數字時為 `undefined`。
- **部分失敗**：登入、雙重驗證、工作階段結束、瀏覽器斷線與 Browser Run 額度不足使整次同步失敗；登入後單一資料項（存款總覽、單一帳戶明細、繳款頁、單一帳單期別、未出帳頁）失敗只略過該項，失敗後先確認仍在登入狀態，連續三項失敗即停止。單一資料列格式不符只略過該列。繳款頁或未出帳頁缺少時不建立負債快照。全部失敗且沒有任何帳戶時整次失敗。無論結果都嘗試官方登出。共用同步結果沒有 partial 狀態，因此以 `fubon_sync_summary` 與 `fubon_sync_result` 記錄各資料項的成功、失敗筆數與去識別化原因。
- **數值驗證**：金額接受千分位、小數、正負號、括號負數、後置負號、全形數字與 `NT$`、`元`、幣別前後綴，空白與 `-`、`--`、`－` 視為無值，其他一律拒絕；日期接受西元 `YYYY/MM/DD` 與民國 `yyy/mm/dd`、`yyy.mm.dd`、`民國yyy年m月d日`，拒絕不存在的日期與 1990 至 2100 年以外的值。交易列的支出與存入必須恰有一欄有非零金額。
- Log 只記錄事件、錯誤碼、筆數與去除 query 的路徑；`raw` 只保留末四碼與白名單欄位。

雙重驗證、無卡、查無交易／帳單／未出帳的提示、交易明細超過一頁與 `#deny` 鎖定提示，依官方前端程式與合成資料實作。外幣交易尚未接入。

### 遠東商銀

頁面結構以 fixture（`apps/worker/tests/sources/feib/fixtures/`）記錄，帳號、卡號、分行、商店與金額皆為合成值；不確定處在程式中以 `TODO(feib-live)` 標示。

#### 登入

- 使用個人網路銀行 `Logon/mainIndex6.jsp?loginpage=new` 的「個人戶」頁籤：`#cid0` 身分證字號、`#uid0` 使用者代號、`#pad0` 密碼、`#VERCODE0` 6 位數字驗證碼（`/netbank/VerifyCodeServlet`）。連接器只填入欄位並點擊 `#submitbtn`，由官方 `submitForm()` 以 TWCA E2EE 加密帳密後 POST `TrxDispatcher`，不自行組裝登入請求。
- 官方 `submitForm()` 先以 `ajaxServlet.jsp?func=verifyCode` 檢核驗證碼，錯誤時換圖且不送出帳密。連接器以請求監聽確認是否實際送出登入：未送出且只有驗證碼錯誤時才換圖重試（自動辨識最多三輪、每輪最多三張）；其他格式錯誤、帳密錯誤、鎖定、重複登入與結果不明一律停止，避免連續三次錯誤遭停用。自動辨識耗盡時回 `MANUAL_CAPTCHA_REQUIRED`，可經 `/api/connectors/feib/captcha` 改用人工輸入。
- 登入後的錯誤頁或 alert 文字只在記憶體內分類（帳密、鎖定、重複登入、驗證碼、維護），log 只記分類結果。
- 年度密碼變更提醒（`SSLPwdChng/SSLPwdChngPrompt.jsp`）只導覽官方「下次登入再變更」連結並記錄 `feib_password_change_prompt`；不變更密碼，也不使用會改變提醒設定的「不變更」（`state=fix`）。
- 不復用網銀 session：每次同步重新登入，結束時只要曾送出登入就導覽官方 `toLogout()` 網址。`browserSessionId`、`captcha` 為一次性人工驗證狀態，只存於 `encrypted_config`。

#### 資料

| 頁面                                                     | 用途                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 我的存款 `Logon/SvDeposit.jsp`（menu `2-1-1`）           | 「活期性存款」表的帳號、帳戶類別、幣別與餘額；`selFun1(…)` 提供幣別代碼（新臺幣 `00`）。定期性存款不納入。                                                                                                                                                                                                                             |
| 存款交易明細 `SavAcctTxDtlInq`（menu `2-1-3`）           | 帳號選單 `#acct`，以官方 `checkData('A')` 送出。單次期間依官方 `checkDate2` 不超過二個月，近三個月切成不重疊的整日期間。頁面回顯的帳號與起迄日須與查詢一致；查無交易時沒有結果表格，視為 0 筆。不使用「確認用途」等會寫入銀行端的功能。                                                                                                |
| 信用卡可用額度 `CCMember/queryCardLimit.jsp`（`5-1-4`）  | 帳單結帳日、本期應繳總額、最低應繳、本期累積已繳金額、繳款截止日與信用額度、已使用及可使用額度。                                                                                                                                                                                                                                       |
| 帳單明細 `CCMember/eStatementQry_success.jsp`（`5-1-1`） | 帳單年月選單 `#yyyyMm` 的顯示值為帳單月份（送出值為前一個月）；只送出 `mainForm` 的 `state=eStatementQry`，不呼叫可能進入繳款的 `formSubmit`。結帳日與繳款截止日為民國年；明細只有 `mm/dd`，依結帳日推得年份。卡片列「卡號：…末四碼」（全形）切換之後明細的卡號，之前的繳款列以 `account` 代替；沒有消費日的摘要列略過。同步最近三期。 |

- **無卡**：移除 HTML 註解後，額度頁仍顯示「未持本行有效卡片」且沒有額度表時視為無卡。持卡頁面的 HTML 註解也有這段文字，所以註解不能當依據。
- **額度不可得**：額度頁只顯示「若您欲查詢信用卡可用額度，請洽本行客服中心」時不代表無卡。帳單選單沒有任何期別、帳單頁也查無帳單時，沒有可同步的信用卡資料，不記失敗，`hasCreditCard` 保持未定；無卡帳號的額度頁與帳單頁就是這種畫面。其他情況記錄額度頁失敗（stage `unavailable`），因為缺少額度無法建立負債快照，帳單照常建立。持卡人若額度頁要求洽客服、帳單選單又沒有期別（例如新卡還沒有第一期帳單），會和無卡帳號一樣不記失敗。
- **0 期帳單**：帳單查詢頁沒有摘要且 `#dateMessage` 顯示「查無帳單資料」時記為 0 期，不記失敗；存款明細查無交易同理。選單有期別時必須有選項標明目前期別，否則記失敗。
- **識別**：存款帳戶為 `bank:feib:<末四碼>:<完整帳號 SHA-256 前 16 碼>:<幣別>`，銀行代碼 `805`，已加入直接存款來源。交易由帳號、幣別、交易日期、帳務日期、帶正負號金額、交易後餘額與摘要雜湊並加同期間內的序號；交易日期存為 `authorizedAt`（只有日期），帳務日期為 `postedDate`，備註中的帳號遮罩為末四碼。信用卡交易為 `feib:card:tx:v1:<帳單期別>:<卡號末四碼或 account>:<消費日>:<帶正負號金額>:<序號>`，含帳單期別以區分各期分期；序號只在同一期帳單內累計。
- **金額方向**：銀行臺幣金額正數為消費（存為負數），負數為繳款、退款或回饋（存為正數）。目前只有帳單明細（`posted`），未出帳消費尚未接入，因此不使用共用授權配對。
- **繳款狀態**：與額度頁結帳日相同的帳單依「本期累積已繳金額」判定；較早期別以下一期的「上期應繳總額」（須等於該期應繳總額）與「已繳款/退款金額」推得，對不上時為未知。已設定自動轉帳且未過截止日為 `autopay_pending`；過截止日仍未繳清為 `overdue`。
- **自動扣繳帳戶**：最新一期帳單的「指定之自動轉帳帳號」，以存款帳戶相同算法（`feibDepositSourceId`）轉成 sourceId 並取末四碼，不保存完整帳號；他行帳號對不到任何帳戶，需手動指定。空白或沒有數字為 `null`；本期帳單未取得、欄位缺少或數字不足 6 碼時為 `undefined`。
- **負債**：快照採額度頁「已使用額度」的相反號，帳單保留原應繳總額。已使用額度是否含分期未到期金額尚未確認。
- **部分失敗**：與台北富邦相同，登入、工作階段結束與瀏覽器斷線使整次同步失敗；登入後單一頁面、期間或帳單失敗只略過該項，連續三項失敗即停止，結束時記錄 `feib_sync_summary` 與 `feib_sync_result`。Log 不記帳密、帳號、姓名、餘額或頁面文字。

外幣活存交易、定存、貸款與未出帳消費尚未接入。無卡文案與有期別的空帳單頁只以合成 fixture 驗證。

### 彰化銀行

目前只同步台幣與外幣活存，信用卡（帳單 `CA01002`、未出帳明細）尚未接入。Fixture 與測試資料皆為合成值。

#### 登入

- 開啟 `https://www.chb.com.tw/chbnib`，先關閉「銀行公告」彈窗（Magnific Popup：優先點 `.mfp-close`，再呼叫 `$.magnificPopup.close()`，仍殘留才按 Escape；關不掉不中止）。以鍵盤事件填入 `input[name=uid_show]`（身分證字號，轉大寫）、`input[name=uuid]`、`input[name=pwd]`、`input[name=captcha]`，再對 `#pb-login` 做 DOM click。密碼由頁面自己加密，連接器不組裝登入請求。
- 驗證碼讀 `img.cimg` 的 `data:image/png;base64` 來源（元素截圖會被公告彈窗蓋住），6 位數字，使用共用 Workers AI 辨識；結果不是 6 位數字時以 `a.btn-refresh` 換圖，不送出帳密。
- 登入 POST `/chbnib/faces/login/CHBiBDispatcher`（302），轉到 `/chbnib/faces/common/CHBiBMain` 即成功。失敗時依原生對話框與頁面文字在記憶體內分類，只有明確的驗證碼錯誤會換圖重試（自動辨識最多三輪）；帳密錯誤、鎖定、重複登入與結果不明一律停止並標記 `needs_user_action`。自動辨識耗盡時回 `MANUAL_CAPTCHA_REQUIRED`，可經 `/api/connectors/chb/captcha` 改用人工輸入。
- 不復用網銀 session：每次同步重新登入，結束時只要曾送出登入就導覽 `/chbnib/faces/common/Logout`。主頁的 `beforeunload` 提示要確認（取消會擋下登出）；`alert` 確認，`confirm`、`prompt` 一律取消。

#### 查詢

- 登入後所有資料都經 `POST /chbnib/rest`，body 為 `JSON.stringify({ url, method, taskID, data })`，在已登入的頁面內以 XMLHttpRequest 送出，讓頁面的反爬蟲腳本照常附加參數；一次一個、不可並行，因為伺服器會在回應時更新 session。不從 Worker 直接發 HTTP。
- `DataCheckSum` 標頭為 `crc32(base64(utf8(body)))` 的十進位字串，由 Worker 計算（`protocol.ts` 的 `chbDataCheckSum`），使用標準 CRC-32（IEEE 802.3）與標準 Base64。
- 回應為 `{ isSuccess, data, returnCode, returnMessage }`，只有 `S001` 視為成功；其餘以 `chb_api_error` 記錄，不記回覆內文。HTTP 401、403，或回覆代碼含 session、timeout、login、expire 時視為工作階段結束。
- 每個功能先呼叫 View（`GET`）再呼叫 Action（`POST`）：

| 用途     | View／Action                        | taskID    | 備註                                                                                                                 |
| -------- | ----------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| 台幣餘額 | `TW01001/tw01001_1_View`／`_Action` | `tw01001` | Action 帶 View `accountItems` 的「全部帳號」value 與 `mgFlag: false`；`surplus` 為帳面餘額、`autoBalance` 為可用餘額 |
| 台幣明細 | `TW01002/tw01002_1_View`／`_Action` | `tw01002` | View 帶 `accountData: "none"`（空物件會回 `E000`）；每個帳號各查一次；`inqType: "2"`、`range: "0"`（指定區間）       |
| 外幣餘額 | `FC01001/fc01001_1_View`／`_Action` | `fc01001` | 有「全部」選項時一次查，否則逐項查詢並合併（log `chb_fc_balance_mode`）                                              |
| 外幣明細 | `FC01002/fc01002_1_View`／`_Action` | `fc01002` | 每個帳號與幣別各查一次；選單 value 為 `<帳號>$$$<幣別>`                                                              |

- **日期**：Action 的起迄日格式照 View 回應的迄日（台幣 `queryEndDate`、外幣 `endDate`）：3 位數年份為民國年，沿用相同分隔符；起日為迄日往前 3 個月。View 沒有可解析的迄日時該功能失敗，不猜格式。
- **金額方向**：台幣明細的支出 `expenseBetr`、存入 `depositedBetr` 分欄，須恰有一欄有非零金額；`hcode == "1"` 為更正交易（保留於 `raw.adjustment`），方向與所在欄位相反。外幣明細的 `expense == 1` 為支出，其餘為存入。同步結束的 `chb_sync_result` 記錄「上一筆餘額＋本筆金額＝本筆餘額」不一致的筆數（`twBalanceMismatch`、`fcBalanceMismatch`），用來驗證方向判斷；回應 `totalCount` 大於解析筆數時累計 `truncationSuspected`。
- **金額格式**：金額為字串，接受千分位、小數、括號負數與後置負號，空字串與 `-` 視為無值，其他一律拒絕；明細取絕對值後依欄位決定方向，餘額保留原符號。

#### 資料

- 存款帳戶為 `bank:chb:<末四碼>:<完整帳號 SHA-256 前 16 碼>`，外幣再加 `:<幣別>`；銀行代碼 `009`，已加入直接存款來源。不保存完整帳號；快照依台灣日期每天一筆。
- 交易 sourceId 為 `chb:deposit:tx:v1:<hash>:<序號>`，hash 由帳號、幣別、交易日、記帳日、交易時間、帶正負號金額（更正列取反轉前的方向，方向修正不改 sourceId）、交易後餘額與摘要組成。交易時間可解析時以 `+08:00` 保存為 `authorizedAt`，記帳日為 `postedDate`。
- **部分失敗**：與台北富邦、遠東商銀相同，登入後單一查詢失敗只略過該項，連續三項失敗即停止，結束時記錄 `chb_sync_summary` 與 `chb_sync_result`。明細只寫入餘額回應中已出現的帳戶。

登入失敗訊息的分類與工作階段失效的回覆代碼尚未確認，程式中以 `TODO(chb-live)` 標示。

### 將來銀行

使用網銀帳密直接呼叫網銀內部 Web API 登入與查詢；圖形驗證碼支援 AI 自動辨識或人工輸入。自動辨識依共用重試政策，只有 `CAPTCHA_ERROR`、`CAPTCHA_EXPIRED` 會換新驗證碼重試，每個驗證碼只送出一次。單次登入、查詢後登出，不接管其他工作階段。主帳戶查詢最近三個月，活存口袋讀取所有分頁後依日期篩選；定存口袋同步餘額，基金與美股未接入。設定 CAS 與原子寫入 guard 防止查詢期間變更帳密後仍寫入舊結果。

交易識別不使用銀行的 `tradeID`，因為同一個月有新交易後，銀行會替較早的交易重新編號。`sourceId` 為帳號、台灣日期、金額與「當日同額的第幾筆」的雜湊，依時間由早到晚編號，時間相同時由回應尾端起算；摘要與註解修改、入帳後只剩日期都不改變識別。同一天同金額的多筆交易只能靠順序區分，彼此的分類或備註可能對調，金額與筆數不受影響。同一次查詢的回應內，日期、`tradeID` 與金額都相同的列視為同一筆，採用已入帳版本並保留較精確的時間。

寫入前由 `nextbank/transactions.ts` 比對已保存的交易：本次完整回應中出現的「帳戶、日期、金額」組合以回應為準，回應不再對應的舊列依建立時間逐一併入回傳列，沿用 `mergeLegacyTransactionStatements` 搬移分類、計算偏好、備註與發票連結後刪除；兩端設定衝突時保留不合併。每次同步每筆回傳列最多併入五筆舊列，其餘留待下次。回應未涵蓋的日期不處理；已入帳交易只剩日期時，保留先前已知的交易時間。

### 聯邦 New New Bank

使用聯邦數位銀行行動 App API（`https://newnewbank.ubot.com.tw/NNBank/svc/<API_NAME>`，`connectionMode: "api_credentials"`）直接登入與查詢，不需要 Browser Rendering 或圖形驗證碼。

- **登入與加密**：先以 `NNBCM000007` 取得 RSA-2048 公鑰把密碼加密為 `miMa`，再以 `NNBCM000011` 取得 `k1`（RSA-1024 公鑰）與 `k2`（AES-128 金鑰）。登入 payload（`sid` 為大寫身分證字號尾端補 `"A"`、`deviceUuid` 為 64 碼小寫 hex、`deviceModel: "google-husky"`、`deviceOSVer: "Android15"`）以 `AES-128-OFB` 加密為 `p1`，隨機 16 碼數字 `iv` 以 RSA 加密為 `p2`，送交 `NNBI010101`。
- **不干擾手機的裝置綁定**：未綁定此虛擬裝置時，`NNBI010101` 回 `NS161`（或 `0000`、`NS164`），並在 response header 核發有效的 `ssid`，帶入後續 `Authorization` 即可完成唯讀查詢。連接器絕不呼叫 `NNBS000004`、`NNBI020101`、`NNBI020102` 等綁定端點，避免覆蓋使用者手機的快速登入。帳密錯誤（`NS169`）、鎖定（`NS168`）、欄位檢核失敗（`NM92`）、登入遭 HTTP 4xx 拒絕（帳密有誤時可能回 `NM85`「系統忙碌中」），或需要在官方 App 更新基本資料、KYC（`NS090`、`MissingUserFlag === "2"`、`KycFlag === "Y"`）時，立即停止並轉為 `NeedsUserActionError`。同步結束時在 `finally` 呼叫 `NNBI010103` 登出。
- **存款與定存**：`NNBN020101` 取得臺幣餘額與可用餘額，`NNBN010201` 查詢近三個月臺幣明細（`WarnCode === "MFOB"` 表示超過單次筆數上限，自動二分日期區間重查），`NNBN030101` 取得臺幣定存；`NNBF010201`、`NNBF050201`、`NNBF020301` 取得外幣活存、明細與定存（`NS102` 表示未開立外幣帳戶，略過）。存款帳戶為 `bank:ubot:<末四碼>:<完整帳號雜湊>:<幣別>`，銀行代碼 `803`，已加入直接存款來源。
- **信用卡與個人貸款**：先以 `NNBC010105` 查詢信用卡清單（`ErCode_1: "NSCRD"` 且 `ErCode_2` 為 `0021`、`0023`、`F101`、`F102`、`F103` 時視為無正卡）。持卡時查詢 `NNBC010101`（額度、本期應繳、已繳與未出帳總額 `UnsettleAmt`）、`NNBC010102`（未出帳明細，略過 `TxCode` 為 `05`、`07` 的查證中小計列）、`NNBC080201` 與 `NNBC010104`（近三期帳單與已出帳明細）、`NNBC080101`（即時授權，以 `pending` 寫入並透過共用配對連結）及 `NNBC030101`（自動扣繳狀態）。個人貸款以 `NNBL010401` 同步現欠本金、利率、繳款日與扣款帳號（`NSLOND` 表示沒有貸款）。
- **信用卡完整性**：信用卡清單、未出帳明細、帳單清單與近三期帳單明細都必須查詢成功；清單欄位缺失、帳單期別格式錯誤或已列出期別回傳 `B060` 時中止整次同步，保留既有金融資料與 cursor。成功回傳的空清單可以接受，查詢失敗不當作無資料，以免共用序號重新編號後覆寫其他消費。信用卡清單外層成功但內層 `ErCode_1` 為未知錯誤（含 `NSCRD` 搭配非允許的 `ErCode_2`）也中止，不得視為無卡。
- **帳單金額**：優先取 `NNBC010104` 的 `HeaderInfo`（`CurrBal`、`DueAmt`、`CTDPayAmt`、`DueDate`、`StmtDate`）。明細未附表頭金額時，若 `NNBC010101` 的 `HasBill` 為 `Y` 且有 `CurrBal`，以帳務總覽建立最新一期的帳單；較舊期別缺表頭時不建立帳單。

### 加密貨幣交易所（Binance、MAX）

兩者都是 `api_credentials`、純 HTTP 的單次同步，沒有 `connector.ts`。使用者只需填唯讀 API Key 與 Secret Key，不保存 session、cursor 或衍生 secret state（`noSession`）。共用的持倉正規化與 HMAC 簽章在 `sources/crypto-holdings.ts`，MAX 公開報價在 `sources/crypto-prices.ts`，寫入在 `features/sync/crypto-holdings-write.ts`。

- **資料模型**：寫入 `investment_positions`（`asset_type = 'crypto'`）與 `net_worth_history`（`source` 為 connector ID）。每個幣種一筆，跨錢包合併；`sourceId`、`symbol` 為大寫幣種代碼，`name` 為交易所名稱；`raw` 只保存各錢包的數量拆分與使用的台幣價格。
- **估值**：`currency` 固定為 `TWD`，`market_value` 為同步當下換算的台幣整數，`quantity` 為幣的數量。USDT 換台幣一律使用 MAX 公開 `usdttwd` 最新成交價，不寫入 `exchange_rates`；取不到或報價無效時整次失敗並保留前一次快照。個別幣種沒有報價路徑時保留數量、`market_value` 為 NULL，不當成 0；當天淨資產歷史只加總已估值的列。
- **灰塵門檻**：台幣估值絕對值低於 `INVESTMENT_DUST_THRESHOLD_TWD`（NT$10，`shared/investments.ts`，前端也用同一個門檻）的列不輸出。這是固定 policy，不是公開偏好。
- **同日快照**：唯一鍵含 `as_of_date`（台灣時區），因此每次同步在同一個 D1 batch 依序執行設定版本 guard、刪除本 connector 當天的持倉、寫入新列，當天賣出的幣種會消失；前一天以前的快照不動。設定在同步期間變更時整批回滾。
- **全部清空**：沒有任何列可輸出時寫一筆 `sourceId = 'empty'`（`EMPTY_INVESTMENT_SOURCE_ID`）、數量與市值為 0 的列，讓「最新持倉」停在今天而不是退回前一天的幣種；前端不列出這一列，該機構顯示「目前沒有持倉」。
- **Browser Run 代發（CryptoBrowserEgress）**：Binance 與 MAX 都拒絕 Workers 的對外連線（Binance 回 451 或 CloudFront 403，MAX 回 403），Browser Run 則可通過；瀏覽器的位置跟著開啟它的呼叫端，Worker 落在美國時 Binance 仍回 451。因此兩家的所有請求（含 MAX 公開報價）都交由 SQLite Durable Object `CryptoBrowserEgress` 代發。
  - 物件名稱為 `crypto-<connectorId>-<區域>`，先用 `apac`；Binance 地區封鎖、MAX 沒有錯誤碼的 403 或 MAX 公開報價 403／451 時，等待 21 秒（免費方案每 20 秒才能開一個新瀏覽器）後改用 `weur` 再試一次，其他錯誤不換區域。
  - 每個 origin 建立一個同源頁面，請求在頁面內以 `fetch` 執行（`redirect: "error"`，避免簽章請求被轉到允許清單外的主機）。取得瀏覽器以 15 秒為上限，單次請求逾時 45 秒；同步結束後關閉，閒置 90 秒也會由 alarm 關閉。
  - 只允許 `api.binance.com`、`fapi.binance.com`、`dapi.binance.com`、`max-api.maicoin.com` 的 HTTPS GET 與 POST。簽章在 Worker 完成，物件與瀏覽器只收到已簽章的請求與 API Key 標頭，不接觸 secret。Browser Run 額度不足時拋出共用的 `BrowserRunCapacityError`（`429 BROWSER_BUSY`）。
- **封鎖診斷**：Binance 回 451 或沒有錯誤碼的 403 時拋出地區封鎖錯誤；MAX 回沒有錯誤碼的 403／451 時拋出 `MaxAccessBlockedError`，與金鑰錯誤分開。訊息附上對方回應的邊緣節點機場代碼（Binance 取 `x-amz-cf-pop`，MAX 取 `cf-ray`），只供參考，不等於實際出口位置。錯誤訊息中的端點只保留最後兩段路徑，避免被 token 脫敏規則整段遮蔽。
- **錯誤分類**：必要的現貨帳戶端點回報金鑰錯誤時標記 `needs_user_action`。選用錢包（Binance Funding、Earn、合約、`wallet/balance`；MAX M 錢包）只有明確的未開通或權限不足才視為沒有該錢包：Binance 為金鑰或權限錯誤，或 400、401、403、404 帶非暫時性錯誤碼；MAX 為 400、401、403、404。429 限流、418 IP 封鎖、暫時性錯誤碼（如 `-1003`、`-1021`）、網路錯誤、逾時與 5xx 都使整次同步失敗，避免少算資產或漏扣借款。理財分頁超過上限仍未取完時同樣失敗。

#### Binance

- **簽章**：`HMAC-SHA256(secret, 參數字串)` 的 hex 放在 `signature`，header `X-MBX-APIKEY`，參數含毫秒 `timestamp` 與 `recvWindow=10000`。
- **錢包**：Spot `GET /api/v3/account?omitZeroBalances=true`（`free + locked`）、Funding `POST /sapi/v1/asset/get-funding-asset`（`free + locked + freeze + withdrawing`）、Simple Earn 活期 `/sapi/v1/simple-earn/flexible/position`（`totalAmount`）與定期 `/sapi/v1/simple-earn/locked/position`（`amount`），理財分頁每頁 100 筆、取完 `total` 為止。
- **活期理財憑證**：現貨餘額中 `LD` 加幣種代碼的資產，在該幣種已出現在活期理財，或改用 Earn 總值且憑證本身沒有報價、去掉 `LD` 後的幣種有報價時略過；`LDO` 等有自己報價的真實幣種照常計入。兩者都沒有計入時保留憑證（無法估值）。活期與定期都取得時採用逐幣明細；只取得其中一個時改用 `wallet/balance` 的 Earn 總值，避免少算或重複計入；連 Earn 總值都取不到時才保留取得的那一半。
- **合約**：只取帳戶權益，不拆個別部位。U 本位 `GET fapi /fapi/v2/account`、幣本位 `GET dapi /dapi/v1/account` 各一筆（`futures-usdm`、`futures-coinm`），逐一以 `assets[].marginBalance` 換算台幣後合計。不使用 `totalMarginBalance`，因為它在單資產模式只計 USDT；`marginBalance` 已含未實現損益，不可再加 `unrealizedProfit`。任一保證金資產沒有報價時，該筆權益不估值。
- **其他錢包**：`GET /sapi/v1/asset/wallet/balance?quoteAsset=USDT` 取得每個錢包的 USDT 總值。已逐一取得的錢包（`spot`、`funding`、`earn`、`usdmfutures`、`coinmfutures`）略過；逐一端點未開通或無權限時改以總值補上。其他餘額不為 0 的錢包（例如期權、交易機器人、跟單、槓桿）各列一筆 `wallet-<名稱>`，以 `usdttwd` 換算，已知名稱顯示中文，未知名稱沿用原文。這些錢包與槓桿帳戶的總值是否已扣除借款尚未確認。
- **報價**：`GET /api/v3/ticker/price`，依序使用 `XUSDT`、反向 `USDTX`、`XBTC × BTCUSDT`。
- **錯誤**：`-2014`、`-2015`、`-1022` 為金鑰錯誤。成功狀態但回應不是 JSON，或格式不符（現貨 `balances`、理財 `rows`、資金、`wallet/balance` 不是陣列，合約缺少 `assets`）時失敗並保留前一次快照；空帳戶省略 `rows` 且 `total` 為 0 時視為沒有部位。

#### MAX

- **簽章（v3）**：`payload = base64(JSON.stringify({ nonce, ...params, path }))`，headers 為 `X-MAX-ACCESSKEY`、`X-MAX-PAYLOAD`、`X-MAX-SIGNATURE = hex(HMAC-SHA256(secret, payload))`；GET 參數同時附在網址。nonce 為毫秒且不可重複，平行請求會遞增。
- **錢包**：`GET /api/v3/wallet/spot/accounts` 取 `balance + locked + staked`；`GET /api/v3/wallet/m/accounts` 取 `balance + locked + staked − principal − interest`，與現貨合併。任一錢包回應不是 JSON 陣列時失敗，不當成沒有持倉。借款大於持有的幣種輸出負數量、負市值的一筆，`name` 為「MAX（借款）」，讓淨資產正確扣除。HTTP 401 為金鑰錯誤。
- **報價**：先查 `GET /api/v3/markets`，只對存在的 `xxxtwd`、`xxxusdt` 與 `usdttwd` 呼叫 `GET /api/v3/tickers`（任一 market 無效會整批 400）。有台幣市場直接換算，否則以 `xxxusdt × usdttwd` 換算；台幣餘額的市值等於餘額。

### 永豐金證券（sinotrade）

使用官方新理財網與豐存股網頁，不申請券商 API。`session-protocol.ts` 管理設定、帳戶與認證白名單，`protocol.ts` 解析外部資料，`login-form.ts` 把官方登入與憑證頁的欄位對應到本站的分步驗證，`connector.ts` 負責 Browser Run 與唯讀查詢，`sync.ts` 管理互動登入、加密狀態與快照寫入。

#### 瀏覽器設定

- 官方 `service.sinotrade.com.tw` 的 API 防火牆會拒絕 Browser Run 預設的 `HeadlessChrome` User-Agent，因此改用同版本的一般 Chrome UA（只把 `HeadlessChrome/` 換成 `Chrome/`，並與 `sec-ch-ua` 一致）。UA 覆寫只對設定它的 CDP 連線有效，官方另開的憑證視窗也不會繼承，所以每次連上 Browser 都對現有頁面重新套用，並監聽之後開啟的頁面。
- 未回覆的 JavaScript 對話框會凍結頁面，所以每次連上 Browser 都會回覆官方對話框：`alert`、`beforeunload` 按確定，`confirm`、`prompt` 一律取消。
- 頁面導覽與等待官方回應各最多 30 秒，頁面內的 API 請求各最多 20 秒。同步取得 Browser 後整段最多 120 秒，逾時立即關閉 Browser 再回報失敗。

#### 首次連線

- `POST /connectors/sinotrade/connect` 預設從新理財網開始，建立五分鐘的工作階段（`keep_alive` 同為 5 分鐘，因為 Browser Run 依工作階段開著的時間計費），在背景操作官方登入表單。前端以本站原生欄位呈現 `challenge`，不使用 Live View、iframe 或遠端鍵鼠控制。
- `connect/status` 只讀取目前步驟，供重新整理後恢復。`connect/verify` 以 Zod 限定動作（`confirm_certificate`、`submit_birthday`、`request_otp`、`verify_otp`、`accept_terms`）與欄位。`challenge.fields` 標明每個欄位由哪個動作送出；選項以官方選項的位置提交，勾選只在使用者勾選時送出 `true`。`challenge.document` 目前只有憑證作業條款，只取文字並限制長度，找不到時不附。
- **欄位辨識**：登入頁只限定單一可見的驗證表單或憑證對話框；憑證 origin（`ca.sinotrade.com.tw`）的整頁屬於同一流程，但仍逐項以已知語意對應（生日、OTP 收取方式與地址、驗證碼、同意條款）。無法辨識的欄位、互動式 reCAPTCHA 或兩個相同用途的按鈕都不提交；送出前核對按鈕的文字、可見性與可用狀態。官方「取得驗證碼」按鈕要選好收取方式才出現，若隨後出現需要決定的欄位（例如多個收取地址），先回傳新欄位而不寄送。
- **使用者操作**：寄送 OTP 與同意條款都必須由使用者明確操作，不在狀態恢復、錯誤重試或排程中執行。載入電子憑證與平台完成不涉及使用者決定，前端可在使用者上一個操作之後接續，狀態恢復時不接續。
- **同意條款後**：官方會簽發並佈署憑證，再回到登入頁，不會自動繼續登入。該次請求最長連線 60 秒，等憑證視窗關閉且登入頁已保存 `TWCACertIdxRef` 後，以已儲存帳密重新登入一次。簽發後官方可能短暫查不到新憑證（`rcode=8040`），只有這個回應會依序等待 4、8、12、16、20 秒後重試，整段最多 85 秒；其他被拒絕的登入不重試。
- **官方錯誤對話框**：官方以 `.ant-modal-confirm-error`（例如暫停服務）回應時不會再出現任何步驟，因此停止輪詢並回報 `blocked`，附上遮蔽身分證格式字串並限制長度的訊息；`connect` 開始時遇到則直接關閉 Browser。
- **兩個平台**：`connect/complete` 驗證目前平台後，在同一個 Browser 還原另一平台並檢查登入。官方把同一張憑證佈署到兩個平台，沒有自己憑證的平台改用另一平台的憑證還原，不另外簽發。兩邊都可查詢才回傳 `connected`；仍需登入時以已儲存帳密嘗試一次並回傳 `verification_required`。只有明確未登入時才重新提交帳密。
- **中斷與取消**：同意條款後就把已簽發的憑證存成未驗證的平台狀態（`authenticated: false`），之後失敗、逾時或取消都不必再收一次 OTP；只有 `connect/complete` 成功才標記為已連線。`connect/cancel` 關閉並清除 pending reference，保留帳密與已完成的認證。開始、驗證、完成、取消與同步共用連線鎖；發現工作階段逾時時立即關閉 Browser。設定寫入使用 CAS，回應帶 `Cache-Control: no-store` 與 `Referrer-Policy: no-referrer`。
- 生日與 OTP 只存在當次請求與官方頁面，不寫入設定、公開狀態、cursor、log 或 raw。

#### 保存的狀態

帳密、`webState` 與短效 Browser reference 位於 `encrypted_config`；帳密變更時清除 `webState` 與 pending reference。Cookie 只保存官方 origin 與父網域下已確認的應用 cookie；storage 只保存新理財網的 token、帳戶、身分欄位，以及 `TWCACertIdxRef` 引用的 TWCA 憑證項目，各 origin 分開保存，不複製整份 profile。公開設定只回傳各平台是否完成與等待期限。

#### 同步時自動重新登入

- 官方登入約 24 小時失效。同步先在查詢前確認兩個平台（新理財網查第一個帳戶的庫存，豐存股開總覽）。只有官方明確回應未登入（401、豐存股導回登入頁、新理財網沒有 token）時，才在同一個 Browser 重新登入：移除過期 token、送出已儲存帳密一次、載入已儲存的憑證，再確認一次。
- 確認通過後的查詢若回應未登入（登入恰好在確認後失效），同樣重新登入、再確認，然後重試該查詢。
- 每次同步每個平台最多自動登入一次，已重新登入過仍回應未登入時照原錯誤停止，不送第二次帳密。403、5xx 與格式錯誤不重送帳密。
- 新理財網 API 回應官方暫停服務（HTTP 405、`errorType: "AccessError"`、訊息含「暫停服務」）時，以固定訊息回報並停止，不重新登入、不更新持倉，也不改變已保存的登入狀態。
- 官方要求生日、OTP 或條款、拒絕登入、登入頁顯示暫停服務等錯誤，或重新登入後仍未登入時，回報 `SINOTRADE_CONNECTION_REQUIRED`，並把該平台存成 `authenticated: false`（保留帳密與憑證）。之後的同步在送出帳密前就停止，直到使用者重新連線，避免每天重送被拒絕的密碼而鎖住帳戶。
- 每次自動登入記錄 `sinotrade_session_relogin`（平台、時機、停下的步驟與耗時），不記帳號、頁面文字或官方訊息。

#### 持倉

- **新理財網**：一般台股以 `Equity/UnRealPrtlos` 取得成本與來源未實現損益（`ttype` 必須是 `A`，空字串會被官方拒絕），驗證 `success = True` 並排除合計列；一般美股檢查 Divo 外層與來源成功旗標。
- **豐存股**：以登出連結 `/Login/Logout` 判斷已登入。監聽總覽頁自己發出的 `GetOverviewData`（讀不到內容的回應略過），以 `ActsData` 的 `AccType`（`S` 台股、`H` 美股）、`Broker` 與 `Act` 對應新理財網帳戶，再以總覽頁 `#form1` 的 CSRF token POST `/Account/Asset`，解析內嵌的 `assetDatas` JSON。台股只接受現股（`AssetType` 為 `0`）。庫存 POST 使用固定網址並拒絕轉址，依官方帳戶類別選市場，不依代號猜測。
- **兩平台核對**：豐存台股與一般台股是同帳戶的兩個觀測來源，不相加。同代號且數量相同時採用一般庫存的成本與損益；數量、市場、幣別或美股成本不一致時整次失敗並保留上次快照。只處理現股，融資、融券、未知分類或 `NeedReCalculate` 為 true 時失敗。
- **快照**：每次成功同步原子替換本來源當天的快照，並為每個帳戶與市場的 stock、etf 建立 `empty:*` 零值 marker，避免全部賣出後退回舊庫存。所有查詢、解析與核對都成功後才 promotion，設定版本 guard 與刪除、寫入在同一個 D1 batch。原幣金額與碎股保留小數，`raw` 不存完整帳號或原始回應。
- **股票走勢**：同一次 promotion 寫入 `net_worth_history`（`source = sinotrade`，四捨五入到元）：台股帳戶市值為 `tw_stock`，海外帳戶市值以當下匯率換算為 `stock`。沒有該市場帳戶時不寫，全數賣出時寫 0，非零外幣缺少匯率時不寫該日美股；歷史從開始寫入那天累積，不回補。跨來源的最新持倉選擇與台股走勢合併見[後端架構](002-backend-architecture.md#投資持倉與淨值走勢)。

#### 交易紀錄

- **台股**：寫入 `investment_transactions`，取自新理財網 `Equity/ReconciliationStatement`（與官方對帳單一致，近五年、`ttype` 為 `1` 的現股）。官方三個總計須等於逐筆加總，其他交易別、買賣欄位矛盾或日期不合法都停止同步。買進的 `amount` 為負的應付、賣出為正的應收（含手續費與交易稅），費稅與委託單號放在 `raw_payload`。台股只取新理財網，避免與豐存股重複；五年以前的成交不會匯入。
- **美股**：新理財網的海外對帳單沒有豐存美股的買進，改取豐存股 `/Account/Transaction`（日期從 2000 年起），依表格標題對應欄位，代碼、數量、均價、手續費與投入成本須互相吻合。頁面沒有表格視為沒有成交；非正的數量或金額（可能是尚未確認格式的賣出）停止同步。
- **已實現損益**：取自新理財網 `Equity/RealPrtlosSum`（`ttype` 為 `0`；官方單次區間上限 12 個月，依賣出日期切成 350 天內的區間，沒有賣出時不查）。每列須滿足 `profit = scost - bcost`，合計須等於逐列加總；以日期、委託單號（`dseq`）、標的與成交價對到對帳單的賣出，數量與淨收入須一致，否則停止同步；同一委託單同價多筆賣出時不寫損益。`bcost` 為 0 或負（例如 ETF 募集取得、股利沖減）時 `profit` 不是真正損益，`realized_pnl` 留空並把官方成本放在 `raw_payload.realizedCost`；尚未日結的賣出同樣留空。
- 完全相同的成交列依出現順序補序號，重複同步不會重複寫入。
- **與集保去重**：兩個來源都啟用時，讀取時由 `isNotSupersededInvestmentTransaction` 隱藏集保那筆，不刪資料：集保買進（`113`）或賣出（`123`）與永豐成交的券商帳戶、標的、幣別、股數、方向與成交日都相同時，只列永豐。資訊不完整、其他集保代碼與永豐沒有的區間照常顯示；同日同股數的多筆一律隱藏。
- **同步報告**：永豐那筆已列入報告時，集保那筆不計入新增，也不列入活動明細；永豐以不列入報告的方式匯入時，集保那筆照常保留。集保先同步到的成交，之後由 `removeDuplicateTdccReportActivity` 在同一個 D1 batch 扣回報告的新增筆數並刪除對應的明細。

查詢途中的自動重新登入尚未完整驗證，其他分支以合成回應測試。
