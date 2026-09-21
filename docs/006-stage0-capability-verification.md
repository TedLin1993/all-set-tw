# 第 0 階段能力驗證紀錄

狀態：文件驗證及隔離資源的部分線上實測完成；部署完整 scopes 與 Access 使用者登入驗證待完成；2026-09-19 已完成唯讀 client 的真實 PKCE consent／token 交換，管理 API CORS 仍失敗，結果見文末。更新日期：2026-09-19。

本文件對應 `docs/006-browser-deployment-plan.md` 第 0 階段。來源為官方文件、Cloudflare Docs MCP、公開 REST schema，以及本 repo 的 `wrangler.toml`、`packages/db/migrations`、Wrangler 開源 migration 實作。2026-09-17 的文件驗證沒有修改線上資源。2026-09-18 依使用者指定帳戶建立獨立測試資源，沒有改動原有 `taiwan-fin-hub`。以下舊章節保留當時結論，最新實測差異以文末紀錄為準。

**結論：** 全網頁部署在 API 層面看起來可行，沒有已證實的硬阻塞。全新帳戶仍可能需要若干 Dashboard 步驟（尤其是 Zero Trust 開通）。D1 migration 不可用分號天真拆 SQL；應沿用 Wrangler 相容的 `d1_migrations` ledger，並在 Ted 的隔離帳戶證明 `/query` 的原子性後才能定案 REST runner。

## 已證實／待實測／阻塞

| 分類                           | 項目                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已由文件／API 證實             | OAuth Authorization Code、revoke、userinfo、PKCE S256、可自建 OAuth client；Direct Upload 三階段；Worker／D1／Queue／secrets／workers.dev subdomain REST；Access Application 支援 `destinations.type = worker`；Email OTP IdP REST；policy 可精確比對單一 email；Organization `auth_domain` 與 Application `aud` 可 API 取得；Queue 可暫停投遞；D1 Time Travel 可作更新前復原點 |
| 仍需 Ted 隔離測試帳戶          | OAuth 實際 scope 目錄與 consent 帳戶選擇；access token `expires_in` 與僅撤銷 access／同時撤銷 refresh 的語意；全新帳戶 workers.dev 條款；Zero Trust 開通是否強制填付款資料；Access `worker_id` 對應值；Email OTP + 單一 email allow 端到端登入；D1 `/query` 對完整 migration 重播（含 `0044`）是否原子回滾；Cron schedules 寫入時點；Browser／AI binding 在免費帳戶是否即可綁定 |
| 目前非硬阻塞，但會限制產品承諾 | 不可宣稱「全新帳戶零 Dashboard」；不可宣稱維護者端與使用者端永久零成本；Workers Free 的 10 ms CPU 與每日 10 分鐘 Browser Run 會限制銀行同步，這與現行 GitHub 部署相同                                                                                                                                                                                                           |
| 若實測失敗才升級為阻塞         | （1）OAuth 無法同時取得 Workers + D1 + Queues + Access，且沒有可組合的 granular scopes；（2）Access 無法以 REST 保護 workers.dev 且 Dashboard 一鍵 Access 也不能被深連結引導完成；（3）D1 REST 無法原子套用既有 SQL 且受控 Wrangler runner 也無法在憑證隔離下執行                                                                                                               |

---

## 1. OAuth scopes 與 Cloudflare API 能力矩陣

OAuth 文件說明：[建立 client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)、[整合端點](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)。

### 1.1 協議能力（已由文件證實）

| 能力               | 證據                                                                       | 部署服務用法                                                                                 |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Authorization Code | 第三方 client 僅支援此 grant                                               | 後端換 token，client secret 不進瀏覽器                                                       |
| PKCE `S256`        | OpenID config `code_challenge_methods_supported` 含 `S256`                 | 後端 confidential client 可加 PKCE；非必須                                                   |
| Token              | `https://dash.cloudflare.com/oauth2/token`                                 | 用 code + `client_secret_basic` 或 `client_secret_post`                                      |
| Refresh            | OpenID config 含 `refresh_token` 與 `offline_access`                       | 第一版不長期保存 refresh token；若 access token 壽命短於一次安裝，工作期間可加密暫存並設 TTL |
| Revoke             | `https://dash.cloudflare.com/oauth2/revoke`                                | 安裝完成、取消、過期後撤銷                                                                   |
| User info          | `https://dash.cloudflare.com/oauth2/userinfo`；claims 文件僅列 `sub`       | **不可**假設一定有已驗證 Email；允許登入的 Email 仍由使用者填寫                              |
| 公開／私人 client  | 新 client 預設 private；公開須完成 client URL 網域驗證，且不可改回 private | 維護者側準備；使用者帳戶不需自建 OAuth client                                                |

