// 部署後舊 chunk 404：SPA 已開著時切換到新 lazy route 會撞到舊版 chunk URL，動態 import 失敗
// 顯示「頁面載入失敗」，使用者手動重新整理即可修好。這裡偵測「看起來是動態 import／chunk 載入
// 失敗」的錯誤，自動觸發一次 location.reload()，並用 sessionStorage 記錄時間避免重整迴圈
// （60 秒內已經自動重整過，就不再重整，改走既有的手動重試 UI）。

const STORAGE_KEY = "taiwan-fin-hub-chunk-reload-at";
const GUARD_WINDOW_MS = 60_000;

/**
 * 各瀏覽器對「動態 import 的模組載入失敗」的錯誤訊息措辭，以及 Vite 預先載入 lazy chunk
 * 的 CSS 失敗時丟出的錯誤（未取消 `vite:preloadError` 時會成為動態 import 的 rejection）。
 */
const CHUNK_ERROR_PATTERNS = [
  "failed to fetch dynamically imported module",
  "importing a module script failed",
  "error loading dynamically imported module",
  "unable to preload css",
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/** 是否看起來是動態 import／chunk 載入失敗。 */
function isChunkLoadError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return CHUNK_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function readLastReloadAt(): number {
  try {
    return Number(sessionStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastReloadAt(time: number): boolean {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(time));
    return true;
  } catch {
    // 無痕模式／儲存被封鎖：寫不進去就無法防迴圈，呼叫端改走手動重試。
    return false;
  }
}

/**
 * 偵測到 chunk 載入失敗時觸發「唯一一次」的自動重新整理；60 秒內已經自動重整過就不再重整
 * （回傳 false，呼叫端應顯示既有的手動重試 UI，避免真的壞掉時無限重整迴圈）。
 * 無法記錄重整時間（sessionStorage 不可用）時同樣不自動重整，因為無法防迴圈。
 * @returns 是否已觸發自動重新整理。
 */
export function recoverFromChunkLoadError(error: unknown): boolean {
  if (!isChunkLoadError(error)) return false;
  const now = Date.now();
  const lastReloadAt = readLastReloadAt();
  if (lastReloadAt > 0 && now - lastReloadAt < GUARD_WINDOW_MS) return false;
  if (!writeLastReloadAt(now)) return false;
  window.location.reload();
  return true;
}
