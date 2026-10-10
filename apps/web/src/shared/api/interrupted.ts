import { ApiRequestError } from "./client";

/**
 * 請求在送達或回應途中被中斷（例如 iPhone 鎖定畫面時 Safari 回報 "Load failed"），
 * 而不是伺服器回覆錯誤。這種情況下伺服器端的工作可能仍在進行或已完成。
 */
export function isRequestInterrupted(errorValue: unknown) {
  if (errorValue instanceof ApiRequestError) return false;
  return (
    errorValue instanceof TypeError ||
    (errorValue instanceof Error &&
      /load failed|failed to fetch|networkerror|network connection was lost|network request failed/i.test(
        errorValue.message,
      ))
  );
}
