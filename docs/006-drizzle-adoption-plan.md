# Drizzle 導入實作計畫

日期：2026-09-13。狀態：階段 1–4 已落地（schema／client、exchange-rates、manual-assets、notifications、classification、connector settings、invoices／investments／bank 一般列表／明細，以及 dashboard／net-worth／activity／bank calculation／search 聚合）；階段 5 待實作。SQL migrations 仍是 schema 權威，正式環境不使用 `drizzle-kit push`。

## 目標與建議方案

將 Drizzle ORM 導入現有 D1 repository，取得 schema 型別推導、型別安全的 CRUD 與查詢組合能力。沿用 feature-oriented Vertical Slice Architecture，分階段轉換一般資料存取，再評估同步與複雜查詢。

建議先完成階段 1–4，讓 Drizzle 成為一般 repository 的預設寫法。階段 5 再接入 Drizzle Kit 產生未來的 schema migrations；全程由 Wrangler 負責實際套用與 migration ledger，保留既有資料修復 SQL。

本次導入不改金融計算、資料識別、日期語意、API response 或前端資料契約。效益以型別安全與維護成本為主，不預設 ORM 會加速查詢。

## 已確認的專案現況

| 項目           | 現況與影響                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema         | 41 份 SQL migrations，最後一份為 `0043_merge_legacy_invoice_duplicates.sql`；編號有缺號，不代表遺漏檔案。                                       |
| 資料庫物件     | 將全部 migrations 重播於記憶體 SQLite 後，有 28 張表、41 個明確索引，`foreign_key_check` 無違規。這不是線上 D1 驗證。                           |
| 特殊 schema    | 現行重播結果沒有 generated column；有日期 expression index、partial unique index、CHECK 與外鍵，不能只照最初的建表 migration 翻寫。             |
| 存取範圍       | `apps/worker/src` 與 `packages/db/src` 共 26 個檔案命中原生 D1 prepare／batch 等存取模式。                                                      |
| 共用能力       | `packages/db/src/index.ts` 管理 connector settings／cursor；`sync-jobs.ts` 管理同步工作與 lease。                                               |
| Feature SQL    | 位於各 feature repository，另有 `sync/persistence.ts` 等寫入流程。                                                                              |
| 原子寫入       | `promoteStagedSyncWrite()` 將計數、promotion、finalize 與 staging 清理組成同一個 D1 batch；結果也依 statement 順序讀取。                        |
| Migration 部署 | Root `npm run deploy` 先執行 `db:migrate:remote`；local dev 也先執行 local migrations。                                                         |
| Schema 文件    | `scripts/generate-database-schema.mjs` 在隔離 local D1 套用 migrations，搭配 `schema-metadata.json` 產生文件；目前只列舉頂層 SQL。              |
| 測試           | Vitest 混用簡單 D1 mocks 與 `node:sqlite` 的 `SqliteD1` adapter；部分 adapter 僅支援 `.all()`，不能假設直接適用 Drizzle driver。                |
| 版本           | 本日 npm registry 的 latest 為 `drizzle-orm@0.45.2`、`drizzle-kit@0.31.10`；實作開始時重新確認並鎖定相容版本，不直接跟隨官網的 `@rc` 安裝範例。 |

## 架構決策