Dashboard 深連結：[OAuth clients](https://dash.cloudflare.com/?to=/:account/oauth-clients)。

### 1.2 Scope 對照（文件層，尚未 live 列出完整目錄）

官方寫明：OAuth scope 名稱對應 [API token permission 名稱](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。建立 client 的範例卻使用 `workers-platform.read`／`workers-platform.write`，這兩個字串**不在** token permission 表內。因此實際目錄必須用 `GET /oauth/scopes`（需有效 token）或 Dashboard 建立 client 畫面在隔離帳戶核對，不能把範例 scope 當成已涵蓋 D1／Queues／Access。

建議向使用者請求的**最小權限集合**（以 token permission 名稱表示；OAuth scope ID 以隔離帳戶回填）：

| 資源                              | 寫入 permission                                                                                  | 唯讀（預檢）                                      | 對應 REST（節錄）                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| 帳戶列表                          | —                                                                                                | `Memberships Read`                                | `GET /memberships`（文件列出此 permission；`GET /accounts` 範例僅示範 API Key） |
| 帳戶設定／子網域                  | `Workers Scripts Write`                                                                          | `Workers Scripts Read` 或 `Account Settings Read` | `GET`／`PUT /accounts/{id}/workers/subdomain`                                   |
| Worker、assets、secrets、bindings | `Workers Scripts Write`                                                                          | `Workers Scripts Read`                            | Direct Upload；`PUT .../workers/scripts/{name}`；`PUT .../secrets`              |
| D1                                | `D1 Write`                                                                                       | `D1 Read`                                         | `POST .../d1/database`；`POST .../query`                                        |
| Queues                            | `Queues Write`（建立 Queue 亦可 `Workers Scripts Write`）                                        | `Queues Read`                                     | `POST .../queues`；`POST .../consumers`                                         |
| Access apps／policies             | `Access: Apps and Policies Write`                                                                | 對應 Read                                         | `POST .../access/apps`；policies                                                |
| Zero Trust org                    | 建立：`Access: Organizations, Identity Providers, and Groups Write`；讀取 Team Domain：同組 Read | 預檢用 Read                                       | `GET`／`POST .../access/organizations`                                          |
| Email OTP IdP                     | 同上 Write                                                                                       | Read                                              | `POST .../access/identity_providers` type `onetimepin`                          |
| Workers AI／Browser Run           | 執行期綁定屬 Worker metadata（`type: ai`／`browser`）                                            | 部署不需代使用者呼叫模型                          | 綁定能否在免費帳戶成功：待實測                                                  |

**不要**申請 Billing、DNS、Zone、R2（目標帳戶）、Workers CI。部署服務自己的 R2 版本庫使用維護者帳戶，不進使用者 OAuth。

Consent 畫面可把部分 scope 標成 optional。第一版建議全部標必選，避免使用者拒掉 D1 或 Access 後部署到一半才失敗。

### 1.3 多帳戶選擇

- Consent 之後，部署服務應只列出**此次授權實際能管理**的帳戶。
- 文件證實可用 `GET /memberships`（`Memberships Read`）列出使用者所屬帳戶；每個後續 API 都帶使用者選的 `account_id`。
- OAuth token 是否自動涵蓋全部 membership、或 consent 可勾選子集：**待隔離帳戶實測**。UI 仍必須讓使用者明確選擇目標帳戶，且拒絕跨帳戶操作。

### 1.4 撤銷與過期

| 行為                         | 文件                                                  | 待實測                                                                                                                         |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 主動撤銷                     | `POST .../oauth2/revoke`                              | 撤銷 access 後，refresh 是否一併失效                                                                                           |
| 過期檢查                     | `GET /user/tokens/verify` 回傳 `status`、`expires_on` | OAuth access token 的實際 `expires_in`                                                                                         |
| 使用者從 Cloudflare 撤銷 app | 未在整合文件細述                                      | 後續 API 錯誤碼（401／403）與如何導回重新授權                                                                                  |
| 第一版策略                   | 計畫已定：不長期保存 refresh token                    | 若 `expires_in` 短於完整安裝（Direct Upload + 全部 migrations），工作期間必須加密暫存 refresh 或要求使用者把安裝拆成可續跑步驟 |

清除部署服務本機／D1 中的加密 token **不等於**已呼叫 Cloudflare revoke；兩者都要做。

---

## 2. 全新 Cloudflare 帳戶仍需的 Dashboard 步驟

部署網站可做唯讀預檢，缺項用深連結送使用者去 Dashboard，回來再檢查。**不得宣稱全新帳戶全程零人工步驟。**

| 步驟                               | 是否可能用 API                                                                                                                                                   | 建議預檢                                                             | 深連結／文件                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 註冊並驗證 Email                   | 否，使用者自己註冊                                                                                                                                               | OAuth 能登入即通過                                                   | [註冊](https://dash.cloudflare.com/signup)                                     |
| 接受 Workers／workers.dev 相關條款 | `PUT /accounts/{id}/workers/subdomain` 可建立子網域，但條款同意畫面未在 API 文件出現                                                                             | `GET .../workers/subdomain`；若 404 或錯誤指須先啟用，顯示 Dashboard | [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) |
| 啟用該 Worker 的 workers.dev 路由  | 是：`POST .../workers/scripts/{name}/subdomain` `{ enabled: true, previews_enabled: false }`                                                                     | 部署後讀回 enabled；本專案 `preview_urls = false`                    | 同上 Worker Settings → Domains                                                 |
| 開通 Zero Trust organization       | API 有 `POST .../access/organizations`，但[開通文件](https://developers.cloudflare.com/cloudflare-one/setup/)要求選方案並**輸入付款資料**（Free 仍要填、不扣款） | `GET .../access/organizations`；失敗則引導 Dashboard                 | [Zero Trust](https://one.dash.cloudflare.com/)                                 |
| 選擇 Zero Trust Free／付費方案     | 文件寫 Dashboard onboarding 必填                                                                                                                                 | 組織存在且 `auth_domain` 可讀                                        | 同上                                                                           |
| Workers Paid（可選）               | 使用者自行升級                                                                                                                                                   | 不阻擋安裝；同步／Browser Run 額度在產品說明揭露                     | [Workers 定價](https://developers.cloudflare.com/workers/platform/pricing/)    |
| 使用者自建 OAuth client            | 不需要                                                                                                                                                           | —                                                                    | 由維護者準備公開 client                                                        |

`auth_domain`（Team Domain）由組織建立時決定，之後難以任意更改；預檢成功後把它存進安裝紀錄，寫入目標 Worker secret `TEAM_DOMAIN`（例如 `https://<team>.cloudflareaccess.com`）。

---

## 3. Access：workers.dev Application、Email OTP、AUD／Team Domain

### 3.1 建議路徑（文件已支持，待隔離帳戶跑通）

1. 目標帳戶已有 Zero Trust organization（見第 2 節）。
2. 部署 bootstrap Worker，並啟用 workers.dev、**關閉** preview URLs。
3. 若帳戶尚未有 One-time PIN IdP：`POST /accounts/{id}/access/identity_providers`，`type: "onetimepin"`。[OTP 文件](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)明確說新組織預設是 Cloudflare IdP，**不再自動加入 OTP**。
4. 建立 Access Application：`POST /accounts/{id}/access/apps`，`destinations` 使用 `{ "type": "worker", "worker_id": "<Worker ID>" }`。這是 Dashboard「一鍵 Access for Workers」的 REST 對應，不要求使用者自有 zone。[Application create](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)
5. Policy：`decision: "allow"`，`include: [{ "email": { "email": "<使用者填的地址>" } }]`。不要加 `everyone`、bypass 或 service token。可限制 `allowed_idps` 為 OTP IdP。
6. 讀回 application 的 `aud` → Worker secret `POLICY_AUD`。讀回 organization 的 `auth_domain` → `TEAM_DOMAIN`。
7. 現有 Worker 已用 `Cf-Access-Jwt-Assertion` 驗證（`apps/worker/src/platform/access-auth.ts`）。首次存取測試必須：未授權被拒、允許的 Email 能進；HTTP 200 或 Access redirect 本身不算成功。

Dashboard 後備（API 失敗時）：[Workers 一鍵 Access 變更說明](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) → Worker → Settings → Domains & Routes → Enable Cloudflare Access → Manage Cloudflare Access 把 Email 改成允許名單。現有操作也寫在 `docs/005-deployment.md`。

### 3.2 實測時必須確認

- `worker_id` 是 script 名稱還是 Workers 平台 UUID（新版 Worker 物件 ID）。
- `type: "worker"` 是否連 preview 一併保護；文件寫 preview 會被保護，且 `preview_worker`／`public` 可覆寫。本專案應保持 `previews_enabled: false`，避免旁路。
- 不要使用 `all_workers`：會誤傷帳戶裡其他 Worker。
- 既有共用 IdP／org 設定：只新增本安裝專用 Application 與 OTP（若缺）；不要改 Global session、不要加 bypass。
- OTP 信件來自 `noreply@notify.cloudflare.com`；政策未允許的 Email 不會收到信，但登入頁仍顯示已寄出。

---

## 4. D1 migrations：REST 與 Wrangler ledger

### 4.1 Wrangler 實際做法（開源證實）

`wrangler d1 migrations apply --remote` **不是**走 `/import` 檔案上傳，而是：

1. 建立 ledger：

```sql
CREATE TABLE IF NOT EXISTS "d1_migrations"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

2. 以檔名（相對 `migrations_dir`，本專案為 `0001_initial.sql` 這類頂層檔名）比對已套用列。
3. 對每個未套用檔案，把檔案全文與下列語句接在一起，一次交給 `POST /accounts/{id}/d1/database/{id}/query`：

```sql
-- <migration 檔案原文>
INSERT INTO "d1_migrations" (name) values ('0001_initial.sql');
```

本專案 `wrangler.toml` 未自訂 `migrations_table`，因此 ledger 名稱必須是 `d1_migrations`，否則之後 `wrangler d1 migrations apply` 會重跑或漏跑。

Wrangler 註解寫明：遠端 `/query` **由伺服器依分號拆 statement**，且 CRLF 在 `BEGIN ... END` 複合語句中會出問題；client 會先正規化換行。本地 `--local` 才用 `packages/wrangler/src/d1/splitter.ts`。

### 4.2 為什麼不能天真用分號拆檔

本 repo 的 SQL 含：

- `PRAGMA defer_foreign_keys = ON;`（`0025`、`0044`）
- 大量 `CASE ... END` 運算式（例如 `0032`、`0033`、`0035`、`0037`）
- `0044_text_primary_keys_not_null.sql`：約 31 KB、650 行，重建幾乎所有表（`CREATE`／`INSERT`／`DROP`／`ALTER`）

Naive `split(';')` 會把 `CASE ... END` 與字串／註解切錯。即使改抄 Wrangler splitter，遠端路徑仍把整段 SQL 丟給 D1 伺服器拆；部署服務應**模仿 Wrangler：一個 migration 一個 `/query` 請求**，不要在 client 自製不相容的拆檔邏輯。

`/query` 文件：[Query D1 Database](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)（多 statement 以分號連接，以 batch 執行）。Worker Binding 的 `batch()` 有「失敗則整批回滾」保證；**REST `/query` 是否同等原子，文件沒有寫死**。Wrangler 命令說明宣稱單一 migration 失敗會回滾，這必須在隔離帳戶用故意失敗的 statement 驗證。

### 4.3 限制與 `0044`

| 限制                        | 值               | 與本專案                                                    |
| --------------------------- | ---------------- | ----------------------------------------------------------- |
| 單一 SQL statement 長度     | 100 KB           | 個別 statement 遠小於上限；整檔 0044 約 31 KB               |
| `/query` 整批時限           | 30 秒            | 空白庫重播 47 個檔案應可接受；有資料的 0044 重建需實測      |
| Free：10 個 D1、每庫 500 MB | 安裝一個 DB 足夠 | 更新前用 Time Travel bookmark，不要把財務資料複製到部署服務 |

### 4.4 建議（在 live 原子性證明前）

**首選：** REST runner，行為對齊 Wrangler：

- 使用相同 `d1_migrations` schema 與檔名。
- 每次 POST 一個 migration 全文 + ledger `INSERT`。
- 先 `normalize` 換行為 LF。
- 失敗則**不要**寫 ledger（若 REST 已部分提交，用 Time Travel 回到該 migration 前的 bookmark）。
- 更新前呼叫 Time Travel 記錄 bookmark（Paid 30 天／Free 7 天）。[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

**若隔離帳戶證明 `/query` 非原子：** 改走 D1 `/import`（Wrangler 對 `--file` 宣稱失敗會回到原狀態），或維護者端受控 Wrangler runner。使用者仍只操作網頁，但要重評 runner 成本與 token 隔離。**在證明前不要把 REST runner 寫成已完成設計。**

同步中更新（暫停 Queue／Cron、等 in-flight job）屬第 4 階段；API 已有 Queue `delivery_paused`／pause-delivery。未實測前不得開放含 schema 變更的網頁更新。

---

## 5. 成本與額度

### 5.1 使用者目標帳戶（與現行 GitHub 部署相同）

| 產品         | Free                                                                   | 對本專案的意義                                                                                          |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Workers 請求 | 100,000／日                                                            | 靜態資產請求免費                                                                                        |
| CPU          | 10 ms／次                                                              | 銀行同步／Queue consumer 可能不夠；Paid 預設 30 s、可到 5 min                                           |
| Cron         | 5／帳戶                                                                | 本專案 1 條 `*/10`                                                                                      |
| D1           | 10 庫、500 MB、Time Travel 7 天                                        | 單一私人安裝足夠                                                                                        |
| Queues       | 帳戶最多 10,000 條；Free 保留 24 小時                                  | 一條 `taiwan-fin-hub-sync`                                                                              |
| Browser Run  | 10 分鐘／日                                                            | 玉山／國泰等連接器會共用；見 [Browser Run 定價](https://developers.cloudflare.com/browser-run/pricing/) |
| Workers AI   | 10,000 Neurons／日                                                     | 驗證碼辨識                                                                                              |
| Access       | 500 applications 等帳戶上限；Zero Trust Free 仍要在 Dashboard 走完開通 | 單一 workers.dev app + Email OTP                                                                        |
| 靜態資產     | 20,000 檔／版本、單檔 25 MiB                                           | 前端 dist 遠低於此                                                                                      |

產品文案維持：一般個人低頻可用 Free，額度用盡會暫停，不保證銀行同步在 Free CPU／Browser 限制內永遠成功。

### 5.2 維護者部署服務

| 資源                          | 用途                                 | 限制注意                                                                                          |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 部署 Worker（建議 Paid）      | OAuth、預檢、編排 Cloudflare API     | Free 每invocation 50 次 subrequest、10 ms CPU，不夠跑完整安裝；Paid 10,000 subrequest、可延長 CPU |
| 部署 D1                       | 安裝紀錄、工作 lease、加密 token TTL | 不存銀行明細                                                                                      |
| 部署 Queue                    | 每安裝一個 job、訊息只帶 job ID      | 15 分鐘 consumer wall time；大檔上傳需分步續跑                                                    |
| R2                            | 不可覆寫的版本產物                   | 維護者帳戶；不進使用者 OAuth                                                                      |
| Direct Upload JWT             | manifest／完成憑證各約 1 小時        | 安裝步驟必須在到期前完成或重新開 session                                                          |
| 工作 TTL 內的加密使用者 token | 呼叫目標帳戶 API                     | 完成／取消／過期後刪除並 revoke                                                                   |

部署服務故障不應影響已安裝的財務 Worker。不承諾部署服務永久免費；公開前需設併發安裝上限與去敏稽核。

---

## 6. 文件層的建議 API 順序

仍須隔離帳戶一次跑通。邏輯順序與計畫第 5 節一致：

1. OAuth → 列 memberships → 使用者選帳戶。
2. 預檢：subdomain、Zero Trust org、名稱衝突、方案／額度錯誤。
3. 建立 D1、Queue（先不要掛 consumer）。
4. 上傳 bootstrap Worker（拒絕財務路由；`DEMO_MODE`／`LOCAL_DEV_MODE` 關閉；`previews_enabled: false`）。
5. 啟用該 script 的 workers.dev。
6. 確保 OTP IdP；建立 `destinations: worker` Application + email allow policy；寫入 `TEAM_DOMAIN`、`POLICY_AUD`。
7. 套用 migrations（Wrangler 相容 ledger）；產生並寫入 `CONFIG_ENCRYPTION_KEY`、VAPID（secrets API 每次 PUT 都會開新版本，金鑰重試時不得輪替）。
8. Direct Upload 正式 assets + Worker；綁定 `DB`、`BROWSER`、`AI`、`ASSETS`、`SYNC_QUEUE`。
9. 掛 Queue consumer（`max_batch_size = 1`、`max_concurrency = 1`）與 Cron。
10. 用未授權／授權 Email 做真實登入檢查；清除短期憑證並 revoke。

Bindings 在 [Workers script update](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) 的 metadata 中型別為 `d1`、`queue`、`browser`、`ai`、`assets`、`secret_text`。

---

## 7. 隔離帳戶檢查清單（Ted）

請用**新的** Cloudflare 帳戶，不要用 Amy 正式 Worker。

1. 建立 private OAuth client，`GET /oauth/scopes`，把實際 ID 填回第 1.2 節表格。
2. 用第二個測試帳戶做 consent：確認多帳戶列表、拒掉 optional scope 的行為、revoke 後 API 錯誤。
3. 記錄 token JSON 的 `expires_in`／是否有 refresh token。
4. 空帳戶：`GET workers/subdomain`、`GET access/organizations`，記下哪些必須先點 Dashboard。
5. 建 D1，對 `packages/db/migrations` 做完整 REST 重播；另做一個中途 `SELECT 1/0` 的假 migration，確認是否回滾且 ledger 未寫入。
6. 對含 `CASE ... END` 與 `0044` 的檔案單獨跑 `/query`。
7. 部署最小 Worker，用 `destinations.type=worker` + OTP + 單一 email；確認未授權拒絕、preview URL 關閉。
8. 綁定 Browser／AI／Queue consumer／Cron，確認免費帳戶是否立即能用。

通過後才能開始第 1 階段版本產物；本階段不建立 `apps/deployer-*` workspace。

## 2026-09-18：隔離資源線上實測

使用者指定的帳戶已有 workers.dev、Zero Trust organization 及正式 Worker，因此這次是**同帳戶內的獨立測試資源**，不是全新空帳戶。不能由此次結果推論新帳戶不需要 onboarding。

透過 Cloudflare MCP 建立 `all-set-deploy-spike-20260918` 測試 D1、Queue、Worker 與 Access Application，沒有讀取既有金融資料。測試 Worker 只回傳固定文字與 HTTP 403，不含財務功能。

| 實測項目                  | 結果                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth scope 目錄          | `GET /oauth/scopes` 成功；確認下列確切 scope ID                                                                                                   |
| D1 migration 重播         | repo 現有 45 個檔案（0001 至 0047，編號有缺號）逐檔全文加 ledger INSERT，以 REST `/query` 全部成功，包含 0044／0045／0046 重建表                  |
| D1 DML 回滾               | 同一請求先 INSERT 再觸發 UNIQUE 錯誤；後續 SELECT 確認第一筆 INSERT 沒留下                                                                        |
| D1 DDL 回滾               | 同一請求先 CREATE TABLE 再寫入不存在表；sqlite_master 確認新表沒留下                                                                              |
| Worker bindings           | REST multipart 上傳成功，綁定測試 D1、Queue、Browser、AI；沒有啟動 Browser 或 AI 推論                                                             |
| Queue consumer            | REST 建立成功，batch_size=1、max_wait_time_ms=1000、max_concurrency=1                                                                             |
| Cron                      | 寫入測試 schedule、讀回成功後立即清空；未以 Cron 啟動任何金融同步                                                                                 |
| Access worker destination | 使用 Worker 上傳回應的 `tag` 作為 `worker_id` 建立成功（不是 script name）                                                                        |
| Access policy             | 沿用帳戶既有 OTP IdP，建立只允許使用者指定 Email 的專屬 policy；取得 aud，沒有修改共用 IdP／組織                                                  |
| 未登入請求                | workers.dev HTTP 302 指向該組織的 Access 登入頁；preview URLs 關閉                                                                                |
| OAuth client 建立         | MCP `POST /accounts/{account_id}/oauth_clients` 回傳 `10000 Authentication error`；目前連線憑證不足以完成此步，不能解讀為 Cloudflare 不支援 OAuth |

實際存在的 scope ID：

- `memberships.read`
- `workers-scripts.read`、`workers-scripts.write`
- `d1.read`、`d1.write`
- `queues.read`、`queues.write`
- `access.read`、`access.write`（account 範圍，不能改用 zone-access）
- `access-org.read`、`access-idp.read`、`access-idp.write`

以上是目錄確認，不代表這組 scope 已由第三方 OAuth consent 授權並實測可部署。沒有成功建立 OAuth client，也沒有取得或保存使用者 OAuth token。Dashboard 後備途徑目前停在使用者登入；需完成 client 設定後繼續測試 scope、token 壽命、撤銷與重新授權。

D1 測試使用空資料庫及合成 probe 資料，證明目前 API 的代表性失敗回滾與新裝重播可行；尚未證明有真實舊資料、同步寫入或中斷重送下的更新安全性。Access 已確認匿名攔截，允許使用者實際登入仍待使用者回報。版本 assets Direct Upload 尚未透過真實上傳完成 end-to-end。

測試資源的精確 ID 與清理進度記在本機忽略的 `.wrangler/browser-deployment-spike.json`；不將憑證存入該檔。測試用 Worker／Access 暫留供登入驗證，後續完成後清理；不建立背景自動清理或正式更新排程。

已完成的 D1／Queue／consumer 實測資源已刪除；測試 Worker 已移除這些 bindings 及排程，僅保留固定文字供 Access 登入驗證。原有 Worker、資料庫與排程未修改。

## 2026-09-19：純前端部署可行性補驗

首輪僅查官方文件、公開 OpenID 設定、OAuth API schema，以及執行 HTTP OPTIONS 與瀏覽器唯讀探測。後續由使用者在 Dashboard 完成獨立唯讀 OAuth client 建立與授權，真實結果見本節末尾；未建立 Worker／D1／Queue 或執行部署。

### OAuth 不必依賴 client secret

[現行官方文件](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/#choose-a-flow)明確支援瀏覽器 SPA 使用 Authorization Code + PKCE S256，`token_endpoint_auth_method: "none"`，不需要 client secret。Cloudflare MCP 的建立 client schema 也包含 `none` 與 `allowed_cors_origins`；線上 `https://dash.cloudflare.com/.well-known/openid-configuration` 同時列出 `none`、`S256`。

因此，第 1.1 節的「後端換 token」是原設計選擇，不是所有第三方 OAuth client 的必要限制。上述證據尚不代表已完成真實 consent／token 交換：本次 MCP 列出 OAuth clients 仍回 `10000 Authentication error`，未取得可供測試的 client 設定。

OpenID 設定的 authorization endpoint 為 `https://dash.cloudflare.com/oauth2/auth`；目前程式使用 `/oauth2/authorize`。兩者是否相容尚未實測，正式 OAuth 驗證前需核對，本次未修改程式。

### 瀏覽器直連管理 API 未通過 CORS

以 Playwright Chromium 從 `http://127.0.0.1:5173` 發出帶 `Authorization: Bearer invalid-cors-probe` 的 GET，測試 `/memberships` 與目前 MCP 帳戶的 `/workers/subdomain`。兩者均在 OPTIONS 預檢階段被瀏覽器阻擋，錯誤為缺少 `Access-Control-Allow-Origin`；JavaScript 得到 `TypeError: Failed to fetch`，實際 GET 未送出。

以 HTTP OPTIONS 再核對上述兩條路徑，Origin 分別使用本機來源與 `https://example.com`，均回 400、錯誤碼 9106，且沒有 CORS 允許標頭。瀏覽器預檢本來就不攜帶 Bearer token，所以不能透過換成有效 token 直接解決這次預檢失敗。

另以不存在的全零資源 ID，預檢 D1 建立／query、Queue、Access Application、Worker PUT、asset upload session 與 asset upload；皆未取得 CORS 允許標頭。這些是路徑探測，不能當成真實資源或上傳 session 的完整驗證。OAuth token OPTIONS 回 403、沒有 CORS 標頭，但未註冊測試 origin，不能據此否定官方的 SPA PKCE 支援。

尚未驗證將真實安裝網站加入 OAuth client 的 `allowed_cors_origins` 後，管理 API 是否改變 CORS 行為；不能將目前結果推廣為所有已註冊來源都不支援。

### 架構判斷與未完成項目

- **已確認：** OAuth 協議允許免 client secret；一般靜態網頁直接呼叫本次測試的管理 API 會被 CORS 預檢阻擋。
- **目前判斷：** 尚不能移除部署後端並承諾純前端可用。可以先評估受限的 API 轉接後端；CORS 結果本身不代表一定需要部署 D1、Queue 或完整工作編排。
- **版本來源：** 現行版本載入依賴 Worker 的 `RELEASE_BUCKET` binding，不能原封不動搬到瀏覽器。純前端方案需另外提供可讀取的 HTTP 版本產物，並保留 digest 驗證；本次未發布產物或開放 bucket。
- **完成檢查：** 現行 `readAnonymousUrl` 會讀取跨來源 redirect 的狀態與 Location；瀏覽器的 manual redirect 無法原樣提供這些資訊，亦需調整或留在後端。
- **仍待實測：** 合法 OAuth client 與允許來源的 consent／token、授權後的管理 API CORS、真實 Direct Upload、完整隔離安裝、重新整理及手機背景中斷後的恢復。這次沒有執行首次安裝或更新。

下一個決策點是先完成註冊 origin 的 OAuth＋管理 API 瀏覽器測試；若管理 API 仍阻擋跨來源，就保留受限後端，再依是否要求關閉分頁後繼續部署，決定工作持久化與 Queue 的必要範圍。

### 同日後續：已註冊來源與真實 PKCE 授權結果

使用者在先前隔離驗證的帳戶建立 private client `all-set-pkce-readonly-probe-20260919`，並親自完成 consent。設定如下：

- Response type：Code；grant：Authorization Code；認證方法：None (PKCE)。
- Callback：`http://localhost:5173/callback`；Allowed CORS Origins：`http://localhost:5173`。
- 僅 `memberships.read`、`workers-scripts.read`；未要求寫入、D1、Access 或 refresh token 權限。

本機靜態驗證頁直接從 Chrome 呼叫 Cloudflare，沒有 API proxy。state 驗證通過，`/oauth2/auth` 成功導向 consent；回到 callback 後，瀏覽器 POST `/oauth2/token` 回 **HTTP 200**，成功取得 access token，證實此註冊來源可使用免 client secret 的 PKCE。

接著以真實 token 呼叫 `https://api.cloudflare.com/client/v4/memberships`，仍失敗。Chrome DevTools Console 明確顯示 **OPTIONS 預檢缺少 Access-Control-Allow-Origin**，不是 API 回傳的權限不足。驗證頁顯示的「可讀帳戶數：0」是請求失敗後的預設顯示，不代表帳戶沒有 membership。因第一步失敗，後續 workers.dev 查詢未執行。

**更新結論：** 設定 OAuth client 的允許來源可讓 token 交換成功，但未解決本次管理 API 的 CORS。現有使用 Bearer header 直連管理 API 的純前端方案未通過驗證；下一步應評估受限 API 轉接後端。這個結果不要求一定採用 D1／Queue 工作編排，也不代表已測完所有端點或 HTTPS 正式來源。

測試 token 未顯示、未寫入 repo 或伺服器 log；驗證後已按頁面的「清除本頁憑證」，清除記憶體 token。**尚未撤銷 Cloudflare 端授權或刪除測試 client**，清除本機副本不等於撤銷。測試頁與無 request log 的本機 server 位於 Git 忽略目錄 `.wrangler/pkce-probe/`。

仍未完成：完整部署 scopes、API proxy、Direct Upload、隔離首次安裝／更新、Access 登入，以及手機背景中斷恢復。
