# Codex → Cursor：Drizzle 3B 交接

日期：2026-09-12。

## 接續位置

- 請從目前本機分支 `codex/drizzle-stage-3b` 接續，先確認 `git status` 與 `git log -3 --oneline`。
- 正確基底是 `origin/cursor/drizzle-stage-3a-040a` 的 `40a208a`，包含 3A 的 `8bc1c1c` 及 factory 改名 `createDrizzle`。不要回到階段 1–2 分支重新實作。
- 本次交接隨 3B commit 提交；尚未 push 或建立 3B PR。PR 139 是階段 1–2 的歷史背景，不代表本次 3B 的遠端驗證結果。
- `.handoff/cursor-to-codex-drizzle.md` 是舊交接文件，內容停在階段 1–2；本文件為目前接續依據。

## 3B 已完成

- `classification/repository.ts` 改用 Drizzle，保留 row shape、NOCASE label 唯一性、priority／updated_at／id 排序、系統規則不可修改或刪除、affected rows 判斷與單一 batch 重排。
- Override 保留 target_type／target_id conflict target、既有 ID 與 created_at；大量 ID 仍以單一 JSON 陣列搭配 json_each 查詢。
- `packages/db/src/index.ts` 的 connector settings／cursor 改用 Drizzle。設定 upsert 保留既有 ID、created_at、sync_cursor；public config 與 cursor 更新不覆蓋其他設定。connectors repository 保留既有委派介面。
- 共用 `sanitizeDatabaseError` 移除 Drizzle error 的 SQL、綁定參數與 cause，用於 settings 存取、API 與通知 log 邊界，避免設定或 cursor 流入 log／同步錯誤紀錄。
- 補上分類與 settings 的隔離 D1 整合測試、API／通知錯誤遮罩測試；既有測試 mock 支援 Drizzle 使用的 raw()。
- 已更新 AGENTS.md、後端架構與 Drizzle 導入計畫。

## 驗證與範圍

- 本機型別檢查、完整後端測試已通過：Worker 527、DB 10、connector self-checks 及 deployment tests 16。
- 提交前依 AGENTS.md 再依序執行根目錄 format:check、typecheck、test:backend；查看提交任務最終結果確認本輪狀態。
- 未變更 schema、ID 格式、SQL migrations 或部署流程；未部署、未寫入遠端 D1，也未執行真實銀行同步。
- 原先接錯基底的完整工作區保留在 stash commit `b714f50babddf87feb62c2c355220bebccad38fc`。僅供回復，不要直接 apply：其中含舊基底的重複 3A 變更。

## 下一步：3C

1. 先讀 `docs/006-drizzle-adoption-plan.md` 與 `docs/002-backend-architecture.md`；沿用 `createDrizzle` 與現有 D1 測試 helper。
2. 從本分支接續 `invoices`、`investments`、`bank` 的一般列表／明細查詢；聚合與高風險同步仍依 3D、4 分階段處理。
3. 保留 API shape、排序／游標分頁、LEFT JOIN null、pending／posted、使用者偏好及日期字串邊界。保留 bank 既有 EXPLAIN QUERY PLAN 驗證，避免破壞 expression index。
4. 既有 batch 原子邊界不可改成逐一 await 或 Promise.all；必要複雜 SQL 可以保留。
5. 使用者已決定先完成 Drizzle 重構，再另做 schema migration；不要在 3C 順手修改 UUID／int、ID 前綴或 NOT NULL。
6. 每批完成更新導入計畫，依專案要求跑根目錄檢查，commit／PR 使用正體中文。需要發 PR 時再 push，勿把 3A 變更重複納入 3B diff。