1. 在 `packages/db/src/client.ts` 提供 `createDrizzle(binding: D1Database)`，使用 `drizzle-orm/d1`。從當次 request／Queue invocation 傳入 binding，不建立跨環境的全域 client。
2. 在 `packages/db/src/schema/` 依業務領域定義 tables，透過 `schema/index.ts` 匯出。初期完整描述現有 28 張業務表，排除 `d1_migrations` 與平台內部表。
3. Drizzle 型別留在 DB 與 Worker repository 層。`packages/core` 保持穩定商業契約；前端、`packages/connectors` 不依賴 ORM。
4. 過渡期沿用 repository／service 接受 `D1Database` 的介面，在 repository 內取得 Drizzle client，避免全面改寫 routes 或新增 DI container。
5. Schema TypeScript property 使用 camelCase，明確對應既有 snake_case SQL 名稱。既有 repository 回傳的 snake_case 或自訂別名由 selection／mapper 維持，避免一路改到 service 與 API。
6. Drizzle `$inferSelect`／`$inferInsert` 取代重複的 table row 型別；join、聚合與 API DTO 仍使用符合用途的型別。保留既有 Zod 與 JSON 解析，不將 ORM 型別當成 runtime validation。
7. 日期仍以既有 TEXT string 儲存；金額維持現有 SQLite 型別與精度語意；JSON 欄位、0／1 flag 的轉換逐欄確認，不順便改成 Date、timestamp integer 或新的金額模型。
8. 一般查詢使用 query builder；expression、CTE、條件 upsert 或複雜聚合可使用參數化 `sql`。跨檔案組成的原生 D1 batch 可以保留，並在呼叫處註明原因。
9. 不新增 BaseRepository、不包裝整套 Drizzle operators，也不為導入預先建立所有 relational query definitions。
10. 關閉 ORM query／parameter logging。導入會接觸 connector settings 等敏感欄位，須驗證 ORM 包裝後的錯誤不經既有全域 handler 印出完整參數；若會，僅針對該錯誤路徑做必要遮罩。

直接 import `drizzle-orm` 的 workspace 應自行宣告 dependency，不能依賴 npm hoisting：DB package 與使用 operators 的 Worker 都應列入；Kit 僅作開發工具。

## 分階段實作

### 階段 1：Schema、client 與 D1 相容性基礎

工作內容：

- 安裝並鎖定穩定版 Drizzle ORM；Kit 如用於本機 introspection／schema 比對，僅加入 devDependencies。
- 新增 `packages/db/src/client.ts`、`schema/*.ts` 與必要 exports，依目前 migration 重播結果建立完整 schema。
- 可從隔離 SQLite introspection 起草，再逐一比對外鍵、nullable、default、CHECK、unique、索引順序、COLLATE 與 expression／partial index；不連線正式資料庫進行 pull。
- 將 migration 重播 schema 與 Drizzle schema 建出的隔離 schema 做語意比對；使用 `sqlite_schema` 與 PRAGMA，避免只比 SQL 字串格式。此檢查應能抓出欄位、限制或索引遺漏。
- 檢查 DB／Worker 的 workers-types 實際解析版本及 TS7 相容性；只有出現型別衝突時才對齊必要相依。
- 保留既有測試框架。依鎖定 D1 driver 的實際呼叫補足需要轉換之測試 adapter，例如 `.raw()`、`.run()` metadata 與 batch rollback；不全面重寫 mocks。
- 加入小型、隔離的真實 D1 binding 整合測試，驗證 select、null、alias、insert／upsert 與 batch 失敗回滾。若現有 Vitest 無 Worker runtime，新增獨立 Miniflare 測試設定，避免更換整個 backend test runner。

驗收：完整 schema 語意比對通過；TS7 通過；Drizzle D1 client 在隔離 workerd／Miniflare runtime 可讀寫及回滾。沒有新增要套用到既有資料庫的初始化 DDL。

### 階段 2：以 exchange-rates 做第一個完整切片

修改 `apps/worker/src/features/exchange-rates/repository.ts` 與直接受影響的 tests。

- 將 `listExchangeRates()` 改成 Drizzle selection，維持 `currency`、`rateTwd`、`updatedAt` 及 USD／JPY／EUR 排序。
- 將 `replaceExchangeRates()` 的 delete＋insert 保持在單一 batch，使用鎖定版本支援的 D1 batch builder。
- 維持 rates 空陣列時的現有 repository 行為，以及上層對外部資料失敗的處理；不將取得匯率失敗改成清空資料。
- 既有 service／route response 維持一致；測試查詢結果與失敗後的資料，不固定比對 ORM 產生的整段 SQL。

