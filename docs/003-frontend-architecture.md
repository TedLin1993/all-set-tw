# 前端架構

`apps/web` 是財務網站的 Svelte 5 + Vite client-side application。Worker 提供 `/api` 與建置後的靜態資源；目前不使用 SvelteKit routing。

`apps/deployer-web` 是獨立的部署網站，沿用 Svelte 5 與 feature-first（`app` / `data` / `features` / `shared`）。它不得依賴 `apps/web` 的 feature，也不讀取金融 API。目前畫面涵蓋授權說明、帳戶選擇、預檢、首次安裝進度（準備環境 → 設定登入保護 → 安裝版本 → 驗證完成），以及 ready 安裝的版本比較與更新進度（準備更新 → 暫停同步 → 安裝版本 → 恢復並驗證）。正式 OAuth live 驗證與維護者帳戶實際寫入 R2 latest 仍屬後續階段。

## 目錄責任

```text
apps/web/src/
├── app/       # composition root、導覽、全域 provider 與應用層型別
├── data/      # 依 API resource 分組的 query options 與 response DTO
├── features/  # 依使用者功能分組的頁面、元件與 feature model
├── shared/    # 無 feature 所屬的 UI、API client、格式化、state 與 actions
├── testing/   # 跨測試共用的 setup、fixture 與 render helper
├── main.ts
└── styles.css
```

## 相依方向

- `app` 負責組裝 feature 與 shared infrastructure。
- `features` 可以依賴 `data`、`shared` 和純應用層型別，但不應直接依賴其他 feature 的內部元件。
- `data` 可以依賴 `shared/api` 與 `packages/core`，不得依賴 UI feature。
- `shared` 不得依賴 feature；若工具只被一個 feature 使用，應放回該 feature 的 `model` 或 `components`。
- 前後端都使用且穩定的 API contract 應逐步移到 `packages/core`；只用於前端組合畫面的 view model 可留在 `apps/web/src/data`。

## Svelte 檔案

- 頁面入口命名為 `*Page.svelte`，feature 專用子元件放在相鄰的 `components/`。
- 純計算、mapping 和 filtering 放在一般 `.ts`，並以單元測試覆蓋。
- 只有需要在元件外使用 runes 的共享 reactive state 才使用 `.svelte.ts`。
- 全域 reactive state 應保持少量且明確；server state 由 TanStack Svelte Query 管理。

## 測試

- Vitest 單元測試及元件測試與被測檔案 colocate，命名為 `*.test.ts`。
- Playwright browser tests 放在 `apps/web/e2e`，命名為 `*.spec.ts`。
- 共用測試初始化放在 `apps/web/src/testing`。

## Imports

跨目錄 import 使用 `@/` 指向 `apps/web/src`；同一小型目錄內可使用相對路徑。避免建立會隱藏 feature 邊界的大型 barrel file。

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

活動頁手機列表、桌面列表與詳情統一以台幣顯示；外幣交易沿用分類圖表的目前匯率，
標示「約」並保留原幣副標示，詳情列出匯率與更新時間。資料庫原始金額與幣別不變，
不以待入帳授權金額替代外幣入帳金額。缺少匯率時顯示無法換算，月份總額與分類圖表
提示尚未包含的幣別並提供重試。零金額不需匯率即可計為 0，也不觸發缺少匯率提示。
隱藏金額同時遮蔽台幣與原幣。

## 總覽同步明細

`LatestSyncReportCard` 顯示「最近一次排程同步」，展開「查看各資料來源」後直接列出各來源本次活動。
`SyncActivityDetails` 展示該次同步的活動名稱、標記與原幣金額；來源區塊展開時以一次
`GET /api/sync-reports/:batchId/activities` 載入全部來源明細並支援重試。
明細展示新增活動、已入帳、補上發票及原幣金額，沿用全域隱藏金額設定。
日期是活動發生日期，同步時間另列；已配對發票合併顯示，活動筆數不等同新增資料筆數。
舊報告沒有明細時明確說明，不顯示成「沒有變動」。
