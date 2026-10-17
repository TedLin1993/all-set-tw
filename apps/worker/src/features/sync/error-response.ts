import type { SyncErrorCode } from "@taiwan-fin-hub/shared";
import {
  CtbcConnectionError,
  CtbcTwoStageRequiredError,
  CtbcVerificationExpiredError,
  CtbcVerificationRequiredError,
} from "../../sources/ctbc/mobile-api";
import { EInvoiceProtocolUnavailableError } from "../../sources/einvoice/api";
import {
  ObankConnectionError,
  ObankProtocolError,
} from "../../sources/obank/mobile-api";
import { SkbankConnectionError } from "../../sources/skbank/mobile-api";
import { SkbankProtocolError } from "../../sources/skbank/protocol";
import {
  TdccConnectionError,
  TdccVerificationRequiredError,
} from "../../sources/tdcc/protocol";
import {
  MegabankConnectionError,
  MegabankOtpInvalidError,
  MegabankOtpRequiredError,
  MegabankProtocolError,
} from "../../sources/megabank/mobile-api";
import { BrowserRunCapacityError } from "../../sources/browser";
import {
  FirstbankBrowserCapacityError,
  FirstbankConnectionError,
} from "../../sources/firstbank/connector";
import {
  HncbBrowserCapacityError,
  HncbConnectionError,
} from "../../sources/hncb/connector";
import {
  FubonBrowserCapacityError,
  FubonConnectionError,
  FubonOtpInvalidError,
  FubonOtpRequiredError,
} from "../../sources/fubon/connector";
import {
  FeibBrowserCapacityError,
  FeibConnectionError,
} from "../../sources/feib/connector";
import {
  KgibankBrowserCapacityError,
  KgibankConnectionError,
} from "../../sources/kgibank/connector";
import {
  RakutenBrowserCapacityError,
  RakutenConnectionError,
} from "../../sources/rakuten/connector";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
  CathayVerificationRequiredError,
} from "../../sources/cathaybk/connector";
import { SinopacBrowserCapacityError } from "../../sources/sinopac/connector";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
} from "../../sources/taishin/connector";
import type { SyncFailureInput } from "../../db";
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

