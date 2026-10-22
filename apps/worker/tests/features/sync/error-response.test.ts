import { describe, expect, it } from "vitest";
import type { SyncErrorCode } from "@taiwan-fin-hub/shared";
import {
  classifySyncError,
  syncFailureInput,
} from "../../../src/features/sync/error-response";
import {
  ManualCaptchaRequiredError,
  NeedsUserActionError,
  NextbankCaptchaRequiredError,
  SyncAlreadyRunningError,
} from "../../../src/features/sync/errors";
import { BrowserRunCapacityError } from "../../../src/sources/browser";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
  CathayVerificationRequiredError,
} from "../../../src/sources/cathaybk/connector";
import { CtbcVerificationRequiredError } from "../../../src/sources/ctbc/errors";
import {
  CtbcConnectionError,
  CtbcTwoStageRequiredError,
  CtbcVerificationExpiredError,
} from "../../../src/sources/ctbc/mobile-api";
import { EInvoiceProtocolUnavailableError } from "../../../src/sources/einvoice/api";
import {
  FeibBrowserCapacityError,
  FeibConnectionError,
  FeibSessionEndedError,
  FeibVerificationRequiredError,
} from "../../../src/sources/feib/connector";
import {
  FirstbankBrowserCapacityError,
  FirstbankConnectionError,
  FirstbankVerificationRequiredError,
} from "../../../src/sources/firstbank/connector";
import {
  FubonBrowserCapacityError,
  FubonConnectionError,
  FubonOtpInvalidError,
  FubonOtpRequiredError,
  FubonSessionEndedError,
  FubonVerificationRequiredError,
} from "../../../src/sources/fubon/connector";
import {
  HncbBrowserCapacityError,
  HncbConnectionError,
  HncbVerificationRequiredError,
} from "../../../src/sources/hncb/connector";
import {
  KgibankBrowserCapacityError,
  KgibankConnectionError,
  KgibankVerificationRequiredError,
} from "../../../src/sources/kgibank/connector";
import {
  MegabankConnectionError,
  MegabankOtpInvalidError,
  MegabankOtpRequiredError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
} from "../../../src/sources/megabank/mobile-api";
import {
  ObankConnectionError,
  ObankProtocolError,
  ObankVerificationRequiredError,
} from "../../../src/sources/obank/mobile-api";
import {
  RakutenBrowserCapacityError,
  RakutenConnectionError,
  RakutenVerificationRequiredError,
} from "../../../src/sources/rakuten/connector";
import { SinopacBrowserCapacityError } from "../../../src/sources/sinopac/connector";
import { SinopacVerificationRequiredError } from "../../../src/sources/sinopac/verification-error";
import { SkbankConnectionError } from "../../../src/sources/skbank/mobile-api";
import { SkbankProtocolError } from "../../../src/sources/skbank/protocol";
import {
  TaishinBrowserCapacityError,
  TaishinConnectionError,
  TaishinSyncStageError,
  TaishinVerificationRequiredError,
} from "../../../src/sources/taishin/connector";
import {
  TdccConnectionError,
  TdccOtpExpiredError,
  TdccVerificationRequiredError,
} from "../../../src/sources/tdcc/protocol";

type Expected = {
  status: number;
  code: SyncErrorCode;
  retryAfterSeconds?: number;
};

const device = {} as never;

