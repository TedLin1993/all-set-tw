# Taiwan Fin Hub 專案指引

## 專案概況

- 本專案是使用 TypeScript ESM 與 npm workspaces 管理的 monorepo。
- 前端位於 `apps/web`，使用 Svelte 5、Vite、Tailwind CSS 4 與 TanStack Svelte Query。
- 後端位於 `apps/worker`，執行於 Cloudflare Workers，使用 Hono 提供 API。
- 資料庫使用 Cloudflare D1；schema 變更由 `packages/db/migrations` 管理。
- 身分驗證使用 Cloudflare Access，由 Worker 驗證 Access JWT。
- 需要瀏覽器操作的銀行連接器使用 Cloudflare Browser Rendering 與 Puppeteer。
- 驗證碼辨識使用 Cloudflare Workers AI。
- 排程同步使用 Workers Cron Triggers 啟動 Cloudflare Queue，並以 D1 sync jobs
  逐一執行 connector；每個 connector 使用獨立的 Queue consumer invocation。

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
- 修改前依下方「文件閱讀與維護」對照表閱讀相關文件。

## 常用驗證指令

- 全部格式化：`npm run format`
- 全部格式檢查：`npm run format:check`
- 全部型別檢查：`npm run typecheck`
- 前端驗證：`npm run verify:web`
- 後端測試：`npm run test:backend`
- 全部 workspace 建置：`npm run build`

## 提交與 PR 前必跑檢查

每次 commit 或開／更新 PR 前，必須從 **repo root** 跑與 CI 相同的檢查，不得省略。

- 先跑 `npm run format:check`，再跑 `npm run typecheck`，然後跑此次變更適用的 `npm run test:backend` 或前端 unit tests。
- **禁止**用 `prettier --check <touched files>` 代替 `npm run format:check`。只對改動檔跑 Prettier 通過，不算完成。
- CI（`.github/workflows/ci.yml`）順序為 `format:check` → `typecheck` → `test:backend` → `test:unit` → `build`。在本地通過前三項中適用的檢查之前，不得視為 commit 完成。

## 文件閱讀與維護

開始修改前，依任務範圍閱讀下表文件的相關章節；跨領域變更須涵蓋所有涉及的文件，不必每次讀完整個 `docs/`。

| 涉及的變更                       | 修改前閱讀，描述受影響時同步更新                                |
| -------------------------------- | --------------------------------------------------------------- |
| 後端架構、同步、Queue、排程      | `docs/002-backend-architecture.md`                              |
| 前端結構、資料查詢、共用元件     | `docs/003-frontend-architecture.md`                             |
| 連接器、登入、驗證碼、資料正規化 | `docs/004-connector-development.md`；涉及同步流程時也讀後端架構 |
| 部署、自動更新、環境變數         | `docs/005-deployment.md`、`README.md` 對應章節                  |
| 資料庫 schema                    | `docs/database-schema.md`、相關 `packages/db/migrations/*.sql`  |
| 使用方式、支援資料來源、限制     | `README.md` 對應章節                                            |

- 若變更使文件描述不再正確，必須在同一個 PR 更新相關文件；純重構且不影響文件描述時，不必為了更新而更新。
- Schema 變更須同步維護 `packages/db/schema-metadata.json`，並從 repo root 執行 `npm run db:schema:docs`，提交重新產生的 `docs/database-schema.md`；不得直接手改產生的文件。
- 提交前對照 diff 檢查文件是否仍符合實作。PR 說明須列出文件更新項目；不需更新其他文件時，簡述原因。
- `docs/001-cron-sync-design.md` 是歷史設計，不作為現行實作依據；現行排程與同步行為維護於 `docs/002-backend-architecture.md`。
- 架構判斷以實際程式碼及各 workspace 的 `package.json` 為最終依據。
- 技術棧、目錄責任或主要驗證指令改變時，應同步更新本文件。
- `README.md` 用於產品介紹、部署與使用說明；本文件維持精簡，作為開發工作的快速架構索引。
