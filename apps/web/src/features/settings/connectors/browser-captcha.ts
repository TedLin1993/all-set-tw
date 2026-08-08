import { ApiRequestError } from "@/shared/api/client";

const INVALIDATED_CAPTCHA_SESSION_CODES = new Set([
  "USER_ACTION_REQUIRED",
  "TAISHIN_BROWSER_BUSY",
  "TAISHIN_CONNECTION_FAILED",
  "OBANK_CONNECTION_FAILED",
]);

export function browserCaptchaFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "驗證或同步失敗";
  const sessionInvalidated =
    error instanceof ApiRequestError &&
    INVALIDATED_CAPTCHA_SESSION_CODES.has(error.code);

  return {
    message: sessionInvalidated ? `${message} 請重新取得驗證碼。` : message,
    sessionInvalidated,
  };
}
