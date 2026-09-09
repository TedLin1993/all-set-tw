# 前端架構

`apps/web` 是 Svelte 5 + Vite 的 client-side application。Worker 提供 `/api` 與建置後的靜態資源；目前不使用 SvelteKit routing。

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

完整前端驗證使用：

```bash
npm run verify:web
```

## 活動金額顯示

活動頁手機列表、桌面列表與詳情統一以台幣顯示；外幣交易沿用分類圖表的目前匯率，
標示「約」並保留原幣副標示，詳情列出匯率與更新時間。資料庫原始金額與幣別不變，
不以待入帳授權金額替代外幣入帳金額。缺少匯率時顯示無法換算，月份總額與分類圖表
提示尚未包含的幣別並提供重試。隱藏金額同時遮蔽台幣與原幣。
