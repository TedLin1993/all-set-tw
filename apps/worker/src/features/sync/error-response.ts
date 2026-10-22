import type { SyncErrorCode } from "@taiwan-fin-hub/shared";
import type { SyncFailureInput } from "../../db";
import { sourceSyncErrorOf } from "../../sources/sync-error";
import {
  isUserActionError,
  ManualCaptchaRequiredError,
  NeedsUserActionError,
  NextbankCaptchaRequiredError,
  safeErrorMessage,
  SyncAlreadyRunningError,
} from "./errors";

export type ClassifiedSyncError = {
  status: 400 | 409 | 429 | 500 | 502 | 503;
  code: SyncErrorCode;
  message: string;
  /** 只有瀏覽器容量不足等可稍後重試的錯誤才有值。 */
  retryAfterSeconds?: number;
};

/**
 * 同步錯誤對外的穩定代碼；HTTP 回應與背景執行記錄共用同一份對照。
 * 來源錯誤由各錯誤類別的 `toSyncError()` 自行宣告，這裡只處理同步流程本身的錯誤。
 */
export function classifySyncError(error: unknown): ClassifiedSyncError {
  const message = safeErrorMessage(error);
  if (error instanceof SyncAlreadyRunningError)
    return { status: 409, code: "SYNC_ALREADY_RUNNING", message };
  const sourceError = sourceSyncErrorOf(error);
  if (sourceError) {
    const { status, code, retryAfterSeconds } = sourceError;
    return { status, code, message, retryAfterSeconds };
  }
  if (error instanceof ManualCaptchaRequiredError)
    return { status: 400, code: "MANUAL_CAPTCHA_REQUIRED", message };
  if (error instanceof NextbankCaptchaRequiredError)
    return { status: 400, code: "NEXTBANK_CAPTCHA_REQUIRED", message };
  if (error instanceof NeedsUserActionError)
    return { status: 400, code: "USER_ACTION_REQUIRED", message };
  return { status: 500, code: "SYNC_FAILED", message };
}

/** 寫入 sync job 的失敗結果；錯誤代碼讓前端在背景同步結束後接續互動流程。 */
export function syncFailureInput(
  error: unknown,
  options: { forceFailed?: boolean } = {},
): SyncFailureInput {
  return {
    status:
      !options.forceFailed && isUserActionError(error)
        ? "needs_user_action"
        : "failed",
    errorMessage: safeErrorMessage(error),
    errorCode: classifySyncError(error).code,
  };
}
