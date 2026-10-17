import { ApiRequestError, type ApiRequestErrorCode } from "@/shared/api/client";

const INVALIDATED_CAPTCHA_SESSION_CODES = new Set<ApiRequestErrorCode>([
  "USER_ACTION_REQUIRED",
  "TAISHIN_BROWSER_BUSY",
  "TAISHIN_CONNECTION_FAILED",
  "OBANK_CONNECTION_FAILED",
  "FIRSTBANK_BROWSER_BUSY",
  "FIRSTBANK_CONNECTION_FAILED",
  "MEGABANK_CONNECTION_FAILED",
  "FUBON_BROWSER_BUSY",
  "FUBON_CONNECTION_FAILED",
  "FEIB_BROWSER_BUSY",
  "FEIB_CONNECTION_FAILED",
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

/**
 * 需要輸入登入後 OTP 的銀行，伺服器暫時保留已登入或待驗證的工作階段：
 * 兆豐（異地簡訊）、台北富邦（雙重驗證簡訊／Email）。
 */
export function isBankOtpRequired(connectorId: string, error: unknown) {
  if (!(error instanceof ApiRequestError)) return false;
  if (connectorId === "megabank")
    return error.code === "MEGABANK_SMS_OTP_REQUIRED";
  if (connectorId === "fubon") return error.code === "FUBON_OTP_REQUIRED";
  return false;
}

/**
 * 兆豐／台北富邦驗證碼送出後失敗時的下一步：驗證碼本身錯誤可原地重新輸入，
 * 其餘情況（工作階段逾時、連線失敗、同步中等）一律回到初始狀態重新取得驗證碼。
 */
export function megabankOtpFailure(error: unknown): "retry" | "reset" {
  return error instanceof ApiRequestError &&
    (error.code === "MEGABANK_OTP_INVALID" ||
      error.code === "FUBON_OTP_INVALID")
    ? "retry"
    : "reset";
}
