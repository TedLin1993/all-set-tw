export type ApiErrorBody = {
  success: false;
  error: { code: string; message: string };
};

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

let csrfToken = "";

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export function createApiClient() {
  async function request<T>(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (csrfToken && !headers.has("X-CSRF-Token")) {
      headers.set("X-CSRF-Token", csrfToken);
    }
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
    const text = await response.text();
    let data: T | ApiErrorBody;
    try {
      data = JSON.parse(text) as T | ApiErrorBody;
    } catch {
      throw new Error(
        response.ok
          ? "伺服器回應格式錯誤。"
          : `伺服器暫時無法完成請求（HTTP ${response.status}）。`,
      );
    }
    if (!response.ok) {
      const error =
        typeof data === "object" && data && "error" in data
          ? data.error
          : { code: "REQUEST_FAILED", message: "請求失敗。" };
      throw new ApiRequestError(error.code, error.message, response.status);
    }
    return data as T;
  }

  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}