驗收：既有 service／route tests 通過；補足排序、完整取代與任一 insert 失敗後舊資料仍在的 D1 整合案例。記錄查詢次數與 Worker bundle 變化，確認沒有引入額外往返或 Node-only runtime dependency。

### 階段 3：分批轉換一般 repository

依下列順序拆成可獨立審查的變更；每批完成後即可保留使用，不等待全庫轉換。

| 順序 | 範圍                                                                                  | 主要驗收                                                                           |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 3A   | `manual-assets/repository.ts`、`notifications/repository.ts`                          | 資產與歷史一起寫入／刪除的原子性、偏好預設值與空值處理。                           |
| 3B   | `classification/repository.ts`、共用 connector settings 與 `connectors/repository.ts` | 規則順序、分類唯一性、conflict target、cursor 保留及敏感參數遮罩。                 |
| 3C   | `invoices`、`investments`、`bank` 的一般列表／明細查詢                                | API shape、排序及游標分頁、LEFT JOIN null、pending／posted、使用者偏好及日期邊界。 |
| 3D   | `dashboard`、`net-worth`、`activity`、bank calculation／search 聚合                   | 計算值一致、跨來源去重一致、query plan 與查詢數不退化；必要複雜 SQL 保留。         |

3B 已完成：

- 分類 CRUD 使用 Drizzle，保留 NOCASE label 唯一性、規則 priority／updated_at／id 排序、系統規則不可修改／刪除，以及單一 batch 重排的原子性。
- Override 維持 target_type／target_id conflict target、既有 ID 與 created_at；大量交易 ID 仍使用單一 JSON 陣列搭配 json_each 查詢。
- 共用 connector settings／cursor 改用 Drizzle；connectors repository 沿用既有委派介面。設定 upsert 不覆蓋既有 ID、created_at 或 sync_cursor，public config 與 cursor 更新僅修改指定欄位。
- 設定存取邊界使用 sanitizeDatabaseError，避免 Drizzle 綁定參數流入 API log 或同步錯誤紀錄；隔離 D1 測試涵蓋上述保留語意、排序回滾及敏感參數遮罩。
- 此批未變更 schema、ID 格式、SQL migrations 或部署流程；下一批為 3C。Schema／ID 調整另行規劃 migration。

3C 已完成：

- invoices 列表／區間／明細與 line items 改用 Drizzle，保留 invoice_date／updated_at／id 游標、Taipei 日界與 json_each 批次查詢。
- investments 最新持倉與交易列表／區間改用 Drizzle，保留 per-connector＋asset_type 的最新 as_of_date、effective_date 游標與 TEXT 日期邊界。
- bank 帳戶、交易、信用卡帳單的一般列表／明細改用 Drizzle；帳戶 latest snapshot 維持 LEFT JOIN null，pending 僅在未 matching 時可見，使用者 calculation preference 可為 null。
- 銀行交易日條件維持與 `idx_bank_transactions_transaction_day` 相同的 CASE 運算式；既有 `EXPLAIN QUERY PLAN` 測試繼續驗證索引。
- dashboard／net-worth／activity 聚合、bank calculation／search 已於 3D 轉換；同步 lease／staging 仍留待階段 4。此批未變更 schema、ID 格式或 SQL migrations。

3D 已完成：

- dashboard 四個獨立聚合維持 `Promise.all`，investment 最新持倉仍依 connector＋asset_type 取 `MAX(as_of_date)`，銀行餘額只加總 canonical／active 帳戶的最新 snapshot。
- net-worth 圖表／分頁、銀行存款歷史上下界與當日市值改用 Drizzle；外幣換算、TEXT 日期游標與每 100 筆一批的 upsert 原子邊界不變。
- activity 對應偏好、發票／交易對應查詢改用 Drizzle，pending 已 matching 的交易維持不可見；全域搜尋日聚合保留 `WITH candidates` CTE、`UNION ALL`＋`DISTINCT` 跨來源去重，以及與 `idx_bank_transactions_transaction_day` 相同的 CASE。
- bank calculation preference 的存在檢查與 upsert 改用 Drizzle，保留 pending 可見性與 0／1 flag。
- 此批未變更 schema、ID 格式、SQL migrations 或部署流程；下一批為階段 4 同步 lease／staging。

