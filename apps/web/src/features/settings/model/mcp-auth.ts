import { queryOptions } from "@tanstack/svelte-query";
import { queryKeys } from "@/shared/api/query-keys";

export type McpAuthStatus =
  | { kind: "ready" }
  | { kind: "not_enabled" }
  | { kind: "not_protected" }
  | { kind: "local" }
  | { kind: "unknown"; detail: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isWorkerUnauthorized(body: unknown) {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "code" in body.error &&
    body.error.code === "UNAUTHORIZED"
  );
}

/**
 * 以尚未登入的 AI 助理身分呼叫 MCP 端點，判斷 Cloudflare Access 是否已開啟 Managed OAuth。
 * 判斷方式與 docs/006-mcp.md 的 curl 檢查相同：開啟時 Access 回 401，未開啟時轉址到登入頁。
 */
export async function probeMcpAuth(
  endpoint: string,
  hostname: string,
  signal?: AbortSignal,
): Promise<McpAuthStatus> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      // 不帶 Access cookie，Access 才會用對待 AI 助理的方式回應。
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      headers: { accept: "application/json, text/event-stream" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unknown", detail: "無法連線到 MCP 端點" };
  }

  // 轉址到 Access 登入頁時，manual 模式只會拿到不透明的 opaqueredirect。
  if (response.type === "opaqueredirect") return { kind: "not_enabled" };
  if (response.status === 401) {
    // Worker 自己回的 401 代表請求沒有先經過 Access。
    const body: unknown = await response.json().catch(() => null);
    return isWorkerUnauthorized(body)
      ? { kind: "not_protected" }
      : { kind: "ready" };
  }
  // 本機開發略過 Access，請求會直接到 MCP handler。
  if (LOCAL_HOSTS.has(hostname)) return { kind: "local" };
  return { kind: "unknown", detail: `HTTP ${response.status}` };
}

export const mcpAuthStatusQuery = (
  endpoint: string,
  hostname: string,
  enabled: boolean,
) =>
  queryOptions({
    queryKey: queryKeys.mcpAuthStatus,
    queryFn: ({ signal }) => probeMcpAuth(endpoint, hostname, signal),
    // 使用者常在另一個分頁改完 Access 設定再回來，回到頁面時重新檢查。
    staleTime: 0,
    refetchOnWindowFocus: true,
    enabled,
  });
