# Taiwan Fin Hub 專案指引

## 專案概況

- 本專案是使用 TypeScript ESM 與 npm workspaces 管理的 monorepo。
- 前端位於 `apps/web`，使用 Svelte 5、Vite、Tailwind CSS 4 與 TanStack Svelte Query。
- 後端位於 `apps/worker`，執行於 Cloudflare Workers，使用 Hono 提供 API。
- 資料庫使用 Cloudflare D1；schema 變更由 `packages/db/migrations` 管理。
- 身分驗證使用 Cloudflare Access，由 Worker 驗證 Access JWT。
- 需要瀏覽器操作的銀行連接器使用 Cloudflare Browser Rendering 與 Puppeteer。
- 驗證碼辨識使用 Cloudflare Workers AI。
- 排程同步使用 Workers Cron Triggers 與 D1 sync jobs。

## 文字與 Review 規範

- Code review、PR review comment、審查摘要與修改建議一律使用正體中文；必要的技術名詞、程式碼與指令可保留英文。

## 目錄責任

- `apps/web`：Svelte 前端、頁面、元件、資料查詢與前端測試。
- `apps/web/src/app`：前端 Composition Root、導覽、全域 providers 與應用層型別。
- `apps/web/src/data`：依 API resource 組織的 query options 與前端 response DTO。
- `apps/web/src/features`：依使用者功能組織的頁面、feature 元件與純商業顯示邏輯。
- `apps/web/src/shared`：跨 feature 共用的 UI、API client、格式化、state 與 actions。
- `apps/worker`：Hono API、同步流程、Cloudflare bindings 與靜態網站服務。
- `apps/worker/src/features`：依業務功能組織的後端 vertical slices。
- `apps/worker/src/connectors`：依賴 Browser Rendering、Workers AI 等 Worker bindings 的連接器 adapter。
- `packages/core`：前後端、資料庫與連接器共用的穩定型別及契約。
- `packages/connectors`：不依賴 Hono、D1 或 Worker `Env` 的外部資料來源邏輯。
- `packages/db`：跨 feature 共用的 D1 基礎能力與 migrations。
- `docs/002-backend-architecture.md`：後端分層、相依方向與維護約定的詳細文件。
- `docs/003-frontend-architecture.md`：前端分層、相依方向與測試 colocate 約定。
- `docs/004-connector-development.md`：Connector catalog、連接模式、敏感狀態與新增流程規範。

## 架構約定

- 後端採 feature-oriented Vertical Slice Architecture。
- `apps/worker/src/index.ts` 是 Composition Root，只負責 middleware、routes、錯誤處理、靜態資源與 scheduled event 的組裝。
- HTTP concerns 放在 `route.ts`，use case 與商業流程放在 `service.ts`，feature 專用 SQL 放在 `repository.ts`。
- 共用 API contract 與金融資料型別放在 `packages/core`，不得混入 Hono `Context`、D1 row 或 Puppeteer object。
- 前端採 feature-first 結構；`features` 可依賴 `data` 與 `shared`，`data`、`shared` 不得反向依賴 feature。
- 前端單元及元件測試與實作 colocate；Playwright browser tests 放在 `apps/web/e2e`。
- 詳細後端變更開始前，先閱讀 `docs/002-backend-architecture.md` 的相關章節。
- 詳細前端結構變更開始前，先閱讀 `docs/003-frontend-architecture.md`。

## 常用驗證指令

- 全部型別檢查：`npm run typecheck`
- 前端驗證：`npm run verify:web`
- 後端測試：`npm run test:backend`
- 全部 workspace 建置：`npm run build`

## 文件維護

- 架構判斷以實際程式碼及各 workspace 的 `package.json` 為最終依據。
- 技術棧、目錄責任或主要驗證指令改變時，應同步更新本文件。
- `README.md` 用於產品介紹、部署與使用說明；本文件維持精簡，作為開發工作的快速架構索引。
