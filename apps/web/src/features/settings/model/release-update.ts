/**
 * 「更新紀錄」的更新入口。重新部署即可更新的部署（`__BUILD_INFO__.updateMethod` 為
 * cloudflare）開啟 Cloudflare 主控台，由使用者在 build 紀錄點 Retry build；Worker
 * 沒有啟動 build 的權限，無法直接在網站內更新。與 docs/005-deployment.md「版本更新」一致。
 * :account 由主控台帶入目前帳號，多帳號時先選擇。
 */
const WORKERS_LIST_URL =
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/** workers.dev 網址的第一段即 Worker 名稱；自訂網域無法得知名稱，改開 Workers 列表。 */
export function cloudflareUpdateUrl(hostname: string): string {
  const worker = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(
    hostname,
  )?.[1];
  return worker
    ? `https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker}/production/deployments`
    : WORKERS_LIST_URL;
}
