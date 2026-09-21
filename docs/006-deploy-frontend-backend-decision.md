# 部署頁：Notion vs 前後端架構決策

狀態：本機評估結論（未 commit）。日期：2026-09-19。  
對應：`docs/006-browser-deployment-plan.md`、`docs/006-stage0-capability-verification.md`（含 2026-09-19 純前端補驗）、分支 `feat/browser-deploy-plan`／PR #155。

## 問題

Codex 中斷前的問題：

> 有必要多一個前後端嗎？部署頁面寫在 Notion 裡是不是就夠用了？

## 短答

| 選項 | 結論 |
| --- | --- |
| **只放 Notion** | **不夠**做真實安裝／更新。可當給人看的說明與連結頁。 |
| **純前端 SPA 直打 Cloudflare** | **不可行**（目前實測）。OAuth PKCE 可在瀏覽器完成；管理 API 被 CORS 預檢擋住。 |
| **需要後端嗎** | **至少要薄的同網域 API 轉接**（proxy），代打 `api.cloudflare.com`。 |
| **現有完整 deployer（D1＋Queue＋工作編排）** | **不是 CORS 結論的必要條件**。v1 可先做「薄 proxy + 簡單 UI」；持久化工作／Queue 等「關分頁後仍要續跑」再加。 |

## 證據（摘自第 0 階段）

1. **OAuth 可不靠 client secret**  
   官方支援 SPA：Authorization Code + PKCE S256、`token_endpoint_auth_method: none`。本機已註冊 origin 的真實 consent／token 交換回 HTTP 200。

2. **管理 API CORS 失敗**  
   瀏覽器從 `http://localhost:5173` 帶 Bearer 呼叫 `/memberships` 等，在 **OPTIONS 預檢** 就被擋（缺 `Access-Control-Allow-Origin`）。換成有效 token 也救不了預檢。  
   → 純前端「登入後直接建 Worker／D1／Access」這條路目前走不通。

3. **版本產物**  
   現行設計靠 Worker 的 `RELEASE_BUCKET` 等；不能原封不動搬進純靜態頁。純前端若要裝版，還要另開可讀的 HTTP 產物＋digest 驗證。

4. **Notion**  
   無法安全持有部署用短期憑證、無法代打被 CORS 擋住的管理 API、無法可靠編排多步驟安裝／失敗續跑。適合：**說明文件、深連結、檢查清單**；不適合當安裝器本體。

## 對照目前 PR #155 的前後端

`apps/deployer-web` + `apps/deployer-worker` 做的事大致是：

- 瀏覽器 UI（授權、預檢、進度）
- Worker 端 OAuth session、帳戶預檢、installation／job 狀態（獨立 D1）、Queue 消費者骨架
- 目標帳戶的寫入安裝仍多半停在後續階段閘門

這套**方向對**（前端不能直連管理 API），但相對「只要過 CORS」來說偏完整。  
若目標是先驗證「免 GitHub、本機可跑通授權＋列帳戶＋預檢」：

- **必要：** 同網域後端轉接（可先是現有 `deployer-worker` 的精簡路徑，或更小的 proxy）
- **可延後：** 完整 D1 lease、Queue 重試、正式首次安裝／更新編排（Stage 3–4）

## 建議下一步（本機、先不 commit）

1. **保留** stage0 的 2026-09-19 結論（已在 `docs/006-stage0-capability-verification.md` 工作區修改中）。  
2. **不要**為了「寫在 Notion」而刪掉 deployer；Notion 只補文件入口。  
3. **本機驗證順序：**  
   - 啟動 `deployer-worker`（wrangler dev）+ `deployer-web`（vite）  
   - 用測試 OAuth client（PKCE、callback／CORS 指到本機）走完授權  
   - 確認經 **Worker proxy** 的 `memberships`／預檢成功（證明薄後端夠用）  
4. 若 proxy 路徑已通、尚未需要關分頁續跑：暫緩加厚 Queue／正式安裝，等你點頭再做 Stage 3。

### 本機怎麼跑（現有 monorepo）

在 repo 根目錄開兩個終端：

```bash
# 終端 1：部署 API（預設 port 8788）
npm run dev -w @taiwan-fin-hub/deployer-worker

# 終端 2：部署 UI（Vite）
npm run dev -w @taiwan-fin-hub/deployer-web
```

環境變數／OAuth client 設定見 `apps/deployer-worker/.dev.vars.example`，**不要把 secret 寫進 git**。

## 決策紀錄

- **Notion：** 文件 OK；安裝器不夠。  
- **前後端：** 要前端 UI + **至少薄後端 proxy**；不是「可有可無」。  
- **完整編排：** 產品選擇，非 CORS 強制；本機先證明 proxy，再決定是否沿用 PR #155 的 D1／Queue。

（本文件與 stage0 工作區修改皆尚未 commit。）