保留並延伸 `bank/repository.test.ts` 既有 `EXPLAIN QUERY PLAN` 測試，尤其 `idx_bank_transactions_transaction_day`。不得把可使用 expression index 的條件改寫成無法使用索引的等價運算，或將資料全取回 JavaScript 才篩選。

驗收：已轉換 feature 的既有行為測試通過；僅刪除確實被推導型別取代的手寫 row types。未轉換 repository 可與 Drizzle 共存。

### 階段 4：審查同步與高風險寫入

範圍為 `packages/db/src/sync-jobs.ts`、sync 各 repository、`persistence.ts` 及其呼叫端。先盤點 statement composition，再決定每一組原子操作是否轉換。

- 同步 lease acquisition／renewal 保持單次條件 UPDATE 與 affected rows 判斷，不能改成先 SELECT 再 UPDATE。
- 驗證 `meta.changes`、無命中與 conflict 結果在 Drizzle 下的取得方式，保留 owner token 及 lease 條件。
- 保持 staging promotion 的 statement 順序、結果 offset、計數、finalize、cursor 與 cleanup 的現有原子邊界。
- 同一 batch 內不得混入不相容的 Drizzle query object 與 `D1PreparedStatement`，也不得以循序 `await` 或 `Promise.all` 替代原本 batch。
- Drizzle 的 transaction API 是否可用以 D1 driver 實測為準；本計畫以 D1 batch 為原子寫入機制。
- 當完整轉換一組 batch 會擴大範圍、降低可讀性或無法保留語意時，保留該組原生 SQL，並記錄理由及既有測試位置；不為清除 `.prepare()` 而重構 durable run。

驗收：現有 lock、durable run、persistence、identity migration 與 pending→posted 回歸測試通過。D1 runtime 測試涵蓋 batch 中途失敗，以及 lease 競爭只能一方取得鎖。資料 ID、歷史及 linked／separate 決策保持一致。

階段 4 已完成同步寫入審查與必要轉換：

- `sync-jobs.ts` 的 lock acquisition／renewal／release、成功／失敗狀態，以及 einvoice／TDCC 的獨立 run lease、狀態 CAS、session refresh claim 與 completion／finalize 使用 `createDrizzle`。仍以單次條件 UPDATE 的 `meta.changes === 1` 判斷成功，保留 owner、active status、嚴格 `<` 到期條件與 unfinished item guard。
- TDCC state 更新保留 undefined 不修改、明確 null 清除，以及明文 session 不落庫；transition 的 null error 仍保留原值。Drizzle 寫入錯誤沿用 `sanitizeDatabaseError`，避免綁定參數與 cause 進入同步錯誤紀錄。
- 獨立 encrypted config 更新及 staging 過期／失敗清理使用 Drizzle；promotion batch 內的 cleanup 保留原生 statement。
- 後續一般讀取亦已轉換：sync job 選取、排程設定／列表、einvoice／TDCC run 與 item 查詢（含 claim 後的獨立讀取）、通知批次與成員、最新報告與可修復來源及 baseline 存在檢查。使用明確 selection 維持 snake_case／別名、LEFT JOIN null、排序與查詢次數；讀取錯誤沿用 sanitizeDatabaseError。

原生 SQL 審查結果（不以清除 `.prepare()` 為目的）：

