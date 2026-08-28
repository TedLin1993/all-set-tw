import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/shared/api/client";
import { browserCaptchaFailure } from "./browser-captcha";

describe("browserCaptchaFailure", () => {
  it("invalidates a CAPTCHA image after the server closes its browser session", () => {
    expect(
      browserCaptchaFailure(
        new ApiRequestError("USER_ACTION_REQUIRED", "圖形驗證碼錯誤。", 400),
      ),
    ).toEqual({
      message: "圖形驗證碼錯誤。 請重新取得驗證碼。",
      sessionInvalidated: true,
    });
  });

  it("keeps the current image for local validation errors", () => {
    expect(browserCaptchaFailure(new Error("請輸入 6 位數字驗證碼。"))).toEqual(
      {
        message: "請輸入 6 位數字驗證碼。",
        sessionInvalidated: false,
      },
    );
  });

  it("clears a rejected O-Bank API CAPTCHA session", () => {
    expect(
      browserCaptchaFailure(
        new ApiRequestError(
          "OBANK_CONNECTION_FAILED",
          "王道銀行服務回應格式已變更。",
          502,
        ),
      ),
    ).toEqual({
      message: "王道銀行服務回應格式已變更。 請重新取得驗證碼。",
      sessionInvalidated: true,
    });
  });

  it("invalidates a First Bank CAPTCHA session after a browser failure", () => {
    const message = "第一銀行瀏覽器工作階段已失效。";
    expect(
      browserCaptchaFailure(
        new ApiRequestError("FIRSTBANK_CONNECTION_FAILED", message, 502),
      ),
    ).toEqual({
      message: `${message} 請重新取得驗證碼。`,
      sessionInvalidated: true,
    });
  });
});
