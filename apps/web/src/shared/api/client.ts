import type { ApiErrorCode, ApiErrorResponse } from "@taiwan-fin-hub/shared";

/** Worker 回傳的錯誤代碼，加上前端在回應不是 API 錯誤格式時使用的 `REQUEST_FAILED`。 */
export type ApiRequestErrorCode = ApiErrorCode | "REQUEST_FAILED";

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  /** 依 keyset 分頁標頭（`X-Has-More`、`X-Next-Cursor`）取完所有頁並合併。 */
  getAllPages<T>(path: string): Promise<T[]>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
}

function isApiError(value: unknown): value is ApiErrorResponse {
  return typeof value === "object" && value !== null && "error" in value;
}

export class ApiRequestError extends Error {
  constructor(
    public readonly code: ApiRequestErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

// 分頁上限，避免伺服器回傳異常游標時無限迴圈。
const MAX_PAGES = 100;

export function createApiClient(): ApiClient {
  async function request<T>(path: string, init: RequestInit = {}) {
    return (await requestWithHeaders<T>(path, init)).data;
  }

  async function requestWithHeaders<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ data: T; headers: Headers }> {
    const headers =
      init.body === undefined
        ? init.headers
        : { "Content-Type": "application/json", ...init.headers };
    const response = await fetch(path, { ...init, headers });
    const text = await response.text();
    let data: T | ApiErrorResponse;
    try {
      data = JSON.parse(text) as T | ApiErrorResponse;
    } catch {
      throw new Error(
        response.ok
          ? "伺服器回應格式錯誤。"
          : `伺服器暫時無法完成請求（HTTP ${response.status}）。`,
      );
    }
    if (!response.ok) {
      const error: { code: ApiRequestErrorCode; message: string } = isApiError(
        data,
      )
        ? data.error
        : { code: "REQUEST_FAILED", message: "請求失敗。" };
      throw new ApiRequestError(error.code, error.message, response.status);
    }
    return { data: data as T, headers: response.headers };
  }

  async function getAllPages<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const target: string = cursor
        ? `${path}${separator}cursor=${encodeURIComponent(cursor)}`
        : path;
      const { data, headers } = await requestWithHeaders<T[]>(target);
      rows.push(...data);
      cursor = headers.get("X-Next-Cursor");
      if (headers.get("X-Has-More") !== "true" || !cursor) return rows;
    }
    throw new Error("資料分頁過多，無法完整載入。");
  }

  return {
    get: (path) => request(path),
    getAllPages,
    post: (path, body) =>
      request(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    put: (path, body) =>
      request(path, { method: "PUT", body: JSON.stringify(body) }),
    patch: (path, body) =>
      request(path, { method: "PATCH", body: JSON.stringify(body) }),
    delete: (path) => request(path, { method: "DELETE" }),
  };
}

export function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "請求失敗。";
}