| 保留範圍                                                                       | 原因與測試位置                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistence.ts` staging JSON upsert                                           | 每 100 筆以三個參數執行 set-based upsert；逐筆 values 會擴大參數數量。`persistence.test.ts` 驗證批次、upsert 與失敗清理。                                                                                                                                                                                                                       |
| staging promotion 與 `repository.ts` statement factories、service／TDCC 呼叫端 | 依 ENTITY_ORDER、前置 statement 數量與 count offset 解讀結果；lifecycle reconciliation、finalize、cursor、cleanup 組成單一 D1 batch。保留整組以免跨檔案混入不同 query object。`persistence.test.ts`、identity migration tests 涵蓋偏好、ID、pending→posted、linked／separate；`drizzle-runtime.test.ts` 驗證中途失敗回滾與保留 staging 後重試。 |
| einvoice／TDCC durable item 寫入與 create-or-get insert                        | item claim、JSON merge、計數及五個 statement 的 einvoice promotion 保留原生 SQL 與設定版本 CAS；create-or-get 的 insert 保留 partial unique conflict fallback。run／item 及衝突後的 row 讀取已轉換。`einvoice-run-repository.test.ts`、`tdcc-run-repository.test.ts` 與各 sync-service tests 驗證重送與結案。                                   |
| schedule／notification-batch／report 寫入與財務 CTE 聚合                       | 一般讀取已轉換；排程設定＋繼承工作更新、固定成員快照、notification claim、報告修復＋財務快照維持原生寫入邊界。`calculateCurrentFinancialSnapshot` 的跨資產最新值、匯率與缺幣清單 CTE 聚合另保留 SQL。`notification-batch-repository.test.ts`、`report-repository.test.ts`、scheduler tests 持續驗證。                                           |

`apps/worker/tests/features/sync/drizzle-runtime.test.ts` 使用既有 Miniflare／workerd harness，實測三種 lease 競爭只有一方成功、舊 owner 無法續租／釋放、到期邊界、active run conflict、terminal guard、refresh claim 上限、敏感錯誤遮罩，以及 promotion 的回滾、count offset、cursor 與 cleanup；另驗證一般排程／run 讀取的 row shape、null、排序、設定別名與到期邊界。未改 schema、ID、migrations 或部署流程；未寫入正式 D1、未執行真實銀行同步。

### 階段 5：Drizzle Kit 接軌未來 schema migrations

此階段可以獨立交付；階段 1–4 期間仍以既有 SQL migrations 為 schema 權威，Drizzle schema 同步維護並透過比對檢查防止漂移。

建議流程：

1. 鎖定與 ORM 相容的 Kit 版本，加入本機 `drizzle.config.ts` 與生成指令；SQL 產生不需要正式 D1 credentials。
2. 以當下全部已提交 migrations 的最終 schema 建立 Kit baseline snapshot。baseline 的完整 CREATE TABLE SQL 放在 Wrangler 不掃描的工具目錄，不能加入既有部署路徑重跑，也不修改 `d1_migrations` 假裝執行過它。
3. 先驗證「schema 未變更時，Kit 不產生 DDL 差異」，再用暫時新增 nullable 欄位的演練驗證生成、套用及再次生成無差異；演練完成後移除示範變更。
4. 保留 `packages/db/migrations/` 所有舊 SQL 的名稱、內容與順序。將未來審查過的 Kit SQL 以當時下一個可用序號加入該目錄，繼續由 Wrangler 執行；不假定下一號一定是 0044。
5. Kit snapshots 與生成 SQL 可留在獨立工具目錄，提交時一起帶入對應的 Wrangler SQL。若需要複製／編號腳本，只實作確定的映射與一致性檢查，避免生成 SQL 和實際部署 SQL 漂移。
6. 資料修復、backfill、seed 與特殊 D1 SQL 繼續使用自訂 migration。會改變 schema 的手寫 migration 需同步更新 Drizzle schema／snapshot；僅修改資料的 migration 不需要偽造 schema 差異。
7. 維持 `db:migrate:local`、`db:migrate:remote` 及部署前套用流程；不引入第二套 Drizzle migration ledger，也不使用 `drizzle-kit push` 同步正式 schema。
8. 驗證新建空 DB 能重播全部歷史並升到最新；既有版本 DB 只執行新增 migration；第二次 apply 沒有 pending migrations。兩條路徑的最終 schema、外鍵及代表性資料一致。

Wrangler 已支援 `migrations_pattern`，未來亦可直接讀取 Drizzle 的巢狀目錄。但本計畫優先保留既有平面目錄，因為 schema 文件產生器與多個測試目前都以頂層 SQL 為前提。若實際選用的 Kit 版本改採巢狀輸出，須一併調整所有 migration consumers，且不得移動舊檔導致 ledger 視為新 migration。[Cloudflare migrations 文件](https://developers.cloudflare.com/d1/reference/migrations/)

## 驗證、文件與交付順序

建議 PR 拆分：基礎 schema／client／整合測試 → exchange-rates → 一般 CRUD（依 3A–3D 分批）→ 同步審查與必要轉換 → Kit 接軌。每個 PR 都應可單獨回退程式碼。

每次 commit 或開／更新 PR 前，從 repo root 依序執行：

```sh
npm run format:check
npm run typecheck
npm run test:backend
```

第一個含 ORM runtime 的 PR 另驗證 Worker 打包與隔離 D1 runtime；後續只有 dependency／打包行為改變時才重做相同檢查。若影響前端才追加 frontend unit tests。CI pending 與本機通過分別列示。

文件維護：

- 階段 1–2 更新 `docs/002-backend-architecture.md` 的 DB client、schema、repository 回傳及 raw SQL 使用約定；必要時更新 `AGENTS.md` 的索引。
- 階段 5 更新 `docs/005-deployment.md` 與 README 對應的 migration 開發／部署說明。
- 業務 schema 改變時同步維護 `packages/db/schema-metadata.json`，執行 `npm run db:schema:docs`；不直接手改 `docs/database-schema.md`。
- 純 ORM 查詢轉換不改資料來源或 connector protocol，因此不需為導入而改 connector 使用說明。

## 上線與回退

階段 1–4 原則上沒有 schema migration，可透過回退對應 Worker 版本恢復既有存取方式。驗證以 synthetic／demo fixture 為主；正式環境讀取檢查與部署依實作當次授權進行，不為驗證導入而啟動銀行同步。

後續若有 schema migration，先確認目標、備份並在隔離資料庫驗證，再執行遠端 migration。採先新增可相容 schema 再部署程式的方式；刪除／重建表或不可逆資料轉換另行規劃。Worker 回退不等於資料庫回退，需為具體 migration 決定 forward fix 或還原流程。

完整導入的完成條件：schema 比對通過；一般 CRUD 預設使用 Drizzle；剩餘 raw SQL 有明確原因；D1 batch／lease 實測通過；API 與金融資料語意維持一致；Kit 若接管生成，已證明新建與升級路徑均可用。

## 查核來源

- [Drizzle D1 driver](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)：D1 binding 初始化；頁面目前使用 RC 範例，須對照所選穩定版。
- [Drizzle SQLite batch](https://orm.drizzle.team/docs/sqlite/batch-api)：D1 batch 支援與結果型態；實作仍須以鎖定版本驗證。
- [Drizzle Kit pull](https://orm.drizzle.team/docs/drizzle-kit-pull)：從既有 schema introspection 起草定義。
- [Cloudflare D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：D1 原子批次行為。
- [Cloudflare migrations](https://developers.cloudflare.com/d1/reference/migrations/)：Wrangler ledger 與目錄匹配方式；本次已透過 Cloudflare Docs MCP 核對。

階段 1–2 已在隔離環境完成 schema 比對與 Miniflare D1 讀寫／回滾驗證；未連線正式 D1，也未改寫既有 SQL migrations。
