import type { SyncErrorCode } from "@taiwan-fin-hub/shared";

/** 來源錯誤對外的 HTTP status 與穩定錯誤代碼。 */
export type SourceSyncError = {
  status: 400 | 429 | 500 | 502 | 503;
  code: SyncErrorCode;
  /** 只有瀏覽器容量不足等可稍後重試的錯誤才有值。 */
  retryAfterSeconds?: number;
  /**
   * 同步結果是否標記為 `needs_user_action`；未宣告時由
   * `isUserActionError` 依錯誤訊息判斷。
   */
  needsUserAction?: boolean;
};

/**
 * 需要穩定錯誤代碼的來源錯誤類別實作此介面，自行宣告分類；
 * 子類別未覆寫時沿用父類別的分類。未實作的錯誤一律視為 `SYNC_FAILED`。
 */
export interface SourceSyncErrorSource {
  toSyncError(): SourceSyncError;
}

export function sourceSyncErrorOf(error: unknown): SourceSyncError | undefined {
  if (
    error instanceof Error &&
    "toSyncError" in error &&
    typeof error.toSyncError === "function"
  )
    return (error as Error & SourceSyncErrorSource).toSyncError();
  return undefined;
}
