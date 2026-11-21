// :account 由 Cloudflare 主控台帶入，多帳號時會先選擇帳號。
const DASHBOARD = "https://dash.cloudflare.com/?to=/:account";
const BUILD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function cloudflareUpdateTarget(
  hostname: string,
  {
    builtAt,
    cloudflareBuildId,
    cloudflareWorkerName,
  }: Pick<
    typeof __BUILD_INFO__,
    "builtAt" | "cloudflareBuildId" | "cloudflareWorkerName"
  >,
  now = Date.now(),
) {
  const worker =
    cloudflareWorkerName ||
    /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/i.exec(hostname)?.[1];
  if (!worker)
    return { page: "workers", url: `${DASHBOARD}/workers-and-pages` };

  const history = `${DASHBOARD}/workers/services/view/${encodeURIComponent(worker)}/production/builds`;
  if (cloudflareBuildId && now < Date.parse(builtAt) + BUILD_RETENTION_MS) {
    return {
      page: "details",
      url: `${history}/${encodeURIComponent(cloudflareBuildId)}`,
    };
  }
  return { page: "history", url: history };
}
