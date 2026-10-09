# 前端架構

`apps/web` 是 Svelte 5 + Vite 的 client-side application。Worker 提供 `/api` 與建置後的靜態資源；目前不使用 SvelteKit routing。

## 目錄責任

```text
apps/web/src/
├── app/       # composition root、導覽、全域 provider 與應用層型別
├── data/      # 依 API resource 分組的 query options 與 response DTO
├── features/  # 依使用者功能分組的頁面、元件與 feature model
├── shared/    # 無 feature 所屬的 UI、API client、格式化、state 與 actions
├── main.ts
└── styles.css
```

## 相依方向

`apps/web/src/shared/` 提供前端共用 UI 與工具；根目錄的 `shared/` 提供前後端共用契約與純邏輯，透過 `@taiwan-fin-hub/shared` 引用。

- `app` 負責組裝 feature 與 shared infrastructure。
- `features` 可以依賴 `data`、`shared` 和純應用層型別，但不應直接依賴其他 feature 的內部元件。
- `data` 可以依賴前端的 `shared/api` 與 `@taiwan-fin-hub/shared`，不得依賴 UI feature。
- `shared` 不得依賴 feature；若工具只被一個 feature 使用，應放回該 feature 的 `model` 或 `components`。
- 前後端都使用且穩定的 API contract 應逐步移到根目錄的 `shared/`；只用於前端組合畫面的 view model 可留在 `apps/web/src/data`。
- 根目錄的 `shared/` 是唯一跨前後端共用的 workspace 套件；資料庫與連接器由 `apps/worker` 管理，前端不得引用 Worker 內部模組。

銀行與信用卡帳單 API 的 response 契約定義於 `shared/bank-api.ts`，前端 `data/bank/types.ts` 僅提供既有名稱的 type re-export。Worker 在銀行 route 的 JSON 回傳處以 `satisfies` 檢查相同契約；欄位保留現有回應的 `null` 與帳單數值 flag，不將 connector 正規化資料或 ORM row 當作 API response 型別。資料來源 ID 保持現有回應的 string，catalog 的 `ConnectorId` 用於已驗證的 connector 註冊與操作。

## Svelte 檔案

- 頁面入口命名為 `*Page.svelte`，feature 專用子元件放在相鄰的 `components/`。
- 純計算、mapping 和 filtering 放在一般 `.ts`；金融計算依下方測試政策保留必要驗證。
- 只有需要在元件外使用 runes 的共享 reactive state 才使用 `.svelte.ts`。
- 全域 reactive state 應保持少量且明確；server state 由 TanStack Svelte Query 管理。

## 測試

- Vitest 金融計算測試與被測檔案 colocate，命名為 `*.test.ts`，使用 Node environment。
- Playwright browser tests 放在 `apps/web/e2e`，命名為 `*.spec.ts`。
- 單元測試只保留淨資產／負債符號、幣別換算、缺少匯率、配對去重與使用者排除後的金額結果。
- E2E 保留資產清冊與手動資產、銀行手動驗證、活動排除／恢復、發票配對／解除、資料載入失敗重試及排程離頁儲存的資料完整性。每個流程選一個 viewport，不另建元件測試重複驗證。
- E2E 以模擬 API 驗證真實頁面互動；不代表銀行登入或後端資料寫入已通過整合驗證。
- 不為 UI 包裝、固定文案、樣式、導覽內部狀態或一般 mapping／filtering 建立測試；可透過型別檢查、建置與實際操作確認。
- 新測試須能說明它防止哪個金額錯誤、資料損壞、安全問題或主要流程失效。以既有核心測試擴充為優先，不以 coverage 或案例數作為目標；完整原則見後端文件的「測試與驗證」。

## Imports

跨目錄 import 使用 `@/` 指向 `apps/web/src`；同一小型目錄內可使用相對路徑。避免建立會隱藏 feature 邊界的大型 barrel file。

## 關於與組建資訊

`features/settings/components/AboutPanel.svelte` 透過 `#/about` 顯示上游版本的 Commit、分支與 UTC 組建時間，
並提供複製診斷資訊。桌面「設定 → 關於」與手機「更多 → 關於」皆提供入口，沿用設定頁的 lazy loading。
Vite 在組建時注入 `__BUILD_INFO__`，型別宣告位於 `src/vite-env.d.ts`；頁面不另查版本 API。
Commit 顯示前七碼，複製內容包含來源專案與完整上游 SHA；剪貼簿寫入失敗時顯示唯讀文字框，供手動選取完整診斷資訊。
資訊來源與本機開發時間的定義見部署文件。

## 驗證

