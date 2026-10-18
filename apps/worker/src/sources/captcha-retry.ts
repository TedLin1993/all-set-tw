/** 自動辨識時每次同步最多辨識的新驗證碼張數（含格式不符而未送出的張數）。 */
export const AUTO_CAPTCHA_MAX_RECOGNITIONS = 6;
/** 自動辨識時每次同步最多向銀行送出的登入請求數。 */
export const AUTO_CAPTCHA_MAX_LOGIN_REQUESTS = 3;

/** 辨識結果不符驗證碼格式，尚未送出登入；只扣辨識額度，不扣登入額度。 */
export class CaptchaUnreadableError extends Error {
  constructor() {
    super("驗證碼辨識結果不符格式。");
    this.name = "CaptchaUnreadableError";
  }
}

export type AutoCaptchaAttemptOptions = {
  connectorId: string;
  /** 使用者看得懂的來源名稱，用於額度耗盡的提示。 */
  connectorName: string;
  /** 已送出登入且銀行明確回覆驗證碼錯誤時回 true。 */
  isCaptchaRejected: (error: unknown) => boolean;
  /** 包裝額度耗盡提示，讓來源回報為需要使用者處理的錯誤。 */
  exhausted: (message: string) => Error;
};

/**
 * 自動辨識驗證碼的共用重試政策：每一輪由 attemptOnce 取得新驗證碼、辨識並登入。
 * 辨識格式不符時應拋出 CaptchaUnreadableError（不送出登入、不扣登入額度）；
 * 帳密遭拒、登入結果不明或辨識服務不可用一律原樣拋出，不重送帳密。
 * 人工輸入的驗證碼只能使用一次，不得經過此重試。
 */
export async function runAutoCaptchaAttempts<T>(
  attemptOnce: () => Promise<T>,
  options: AutoCaptchaAttemptOptions,
): Promise<T> {
  let recognitions = 0;
  let loginRequests = 0;
  while (
    recognitions < AUTO_CAPTCHA_MAX_RECOGNITIONS &&
    loginRequests < AUTO_CAPTCHA_MAX_LOGIN_REQUESTS
  ) {
    recognitions += 1;
    let outcome: "unreadable" | "rejected";
    try {
      return await attemptOnce();
    } catch (error) {
      if (error instanceof CaptchaUnreadableError) {
        outcome = "unreadable";
      } else if (options.isCaptchaRejected(error)) {
        outcome = "rejected";
        loginRequests += 1;
      } else {
        throw error;
      }
    }
    console.warn(
      JSON.stringify({
        event: "auto_captcha_retry",
        connectorId: options.connectorId,
        outcome,
        recognitions,
        loginRequests,
      }),
    );
  }
  throw options.exhausted(
    loginRequests >= AUTO_CAPTCHA_MAX_LOGIN_REQUESTS
      ? `${options.connectorName}自動登入已送出 ${loginRequests} 次，驗證碼仍遭拒絕，請改用人工驗證。`
      : `${options.connectorName}驗證碼辨識已達 ${recognitions} 次上限（登入已送出 ${loginRequests} 次），請改用人工驗證。`,
  );
}
