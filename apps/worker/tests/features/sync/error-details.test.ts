import { describe, expect, it } from "vitest";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
} from "../../../src/connectors/cathaybk";
import {
  isUserActionError,
  safeErrorLogDetails,
  safeErrorMessage,
} from "../../../src/features/sync/service";

describe("sync error details", () => {
  it("classifies Cathay OTP states as user actions", () => {
    expect(
      isUserActionError(
        new CathayOtpChannelRequiredError(
          "choose channel",
          "pending-session",
          "2026-08-22T12:00:00.000Z",
        ),
      ),
    ).toBe(true);
    expect(isUserActionError(new CathayOtpRequiredError("sent", "email"))).toBe(
      true,
    );
    expect(isUserActionError(new CathayOtpSessionExpiredError())).toBe(true);
    expect(isUserActionError(new CathayOtpInvalidError())).toBe(true);
  });

  it("uses a non-empty fallback when Error.message is blank", () => {
    expect(safeErrorMessage(new Error("  \n  "))).toBe(
      "同步失敗，但未取得錯誤原因。",
    );
    expect(safeErrorMessage(undefined)).toBe("同步失敗，但未取得錯誤原因。");
  });

  it("normalizes and bounds the persisted message", () => {
    expect(safeErrorMessage(new Error("連線   暫時\n失敗"))).toBe(
      "連線 暫時 失敗",
    );
    expect(safeErrorMessage(new Error("a".repeat(301)))).toHaveLength(300);
  });

  it("redacts sensitive values from structured log diagnostics", () => {
    const error = new Error("request failed");
    error.stack =
      "Error: password=must-not-appear\n    at https://bank.example/path token=abcdefghijklmnopqrstuvwxyz password=hunter2";
    const cause = new Error(
      "authorization=Bearer_abcdefghijklmnopqrstuvwx cookie=session-value",
    );
    cause.stack =
      "Error: cookie=must-not-appear\n    at https://bank.example/cause secret=short-value";
    error.cause = cause;

    const details = safeErrorLogDetails(error);

    expect(details).toMatchObject({
      errorName: "Error",
      stack: expect.stringContaining("[URL]"),
      causeName: "Error",
      causeStack: expect.stringContaining("secret=[redacted]"),
    });
    expect(JSON.stringify(details)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(details)).not.toContain("hunter2");
    expect(JSON.stringify(details)).not.toContain("session-value");
    expect(JSON.stringify(details)).not.toContain("must-not-appear");
    expect(JSON.stringify(details)).not.toContain("short-value");
  });

  it("includes a bounded stage identifier when an error exposes one", () => {
    const error = Object.assign(new Error("failed"), {
      stage: "fetch_realtime",
    });

    expect(safeErrorLogDetails(error)).toMatchObject({
      errorName: "Error",
      stage: "fetch_realtime",
    });
  });
});