前端 `typecheck` 使用 `svelte-check --tsgo` 進行 TypeScript 7 型別檢查；
`build` 先執行同一個 `typecheck`，再由 Vite 打包。
TypeScript 7 透過根目錄的 `@typescript/native` npm alias 安裝，
並保留 `svelte-check` 所需的 TypeScript 6 相依。
Vite 資源型別透過 `vite/client` 載入；`.svelte-check` 是不提交的產生檔。

完整前端驗證使用：

```bash
npm run verify:web
```

## 活動時間顯示

已配對發票的信用卡與銀行活動一律優先使用發票含時區的時間；發票沒有時刻時，沿用原交易時間。
此規則由共用活動資料組裝套用於列表、詳情與搜尋排序，解除配對後恢復銀行日期。
只提供日期的發票不補時刻，也不回寫銀行原始交易資料。

## 活動金額顯示

總覽與資產頁按信用卡餘額的正負號計算淨負債：負餘額是欠款，正餘額是溢繳，
不得將兩者取絕對值後都扣除。淨溢繳時顯示「信用卡溢繳餘額」並計入淨資產，
單一卡片的溢繳餘額保留正號並標示無需繳款。
信用卡餘額未知時顯示「剩餘應繳金額未取得」；最近帳單明確未繳清時顯示「帳單待繳」與繳款期限，
不僅顯示期限，也不將缺少的繳款狀態當成已繳。

活動頁手機列表、桌面列表與詳情統一以台幣顯示；外幣交易沿用分類圖表的目前匯率，
標示「約」並保留原幣副標示，詳情列出匯率與更新時間。資料庫原始金額與幣別不變，
不以待入帳授權金額替代外幣入帳金額。缺少匯率時顯示無法換算，月份總額與分類圖表
提示尚未包含的幣別並提供重試。零金額不需匯率即可計為 0，也不觸發缺少匯率提示。
隱藏金額同時遮蔽台幣與原幣。

總覽與資產清冊的缺少匯率提示依原始金額判斷，只有實際為 0 才略過。
外幣金額顯示保留原始小數，換算與總額計算也保留原始精度。

## 匯率設定

匯率清單保留 USD、JPY、EUR，並合併銀行／信用卡帳戶、目前投資持倉與手動資產的其他幣別。
清單由 `GET /api/exchange-rates/currencies` 提供，與更新流程共用 `shared/exchange-rates.ts` 的幣別選取規則；
排除 TWD、NAN 等非有效貨幣代碼，去重並略過實際金額為 0 的資產，不以四捨五入後的金額判斷。
尚無匯率時顯示「尚未取得」，
按「更新」後同步取得來源支援的持有幣別。未提供的幣別繼續顯示「尚未取得」，已有匯率則保留原值。

## 總覽同步明細

`LatestSyncReportCard` 顯示「最近一次排程同步」，展開「查看各資料來源」後直接列出各來源本次活動。
`SyncActivityDetails` 展示該次同步的活動名稱、標記與原幣金額；來源區塊展開時以一次
`GET /api/sync-reports/:batchId/activities` 載入全部來源明細並支援重試。
明細展示新增活動、已入帳、補上發票及原幣金額，沿用全域隱藏金額設定。
日期是活動發生日期，同步時間另列；已配對發票合併顯示，活動筆數不等同新增資料筆數。
舊報告沒有明細時明確說明，不顯示成「沒有變動」。
同步報告不顯示快照的匯率提示；目前資產的缺少匯率提示由總覽與資產清冊提供。

## 同步狀態與重試

預設同步排程在變更後自動儲存，連續修改會合併送出；時間選擇器關閉後才儲存完整時間。
儲存期間保留新的修改並依序送出，離開頁面時送出尚未儲存的變更；若時間選擇器仍開啟，
沿用開啟前最後完成的時間選擇，並保留其他排程欄位的修改。畫面顯示儲存中／已儲存，
失敗時保留選擇並提供重試；成功後更新共用排程快取與同步工作資料，僅影響跟隨預設的來源。
Demo 模式與排程資料尚未載入時停用編輯。

`ConnectorPanel` 依 `GET /api/sync-jobs` 的 `running` 與 `phase` 追蹤電子發票／集保 active run，不能只依 connector lock 到期判定完成。API 同時提供 run ID、最近狀態更新時間與最短重試等待秒數；一般同步的狀態時間可能包含 heartbeat，不能當成金融資料更新時間。
`phase = stalled` 時保留 polling，顯示停滯提示與「重試同步」，補送既有 run 的 continuation；集保保留原 run 的 scope。有效 lease 下的工作仍禁止重複同步，重試排入 Queue 後須等待 lifecycle 完成才顯示成功。
