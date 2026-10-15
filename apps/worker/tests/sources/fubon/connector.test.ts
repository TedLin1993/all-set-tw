import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFubonSessionState,
  describeUnsentLogin,
  fubonLogoutPlan,
  isValidCaptcha,
  runWithFubonLogout,
  type FubonSessionState,
} from "../../../src/sources/fubon/connector";

describe("fubon login submit diagnostics", () => {
  it("accepts only six-digit captcha answers", () => {
    expect(isValidCaptcha("123456")).toBe(true);
    expect(isValidCaptcha("12345")).toBe(false);
    expect(isValidCaptcha("1234567")).toBe(false);
    expect(isValidCaptcha("12a456")).toBe(false);
    expect(isValidCaptcha("")).toBe(false);
  });

  it("reports bank validation messages when no login request was sent", () => {
    expect(
      describeUnsentLogin(
        { selectedTab: "m1", validateOk: false, exception: null },
        ["身分證字號驗證錯誤", "驗證碼限輸入6位數字"],
      ),
    ).toBe(
      "台北富邦登入頁未送出登入請求（帳密未送出）：身分證字號驗證錯誤；驗證碼限輸入6位數字",
    );
  });

  it("reports the page exception and selected tab", () => {
    expect(
      describeUnsentLogin(
        { selectedTab: null, validateOk: null, exception: "TypeError" },
        [],
      ),
    ).toBe(
      "台北富邦登入頁未送出登入請求（帳密未送出）：登入頁程式發生 TypeError（頁籤 未選取）。",
    );
  });

  it("reports a failed validation without messages", () => {
    expect(
      describeUnsentLogin(
        { selectedTab: "m1", validateOk: false, exception: null },
        [],
      ),
    ).toBe(
      "台北富邦登入頁未送出登入請求（帳密未送出）：登入表單未通過官方格式檢查。",
    );
  });
});

describe("fubon logout guarantee", () => {
  afterEach(() => vi.restoreAllMocks());

  const state = (overrides: Partial<FubonSessionState>) => ({
    ...createFubonSessionState(),
    ...overrides,
  });
  const loggedEvents = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls
      .map((call: unknown[]) => JSON.parse(String(call[0])))
      .filter((event: { event: string }) => event.event === "fubon_logout");

  it("logs out after a successful sync and returns the result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = state({});
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "official",
    }));
    const result = await runWithFubonLogout(
      session,
      async () => {
        session.loginRequested = true;
        session.loggedIn = true;
        session.lastOutcome = "success";
        return "synced";
      },
      logout,
    );
    expect(result).toBe("synced");
    expect(logout).toHaveBeenCalledTimes(1);
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({
        attempted: true,
        ok: true,
        reason: "official",
      }),
    ]);
  });

  it("logs out when the login result is unknown and rethrows the original error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = state({});
    const original = new Error("登入結果不明（no_response）");
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "official",
    }));
    await expect(
      runWithFubonLogout(
        session,
        async () => {
          session.loginRequested = true;
          session.lastOutcome = "unknown";
          throw original;
        },
        logout,
      ),
    ).rejects.toBe(original);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(fubonLogoutPlan(session)).toEqual({ kind: "full" });
  });

  it("logs out after post-login failures (parser, frame, timeout)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const failure of [
      new Error("parser"),
      new Error("frame missing"),
      new Error("timeout"),
    ]) {
      const session = state({
        loginRequested: true,
        loggedIn: true,
        lastOutcome: "success",
      });
      const logout = vi.fn(async () => ({
        attempted: true,
        ok: true,
        reason: "official",
      }));
      await expect(
        runWithFubonLogout(
          session,
          async () => {
            throw failure;
          },
          logout,
        ),
      ).rejects.toBe(failure);
      expect(logout).toHaveBeenCalledTimes(1);
    }
  });

  it("never replaces the original error when logout throws or hangs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = new Error("original");
    await expect(
      runWithFubonLogout(
        state({ loginRequested: true }),
        async () => {
          throw original;
        },
        async () => {
          throw new TypeError("page closed");
        },
      ),
    ).rejects.toBe(original);
    await expect(
      runWithFubonLogout(
        state({ loginRequested: true, loggedIn: true }),
        async () => "ok",
        () => new Promise(() => undefined),
        20,
      ),
    ).resolves.toBe("ok");
    expect(loggedEvents(warn)).toEqual([
      expect.objectContaining({
        attempted: true,
        ok: false,
        reason: "error",
        errorName: "TypeError",
      }),
      expect.objectContaining({
        attempted: true,
        ok: false,
        reason: "timeout",
      }),
    ]);
  });

  it("does not log out before the login request was sent or while OTP input is pending", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "official",
    }));
    await expect(
      runWithFubonLogout(
        state({}),
        async () => {
          throw new Error("captcha page failed");
        },
        logout,
      ),
    ).rejects.toThrow("captcha page failed");
    await expect(
      runWithFubonLogout(
        state({ loginRequested: true, otpPending: true }),
        async () => {
          throw new Error("otp required");
        },
        logout,
      ),
    ).rejects.toThrow("otp required");
    expect(logout).not.toHaveBeenCalled();
  });

  it("plans an in-place logout only after an explicit bank rejection", () => {
    expect(
      fubonLogoutPlan(
        state({ loginRequested: true, lastOutcome: "duplicate" }),
      ),
    ).toEqual({ kind: "in_place" });
    expect(
      fubonLogoutPlan(
        state({ loginRequested: true, lastOutcome: "two_factor" }),
      ),
    ).toEqual({ kind: "in_place" });
    expect(
      fubonLogoutPlan(
        state({
          loginRequested: true,
          loggedIn: true,
          lastOutcome: "duplicate",
        }),
      ),
    ).toEqual({ kind: "full" });
    expect(fubonLogoutPlan(state({ loginRequested: true }))).toEqual({
      kind: "full",
    });
  });
});