// 前端依這些代碼接續 OTP、驗證碼與重試流程；分類分散在各來源錯誤類別，
// 這份對照確保 HTTP status、代碼與 Retry-After 不因重構而改變。
const cases: Array<[string, unknown, Expected]> = [
  [
    "sync already running",
    new SyncAlreadyRunningError("ctbc"),
    { status: 409, code: "SYNC_ALREADY_RUNNING" },
  ],
  ["unknown error", new Error("boom"), { status: 500, code: "SYNC_FAILED" }],
  ["non-error value", "boom", { status: 500, code: "SYNC_FAILED" }],
  [
    "bank verification",
    new SinopacVerificationRequiredError("x"),
    { status: 400, code: "USER_ACTION_REQUIRED" },
  ],
  [
    "tdcc otp expired",
    new TdccOtpExpiredError("x"),
    { status: 400, code: "USER_ACTION_REQUIRED" },
  ],
  [
    "needs user action",
    new NeedsUserActionError("x"),
    { status: 400, code: "USER_ACTION_REQUIRED" },
  ],
  [
    "manual captcha",
    new ManualCaptchaRequiredError("x"),
    { status: 400, code: "MANUAL_CAPTCHA_REQUIRED" },
  ],
  [
    "nextbank captcha",
    new NextbankCaptchaRequiredError("x"),
    { status: 400, code: "NEXTBANK_CAPTCHA_REQUIRED" },
  ],
  [
    "browser run capacity",
    new BrowserRunCapacityError("rate_limit", 20),
    { status: 429, code: "BROWSER_BUSY", retryAfterSeconds: 20 },
  ],
  [
    "einvoice protocol",
    new EInvoiceProtocolUnavailableError(),
    { status: 503, code: "CONNECTOR_PROTOCOL_UNAVAILABLE" },
  ],
  [
    "ctbc app approval",
    new CtbcTwoStageRequiredError("app"),
    { status: 400, code: "CTBC_APP_APPROVAL_REQUIRED" },
  ],
  [
    "ctbc email otp",
    new CtbcTwoStageRequiredError("email"),
    { status: 400, code: "CTBC_EMAIL_OTP_REQUIRED" },
  ],
  [
    "ctbc expired",
    new CtbcVerificationExpiredError(),
    { status: 400, code: "CTBC_VERIFICATION_EXPIRED" },
  ],
  [
    "ctbc verification",
    new CtbcVerificationRequiredError("x"),
    { status: 400, code: "USER_ACTION_REQUIRED" },
  ],
  [
    "ctbc connection",
    new CtbcConnectionError("x"),
    { status: 502, code: "CTBC_CONNECTION_FAILED" },
  ],
  [
    "cathay channel",
    new CathayOtpChannelRequiredError("x", "s", "t"),
    { status: 400, code: "CATHAY_OTP_CHANNEL_REQUIRED" },
  ],
  [
    "cathay sms otp",
    new CathayOtpRequiredError("x", "sms"),
    { status: 400, code: "CATHAY_SMS_OTP_REQUIRED" },
  ],
  [
    "cathay email otp",
    new CathayOtpRequiredError("x", "email"),
    { status: 400, code: "CATHAY_EMAIL_OTP_REQUIRED" },
  ],
  [
    "cathay session expired",
    new CathayOtpSessionExpiredError(),
    { status: 400, code: "CATHAY_OTP_SESSION_EXPIRED" },
  ],
  [
    "cathay otp invalid",
    new CathayOtpInvalidError(),
    { status: 400, code: "CATHAY_OTP_INVALID" },
  ],
  [
    "cathay verification",
    new CathayVerificationRequiredError("x"),
    { status: 400, code: "USER_ACTION_REQUIRED" },
  ],
  [
    "tdcc sms otp",
    new TdccVerificationRequiredError("sms", true),
    { status: 400, code: "TDCC_SMS_OTP_REQUIRED" },
  ],
  [
    "tdcc email otp",
    new TdccVerificationRequiredError("email", false),
    { status: 400, code: "TDCC_EMAIL_OTP_REQUIRED" },
  ],
  [
    "tdcc connection",
    new TdccConnectionError("E1", "x"),
    { status: 400, code: "TDCC_CONNECTION_FAILED" },
  ],
  [
    "megabank otp",
    new MegabankOtpRequiredError("x", "p", "t", device),
    { status: 400, code: "MEGABANK_SMS_OTP_REQUIRED" },
  ],
  [
    "megabank otp invalid",
    new MegabankOtpInvalidError("x", "p", "t", device),
    { status: 400, code: "MEGABANK_OTP_INVALID" },
  ],
  [
    "megabank connection",
    new MegabankConnectionError(),
    { status: 502, code: "MEGABANK_CONNECTION_FAILED" },
  ],
  [
    "megabank protocol",
    new MegabankProtocolError(),
    { status: 502, code: "MEGABANK_CONNECTION_FAILED" },
  ],
  [
    "fubon otp",
    new FubonOtpRequiredError("x", "s", "t"),
    { status: 400, code: "FUBON_OTP_REQUIRED" },
  ],
  [
    "fubon otp invalid",
    new FubonOtpInvalidError("x", "s", "t"),
    { status: 400, code: "FUBON_OTP_INVALID" },
  ],
  [
    "fubon connection",
    new FubonConnectionError("x"),
    { status: 502, code: "FUBON_CONNECTION_FAILED" },
  ],
  [
    "fubon session ended",
    new FubonSessionEndedError(),
    { status: 502, code: "FUBON_CONNECTION_FAILED" },
  ],
  [
    "fubon busy",
    new FubonBrowserCapacityError("x", 3),
    { status: 429, code: "FUBON_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "sinopac busy",
    new SinopacBrowserCapacityError("x"),
    { status: 429, code: "SINOPAC_BROWSER_BUSY", retryAfterSeconds: 20 },
  ],
  [
    "taishin busy",
    new TaishinBrowserCapacityError("x", 3),
    { status: 429, code: "TAISHIN_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "taishin connection",
    new TaishinConnectionError("x"),
    { status: 502, code: "TAISHIN_CONNECTION_FAILED" },
  ],
  [
    "taishin stage",
    new TaishinSyncStageError("login" as never, new Error("x")),
    { status: 502, code: "TAISHIN_CONNECTION_FAILED" },
  ],
  [
    "hncb busy",
    new HncbBrowserCapacityError("x", 3),
    { status: 429, code: "HNCB_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "hncb connection",
    new HncbConnectionError("x"),
    { status: 502, code: "HNCB_CONNECTION_FAILED" },
  ],
  [
    "obank connection",
    new ObankConnectionError("x"),
    { status: 502, code: "OBANK_CONNECTION_FAILED" },
  ],
  [
    "obank protocol",
    new ObankProtocolError("x"),
    { status: 502, code: "OBANK_CONNECTION_FAILED" },
  ],
  [
    "skbank connection",
    new SkbankConnectionError(),
    { status: 502, code: "SKBANK_CONNECTION_FAILED" },
  ],
  [
    "skbank protocol",
    new SkbankProtocolError(),
    { status: 502, code: "SKBANK_CONNECTION_FAILED" },
  ],
  [
    "rakuten busy",
    new RakutenBrowserCapacityError("x", 3),
    { status: 429, code: "RAKUTEN_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "rakuten connection",
    new RakutenConnectionError("x"),
    { status: 502, code: "RAKUTEN_CONNECTION_FAILED" },
  ],
  [
    "kgibank busy",
    new KgibankBrowserCapacityError("x", 3),
    { status: 429, code: "KGIBANK_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "kgibank connection",
    new KgibankConnectionError("x"),
    { status: 502, code: "KGIBANK_CONNECTION_FAILED" },
  ],
  [
    "firstbank busy",
    new FirstbankBrowserCapacityError("x", 3),
    { status: 429, code: "FIRSTBANK_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "firstbank connection",
    new FirstbankConnectionError("x"),
    { status: 502, code: "FIRSTBANK_CONNECTION_FAILED" },
  ],
  [
    "feib busy",
    new FeibBrowserCapacityError("x", 3),
    { status: 429, code: "FEIB_BROWSER_BUSY", retryAfterSeconds: 3 },
  ],
  [
    "feib connection",
    new FeibConnectionError("x"),
    { status: 502, code: "FEIB_CONNECTION_FAILED" },
  ],
  [
    "feib session ended",
    new FeibSessionEndedError(),
    { status: 502, code: "FEIB_CONNECTION_FAILED" },
  ],
];

describe("classifySyncError", () => {
  it.each(cases)("%s", (_label, error, expected) => {
    const { status, code, retryAfterSeconds } = classifySyncError(error);
    expect({ status, code, retryAfterSeconds }).toEqual(expected);
  });

  it("returns redacted messages for source errors", () => {
    expect(
      classifySyncError(
        new RakutenBrowserCapacityError(
          "樂天驗證碼正在產生中，請稍候再試。",
          3,
        ),
      ).message,
    ).toBe("樂天驗證碼正在產生中，請稍候再試。");
    expect(
      classifySyncError(
        new CtbcConnectionError("連線失敗 https://example.test/path?token=abc"),
      ).message,
    ).toBe("連線失敗 [URL]");
  });
});

// 同步結果狀態決定使用者是否需回來處理；needs_user_action 時保留 session 並提示接續。
const failureCases: Array<
  [string, unknown, "needs_user_action" | "failed", SyncErrorCode]
> = [
  [
    "needs user action",
    new NeedsUserActionError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "manual captcha",
    new ManualCaptchaRequiredError("x"),
    "needs_user_action",
    "MANUAL_CAPTCHA_REQUIRED",
  ],
  [
    "nextbank captcha",
    new NextbankCaptchaRequiredError("x"),
    "needs_user_action",
    "NEXTBANK_CAPTCHA_REQUIRED",
  ],
  [
    "ctbc verification",
    new CtbcVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "ctbc two stage",
    new CtbcTwoStageRequiredError("app"),
    "needs_user_action",
    "CTBC_APP_APPROVAL_REQUIRED",
  ],
  [
    "ctbc expired",
    new CtbcVerificationExpiredError(),
    "needs_user_action",
    "CTBC_VERIFICATION_EXPIRED",
  ],
  [
    "cathay verification",
    new CathayVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "cathay channel",
    new CathayOtpChannelRequiredError("x", "s", "t"),
    "needs_user_action",
    "CATHAY_OTP_CHANNEL_REQUIRED",
  ],
  [
    "cathay otp",
    new CathayOtpRequiredError("x", "sms"),
    "needs_user_action",
    "CATHAY_SMS_OTP_REQUIRED",
  ],
  [
    "cathay otp invalid",
    new CathayOtpInvalidError(),
    "needs_user_action",
    "CATHAY_OTP_INVALID",
  ],
  [
    "cathay session expired",
    new CathayOtpSessionExpiredError(),
    "needs_user_action",
    "CATHAY_OTP_SESSION_EXPIRED",
  ],
  [
    "tdcc verification",
    new TdccVerificationRequiredError("email", true),
    "needs_user_action",
    "TDCC_EMAIL_OTP_REQUIRED",
  ],
  [
    "tdcc otp expired",
    new TdccOtpExpiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "einvoice protocol",
    new EInvoiceProtocolUnavailableError(),
    "needs_user_action",
    "CONNECTOR_PROTOCOL_UNAVAILABLE",
  ],
  [
    "sinopac verification",
    new SinopacVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "taishin verification",
    new TaishinVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "hncb verification",
    new HncbVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "rakuten verification",
    new RakutenVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "kgibank verification",
    new KgibankVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "megabank verification",
    new MegabankVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "megabank otp",
    new MegabankOtpRequiredError("x", "p", "t", device),
    "needs_user_action",
    "MEGABANK_SMS_OTP_REQUIRED",
  ],
  [
    "fubon verification",
    new FubonVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "fubon otp invalid",
    new FubonOtpInvalidError("x", "s", "t"),
    "needs_user_action",
    "FUBON_OTP_INVALID",
  ],
  [
    "feib verification",
    new FeibVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "firstbank verification",
    new FirstbankVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "obank verification",
    new ObankVerificationRequiredError("x"),
    "needs_user_action",
    "USER_ACTION_REQUIRED",
  ],
  [
    "message fallback",
    new Error("OTP expired"),
    "needs_user_action",
    "SYNC_FAILED",
  ],
  [
    "source error message fallback",
    new CtbcConnectionError("requires user action"),
    "needs_user_action",
    "CTBC_CONNECTION_FAILED",
  ],
  [
    "browser run capacity",
    new BrowserRunCapacityError("daily_quota", 60),
    "failed",
    "BROWSER_BUSY",
  ],
  [
    "bank busy",
    new FubonBrowserCapacityError("x", 3),
    "failed",
    "FUBON_BROWSER_BUSY",
  ],
  [
    "connection",
    new TaishinConnectionError("x"),
    "failed",
    "TAISHIN_CONNECTION_FAILED",
  ],
  ["unknown", new Error("boom"), "failed", "SYNC_FAILED"],
];

describe("syncFailureInput", () => {
  it.each(failureCases)("%s", (_label, error, status, errorCode) => {
    expect(syncFailureInput(error)).toMatchObject({ status, errorCode });
  });

  it("forces failed status when requested", () => {
    expect(
      syncFailureInput(new NeedsUserActionError("x"), { forceFailed: true }),
    ).toMatchObject({ status: "failed", errorCode: "USER_ACTION_REQUIRED" });
  });
});
