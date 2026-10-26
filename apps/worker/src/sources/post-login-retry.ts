/** 登入後同一步驟最多執行次數（含首次）。 */
export const POST_LOGIN_STEP_ATTEMPTS = 2;

const TRANSIENT_NETWORK_ERROR =
  /net::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|ABORTED|FAILED)/;

/**
 * 頁面沒有在期限內載入完成或暫時性網路錯誤。分頁或 session 已關閉時重跑無效，
 * 不屬於此類。
 */
export function isTransientPageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error.name === "TimeoutError" ||
    TRANSIENT_NETWORK_ERROR.test(error.message)
  )
    return true;
  return error.cause !== undefined && error.cause !== error
    ? isTransientPageError(error.cause)
    : false;
}

export type PostLoginStepOptions = {
  connectorId: string;
  /** 診斷用的步驟名稱，不得包含帳號或其他個資。 */
  step: string;
  /** 預設只重試 isTransientPageError。 */
  isRetryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
};

/**
 * 登入後頁面步驟的共用重試政策：沿用同一個已登入的工作階段，暫時性載入錯誤時
 * 重跑整個步驟一次，不重新登入、不重送帳密。step 必須可重入：每次從導覽或重新
 * 開啟功能頁開始，且只回傳本次執行收集的資料，不得把前一次的部分結果帶入。
 */
export async function retryPostLoginStep<T>(
  options: PostLoginStepOptions,
  step: (attempt: number) => Promise<T>,
): Promise<T> {
  const isRetryable = options.isRetryable ?? isTransientPageError;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await step(attempt);
    } catch (error) {
      if (
        attempt >= POST_LOGIN_STEP_ATTEMPTS ||
        options.signal?.aborted ||
        !isRetryable(error)
      ) {
        throw error;
      }
      console.warn(
        JSON.stringify({
          event: "post_login_step_retry",
          connectorId: options.connectorId,
          step: options.step,
          attempt,
          errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        }),
      );
    }
  }
}
