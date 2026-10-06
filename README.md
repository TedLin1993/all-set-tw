<p align="center">
  <img src="apps/web/public/icon-512x512.png" alt="不用記帳 Logo" width="160">
</p>

# 不用記帳

**ALL SET — 自動同步銀行、信用卡、投資與電子發票的自架個人財務整合工具。**

**可免費自架：** 可透過 [Cloudflare Workers Free Plan](https://developers.cloudflare.com/workers/platform/pricing/) 一鍵部署，不需要自行準備伺服器；一般個人低頻使用可從免費方案開始。

## 目前介面

以下畫面使用匿名 Demo 資料，取自目前版本。

| 桌面版總覽                                                                                                                         | 手機版總覽                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| <a href="images/screenshots/01-dashboard.png"><img src="images/screenshots/01-dashboard.png" alt="桌面版總覽畫面" width="720"></a> | <a href="images/screenshots/02-overview-mobile.png"><img src="images/screenshots/02-overview-mobile.png" alt="手機版總覽畫面" width="260"></a> |

| 資產清冊                                                                                                       | 活動分析                                                                                                           | 設定與資料來源                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| <a href="images/screenshots/03-assets.png"><img src="images/screenshots/03-assets.png" alt="資產清冊畫面"></a> | <a href="images/screenshots/04-activity.png"><img src="images/screenshots/04-activity.png" alt="活動分析畫面"></a> | <a href="images/screenshots/05-settings.png"><img src="images/screenshots/05-settings.png" alt="設定與資料來源畫面"></a> |

## 支援資料來源

| 資料來源     | 支援內容                                                                                              | 登入與驗證                   |
| ------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------- |
| 電子發票載具 | 載具發票與品項明細                                                                                    | App 登入                     |
| 集保 e 存摺  | 交割帳戶餘額與明細（[支援銀行](https://epassbook.tdcc.com.tw/zh/g1.aspx)）、股票、ETF、基金持倉與交易 | App 登入；首次可能需要 OTP   |
| 玉山銀行     | 存款帳戶、餘額與交易；信用卡帳單與刷卡交易                                                            | 網銀登入                     |
| 國泰世華銀行 | 臺幣存款帳戶、餘額與交易；外幣活存帳戶與餘額；信用卡帳單與刷卡交易                                    | 網銀登入；額外驗證需人工處理 |
| 永豐行動銀行 | 臺外幣活存帳戶、餘額與近三個月交易；信用卡總覽、近期帳單與未出帳消費                                  | 網銀登入；AI 自動辨識驗證碼  |
| 台新銀行     | 信用卡額度、帳單、已入帳與即時授權消費                                                                | 網銀登入；AI 自動辨識驗證碼  |
| 中國信託銀行 | 存款帳戶、餘額與交易；信用卡帳單、已入帳、未出帳與即時消費明細                                        | App 登入                     |
| 新光銀行     | 臺外幣帳戶、餘額、交易明細與信用卡帳單                                                                | App 登入                     |
| 華南銀行     | 存款帳戶與餘額；信用卡帳單與刷卡明細                                                                  | 網銀登入；AI 自動辨識驗證碼  |
| 王道銀行     | 活存、定存、餘額與交易                                                                                | App 登入；AI 自動辨識驗證碼  |
| 第一銀行     | 存款帳戶、餘額與交易明細；信用卡帳單與刷卡明細                                                        | 網銀登入；AI 自動辨識驗證碼  |
| 凱基銀行     | 臺幣活存帳戶、餘額與交易明細                                                                          | 網銀登入；AI 自動辨識驗證碼  |
| 樂天國際銀行 | 臺幣活存帳戶、每日餘額與交易明細                                                                      | 網銀登入；AI 自動辨識驗證碼  |
| 兆豐銀行     | 存款帳戶、餘額與交易；信用卡帳單與消費                                                                | App 登入；AI 自動辨識驗證碼  |
| 將來銀行     | 主帳戶與活存口袋餘額、交易；定存口袋餘額                                                              | 網銀登入；AI 自動辨識驗證碼  |

## 使用限制

- 連接器依賴外部網頁、App API 與回應格式；資料來源改版後可能需要更新才能恢復同步。
- 系統不會繞過圖形驗證碼、OTP、裝置驗證等互動式安全機制；需要人工處理時會停止同步並顯示提示。
- 同步最多執行 10 分鐘；電子發票與集保包含 Queue 等待時間。停滯工作由排程恢復，也可在資料來源面板重試；逾時後需重新啟動同步。
- 部分銀行自動登入可能中斷你正在使用的官方 App 或網銀工作階段。
- 資料更新時間與完整性取決於外部服務，不應視為銀行、券商或財政部的即時正式對帳資料。

## 免費部署

本專案使用的 Workers、D1、Queues、Workers AI 與 Browser Run 均提供免費額度。各項免費額度並非無限；超過服務限制時，相關功能可能暫停至額度重置。

**需要：** [Cloudflare 帳號](https://dash.cloudflare.com/signup)、[GitHub 帳號](https://github.com/signup)

### 步驟一：一鍵部署

點擊下方按鈕。Cloudflare 會在你的 GitHub 帳號建立新的 repository、自動建立 D1 Database，並部署至 Cloudflare Workers：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TedLin1993/all-set-tw)

首次使用時，依畫面透過 **Git account → New Github Connection → Install & Authorize** 授權 Cloudflare 存取 GitHub。

Worker Secret 只需填入 **`CONFIG_ENCRYPTION_KEY`**。

`CONFIG_ENCRYPTION_KEY` 是系統加密連接器設定時必須使用的金鑰，可用下列指令產生：

```bash
openssl rand -hex 32
```

金鑰只需填入一次，Cloudflare 會保存供後續更新使用。建議另外存入密碼管理器，重建或搬移時使用相同金鑰；不要在既有部署中更換或刪除，以免無法解密連接器設定。

<img src="images/deploy-setup.png" alt="Cloudflare 部署頁的 CONFIG_ENCRYPTION_KEY 欄位" width="700">

將 **Build command** 設為 `npm run build`、**Deploy command** 設為 `npm run deploy`，資源名稱可保留預填值。在同一頁開啟 **Protect with Cloudflare Access**，設定：

- **Scope：All traffic**，保護正式與預覽部署
- **Authentication policy：Cloudflare account**，限定你的 Cloudflare 帳戶成員登入
- **Session duration**：可保留預設 **24 hours**；想延長可選 **7 days**

<img src="images/deploy-access-on-create.png" alt="部署頁開啟 Cloudflare Access，選擇 All traffic 與 Cloudflare account" width="700">

確認後點擊 **Deploy**。前往 **Worker → Settings → Builds**，等該次 build 顯示成功後重新整理 Worker 頁面，再開啟網站。登入驗證設定會自動取得，後續更新也會沿用。

### 步驟二：確認部署

1. 開啟 Worker 的 `workers.dev` 網址，確認會先要求 Cloudflare Access 登入
2. 登入後前往「設定 → 資料來源」設定連接器
3. 點擊同步以取得最新資料

### 延長登入期限（選用）

部署頁的 **Session duration** 最多可選 **7 days**。若要延長至一個月，部署完成後前往 **Cloudflare One／Zero Trust → Access controls → Applications**，找到保護此 Worker 的 Application：

若頁面顯示 **Finish your account setup**，先點擊 **Choose a plan**，完成 **Zero Trust Free** 方案設定。

1. 點擊該 Application 的 **Configure**，開啟 **Application details**。
2. 點擊頁面上方與 **All、Destinations、Policies** 同一排的 **Details** 按鈕，或直接向下捲到頁面最下方。
3. 在 **Details** 區塊的 **Name** 欄位旁，將 **Session Duration** 設為 **1 month**，再點擊 **Save**。

後續自動部署與更新會沿用這些登入設定。

部署與登入故障排查及自動更新原理，請參考[進階部署與更新](docs/005-deployment.md)。

## 自動更新

Cloudflare 的 Deploy to Cloudflare 流程目前不會將 `.github/workflows` 複製到新 repository，因此首次部署可以正常使用，但需要完成下方的一次性設定才會啟用版本更新。

### 一次性啟用更新功能

不需要修改程式碼，可直接在 GitHub 網頁完成：

1. 在你的部署 repository 開啟 [`deploy/github/sync-upstream.yml`](deploy/github/sync-upstream.yml)，點擊 **Raw** 並複製完整內容
2. 回到 repository 首頁，選擇 **Add file → Create new file**
3. 將檔名設為 `.github/workflows/sync-upstream.yml`，貼上剛才複製的內容並 commit 至 `main`
4. 前往 **Settings → Actions → General → Workflow permissions**，確認已允許 GitHub Actions 讀寫 repository 內容

若已將 repository clone 至本機，也可以執行：

```bash
mkdir -p .github/workflows
cp deploy/github/sync-upstream.yml .github/workflows/sync-upstream.yml
git add .github/workflows/sync-upstream.yml
git commit -m "啟用版本自動更新"
git push
```

完成一次性設定後，可以前往部署 repository 的 **Actions → Sync Latest Version → Run workflow**，點擊 **Run workflow** 立即更新。workflow 也會在每天台灣時間 **04:15** 自動執行。

每次執行會取得最新版本、進行安全三方合併，並由 Cloudflare Workers Builds 重新部署。若你修改過程式碼並與上游發生衝突，workflow 會停止且不會推送；請從 Actions 紀錄查看衝突並手動處理。首次同步、備份 branch 與舊版 workflow 的排查方式請參考[進階部署與更新](docs/005-deployment.md)。

## 本機開發

建立不納入版本控制的私人設定，將 `wrangler.local.toml` 的 D1 Database ID 換成開發用資料庫，並在 `.dev.vars` 設定自己的 `CONFIG_ENCRYPTION_KEY`：

```bash
cp apps/worker/wrangler.local.toml.example apps/worker/wrangler.local.toml
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
npm install
npx wrangler login
npm run dev
```

範例設定的 D1 與 Workers AI 會連到 Cloudflare remote binding，請勿使用正式資料庫。常用驗證指令：

```bash
npm run format:check
npm run typecheck
npm run verify:web
npm run test:backend
npm run build
```

本機 relay、資料庫遷移與既有 D1 部署方式請參考[進階部署與更新](docs/005-deployment.md)。

## 技術架構

前端使用 Svelte 5、TypeScript、Tailwind CSS 4 與 shadcn-svelte。

後端執行於 Cloudflare Workers，以 Hono 提供 API，並整合 D1、Access、Browser Run、Workers AI、Cron Triggers 與 Queues。

專案以 npm workspaces 管理 `apps/web`、`apps/worker` 與根目錄的 `shared/`。`shared/` 以 `@taiwan-fin-hub/shared` 提供前後端共用的型別、契約與純邏輯。資料庫程式位於 `apps/worker/src/db`，SQL migrations 位於 `apps/worker/migrations`；各銀行、集保與電子發票的同步、connector、API client 及資料解析集中於 `apps/worker/src/sources/<connectorId>`，共用同步管理位於 `apps/worker/src/features/sync`。

前後端與共用套件皆使用 TypeScript 7 型別檢查；Svelte 前端透過 `svelte-check --tsgo` 執行，並保留工具所需的 TypeScript 6 相依。

詳細設計請參考[後端架構](docs/002-backend-architecture.md)、[前端架構](docs/003-frontend-architecture.md)與[連接器開發](docs/004-connector-development.md)。

## 安全機制

- Cloudflare Access 是一般模式的登入閘道；Worker 會驗證 JWT 的簽章、issuer、audience 與有效期限。
- 連接器帳密以 `CONFIG_ENCRYPTION_KEY` 衍生的金鑰進行 AES-GCM 加密，D1 只儲存密文。
- 目前不支援金鑰輪替；若刪除或更換 Cloudflare 中的金鑰，必須重新設定所有連接器。

## 免責聲明

本程式僅供個人研究與自用，未與臺灣集中保管結算所、財政部、金融監督管理委員會、各銀行或任何金融機構合作，亦未獲前述機構授權或背書。本程式所呈現之資料以您自行提供之憑證取得，作者不保證資料之即時性、正確性與完整性，亦不對因使用本程式所產生之任何直接或間接損失負責。請勿將本程式用於任何商業用途。

## License

本專案採用 [MIT License](LICENSE)，並保留原專案的著作權與授權聲明。

> 本專案以 [kevchentw/taiwan-fin-hub](https://github.com/kevchentw/taiwan-fin-hub) 為基礎發展而來。感謝原作者與貢獻者奠定專案基礎。
