import { ApiRequestError, type ApiRequestErrorCode } from "@/shared/api/client";

const INVALIDATED_CAPTCHA_SESSION_CODES = new Set<ApiRequestErrorCode>([
  "USER_ACTION_REQUIRED",
  "TAISHIN_BROWSER_BUSY",
  "TAISHIN_CONNECTION_FAILED",
  "OBANK_CONNECTION_FAILED",
  "FIRSTBANK_BROWSER_BUSY",
  "FIRSTBANK_CONNECTION_FAILED",
  "MEGABANK_CONNECTION_FAILED",
]);

/** 伺服器判定自動辨識驗證碼失敗，應改走人工驗證碼流程。 */
export function isManualCaptchaRequired(error: unknown) {
  return (
    error instanceof ApiRequestError && error.code === "MANUAL_CAPTCHA_REQUIRED"
  );
}

export function captchaBankFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "驗證或同步失敗";
  const sessionInvalidated =
    error instanceof ApiRequestError &&
    INVALIDATED_CAPTCHA_SESSION_CODES.has(error.code) &&
    !(
      error.code === "FIRSTBANK_CONNECTION_FAILED" && /格式已變更/.test(message)
    );

  return {
    message: sessionInvalidated ? `${message} 請重新取得驗證碼。` : message,
    sessionInvalidated,
  };
}

export function needsNextbankCaptcha(connectorId: string, error: unknown) {
  return (
    connectorId === "nextbank" &&
    error instanceof ApiRequestError &&
    error.code === "NEXTBANK_CAPTCHA_REQUIRED"
  );
}

/** 兆豐登入成功後，銀行要求輸入簡訊驗證碼；伺服器暫時保留已登入的工作階段。 */
export function isMegabankOtpRequired(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    error.code === "MEGABANK_SMS_OTP_REQUIRED"
  );
}

/**
 * 兆豐簡訊驗證碼送出後失敗時的下一步：驗證碼本身錯誤可原地重新輸入，
 * 其餘情況（工作階段逾時、連線失敗、同步中等）一律回到初始狀態重新取得驗證碼。
 */
export function megabankOtpFailure(error: unknown): "retry" | "reset" {
  return error instanceof ApiRequestError &&
    error.code === "MEGABANK_OTP_INVALID"
    ? "retry"
    : "reset";
}
