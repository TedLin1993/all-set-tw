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

| Mode                      | 適用情境                                                 | 現有範例    |
| ------------------------- | -------------------------------------------------------- | ----------- |
| `api_credentials`         | 帳密登入外部 API，可自行更新 token                       | 電子發票    |
| `api_device_otp`          | API 登入，首次裝置需要 OTP                               | 集保 e 存摺 |
| `browser_per_sync`        | 每次同步都必須以 Browser 登入與擷取                      | 國泰世華    |
| `browser_session`         | Browser 只負責登入，後續使用可復用的 HTTP session        | 玉山        |
| `browser_captcha_session` | Browser 登入含 CAPTCHA，可由 AI 或人工完成並復用 session | 永豐、台新  |

不要為單一銀行建立新的通用框架。只有登入生命週期真的不同時才新增 mode，並同時補上 catalog 說明及共同測試。

## 設定與狀態分級

每個欄位只能有一個權威儲存位置：

| 狀態           | 儲存位置                         | 允許內容                                                     |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| 公開偏好       | `public_config`                  | 是否抓電子發票品項明細等非敏感選項                           |
| 機密設定       | `encrypted_config`               | 帳密、cookie、access token、device token、Browser session ID |
| 同步 cursor    | `sync_cursor`                    | 日期、頁碼、watermark、已完成區間等非敏感增量位置            |
| 暫時 challenge | `encrypted_config`，且必須有 TTL | CAPTCHA、OTP、待提交的 Browser session                       |

強制規則：

- `sync_cursor` 不得包含 cookie、token、OTP 或任何可恢復登入狀態的資料。
- Connector 可在內部 cursor 回傳 session，但 sync service 必須透過 `splitConnectorCursorState` 將 secret state 移入加密設定後才持久化。
- 舊版已存在於 cursor 的 session 不得直接由 D1 migration 刪除；應讓新版 connector 相容讀取一次，並在首次成功同步時搬入 `encrypted_config`，避免強迫使用者重新驗證。
- 公開設定透過 `parsePublicConnectorConfig` 合併後再交給 config schema；不得把相同欄位複製到 encrypted config。
- 同步回溯範圍是 connector 的 runtime policy，不得做成公開偏好：電子發票固定同步最近 2 期；銀行 connector 固定同步最近 3 個月或 3 期帳單。舊版 `periodsBack` 與 `lookbackMonths` 必須忽略並在後續設定儲存時移除。
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

## 正規化資料契約

- Connector 回傳 `SyncResult`，資料必須符合 `@taiwan-fin-hub/core`。
- `sourceId` 必須在重複同步間穩定。一般交易不得使用本次同步時間產生 ID。
- `BankBalanceSnapshot.accountId`、`BankTransaction.accountId` 與 `CreditCardBill.accountId` 必須等於對應 `BankAccount.sourceId`。
- 日期使用 ISO 8601；帳單期間使用 `YYYY-MM`；幣別使用大寫代碼。
- 支出與負債為負，退款與入帳為正。
- `raw` 只能保留遮罩或白名單資料，主要功能不得依賴 raw shape。
- 所有資料必須經 `record-mapper.ts` 與 staged persistence。資料 promotion、cursor 與 secret state 更新必須放在同一 finalize batch。

## 路由、排程與 challenge

- 一般同步使用 `runConnectorSync`，不要在 route 或 scheduler 新增 connector switch。
- 所有 scope 必須先宣告在 `connectorCatalog`；排程工作目前固定使用 `all`。
- 同一 connector 的所有 scope 共用 canonical lock。
- 需要 CAPTCHA／OTP 時，runtime registry 提供 `prepareChallenge`，route 只處理輸入驗證與 HTTP error mapping。
- 排程不得主動寄送 OTP；需要互動時標記 `needs_user_action`。
- 新 connector 必須透過 D1 migration 建立 `<connectorId>:all` sync job，預設停用。

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