/** 同步錯誤對外的穩定代碼；HTTP 回應與背景執行記錄共用同一份對照。 */
export function classifySyncError(error: unknown): ClassifiedSyncError {
  const fail = (
    status: ClassifiedSyncError["status"],
    code: SyncErrorCode,
    message = safeErrorMessage(error),
  ): ClassifiedSyncError => ({ status, code, message });
  const busy = (
    code: SyncErrorCode,
    retryAfterSeconds: number,
    message = safeErrorMessage(error),
  ): ClassifiedSyncError => ({ status: 429, code, message, retryAfterSeconds });

  if (error instanceof SyncAlreadyRunningError)
    return fail(409, "SYNC_ALREADY_RUNNING");
  if (error instanceof CtbcTwoStageRequiredError)
    return fail(
      400,
      error.method === "app"
        ? "CTBC_APP_APPROVAL_REQUIRED"
        : "CTBC_EMAIL_OTP_REQUIRED",
    );
  if (error instanceof CtbcVerificationExpiredError)
    return fail(400, "CTBC_VERIFICATION_EXPIRED");
  if (error instanceof BrowserRunCapacityError)
    return busy("BROWSER_BUSY", error.retryAfterSeconds);
  if (error instanceof CathayOtpChannelRequiredError)
    return fail(400, "CATHAY_OTP_CHANNEL_REQUIRED");
  if (error instanceof CathayOtpRequiredError)
    return fail(
      400,
      error.channel === "sms"
        ? "CATHAY_SMS_OTP_REQUIRED"
        : "CATHAY_EMAIL_OTP_REQUIRED",
    );
  if (error instanceof CathayOtpSessionExpiredError)
    return fail(400, "CATHAY_OTP_SESSION_EXPIRED");
  if (error instanceof CathayOtpInvalidError)
    return fail(400, "CATHAY_OTP_INVALID");
  if (error instanceof CathayVerificationRequiredError)
    return fail(400, "USER_ACTION_REQUIRED");
  if (error instanceof TdccVerificationRequiredError)
    return fail(
      400,
      error.channel === "sms"
        ? "TDCC_SMS_OTP_REQUIRED"
        : "TDCC_EMAIL_OTP_REQUIRED",
    );
  if (error instanceof TdccConnectionError)
    return fail(400, "TDCC_CONNECTION_FAILED");
  if (error instanceof ManualCaptchaRequiredError)
    return fail(400, "MANUAL_CAPTCHA_REQUIRED");
  if (error instanceof NextbankCaptchaRequiredError)
    return fail(400, "NEXTBANK_CAPTCHA_REQUIRED");
  if (error instanceof MegabankOtpRequiredError)
    return fail(400, "MEGABANK_SMS_OTP_REQUIRED");
  if (error instanceof MegabankOtpInvalidError)
    return fail(400, "MEGABANK_OTP_INVALID");
  if (error instanceof FubonOtpRequiredError)
    return fail(400, "FUBON_OTP_REQUIRED");
  if (error instanceof FubonOtpInvalidError)
    return fail(400, "FUBON_OTP_INVALID");
  if (
    error instanceof NeedsUserActionError ||
    error instanceof CtbcVerificationRequiredError
  )
    return fail(400, "USER_ACTION_REQUIRED");
  if (error instanceof EInvoiceProtocolUnavailableError)
    return fail(503, "CONNECTOR_PROTOCOL_UNAVAILABLE");
  if (error instanceof SinopacBrowserCapacityError)
    return busy("SINOPAC_BROWSER_BUSY", error.retryAfterSeconds);
  if (error instanceof TaishinBrowserCapacityError)
    return busy("TAISHIN_BROWSER_BUSY", error.retryAfterSeconds);
  if (error instanceof CtbcConnectionError)
    return fail(502, "CTBC_CONNECTION_FAILED");
  if (
    error instanceof SkbankConnectionError ||
    error instanceof SkbankProtocolError
  )
    return fail(502, "SKBANK_CONNECTION_FAILED");
  if (error instanceof TaishinConnectionError)
    return fail(502, "TAISHIN_CONNECTION_FAILED");
  if (error instanceof HncbBrowserCapacityError)
    return busy("HNCB_BROWSER_BUSY", error.retryAfterSeconds);
  if (error instanceof HncbConnectionError)
    return fail(502, "HNCB_CONNECTION_FAILED");
  if (
    error instanceof ObankConnectionError ||
    error instanceof ObankProtocolError
  )
    return fail(502, "OBANK_CONNECTION_FAILED");
  if (error instanceof RakutenBrowserCapacityError)
    return busy("RAKUTEN_BROWSER_BUSY", error.retryAfterSeconds, error.message);
  if (error instanceof RakutenConnectionError)
    return fail(502, "RAKUTEN_CONNECTION_FAILED");
  if (error instanceof KgibankBrowserCapacityError)
    return busy("KGIBANK_BROWSER_BUSY", error.retryAfterSeconds, error.message);
  if (error instanceof KgibankConnectionError)
    return fail(502, "KGIBANK_CONNECTION_FAILED");
  if (error instanceof FirstbankBrowserCapacityError)
    return busy(
      "FIRSTBANK_BROWSER_BUSY",
      error.retryAfterSeconds,
      error.message,
    );
  if (error instanceof FirstbankConnectionError)
    return fail(502, "FIRSTBANK_CONNECTION_FAILED");
  if (
    error instanceof MegabankConnectionError ||
    error instanceof MegabankProtocolError
  )
    return fail(502, "MEGABANK_CONNECTION_FAILED");
  if (error instanceof FubonBrowserCapacityError)
    return busy("FUBON_BROWSER_BUSY", error.retryAfterSeconds, error.message);
  if (error instanceof FubonConnectionError)
    return fail(502, "FUBON_CONNECTION_FAILED");
  if (error instanceof FeibBrowserCapacityError)
    return busy("FEIB_BROWSER_BUSY", error.retryAfterSeconds, error.message);
  if (error instanceof FeibConnectionError)
    return fail(502, "FEIB_CONNECTION_FAILED");
  return fail(500, "SYNC_FAILED");
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
