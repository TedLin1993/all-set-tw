import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChbConnectionError,
  ChbSessionEndedError,
  ChbStepRunner,
  createChbSessionState,
  isValidCaptcha,
  runWithChbLogout,
} from "../../../src/sources/chb/connector";
import { ChbSyncReport } from "../../../src/sources/chb/protocol";

describe("彰化銀行登入與登出", () => {
  afterEach(() => vi.restoreAllMocks());

  it("驗證碼只接受 6 位數字", () => {
    expect(isValidCaptcha("123456")).toBe(true);
    expect(isValidCaptcha("12345")).toBe(false);
    expect(isValidCaptcha("12a456")).toBe(false);
  });

  it("送出登入後即使同步失敗也一定嘗試登出，且不覆蓋原錯誤；未登入則不登出", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = createChbSessionState();
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "http_200",
    }));
    await expect(
      runWithChbLogout(
        session,
        async () => {
          session.loginRequested = true;
          throw new ChbConnectionError("boom");
        },
        logout,
      ),
    ).rejects.toThrow("boom");
    expect(logout).toHaveBeenCalledTimes(1);

    const idle = vi.fn(async () => undefined);
    await expect(
      runWithChbLogout(createChbSessionState(), async () => "ok", idle),
    ).resolves.toBe("ok");
    expect(idle).not.toHaveBeenCalled();
  });
});

describe("彰化銀行逐項擷取", () => {
  it("單項失敗只略過並記錄，工作階段結束仍使整次同步失敗，連續三項失敗後停止", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new ChbSyncReport();
    const steps = new ChbStepRunner(report);
    await expect(
      steps.run("twBalance", "fetch", async () => {
        throw new ChbConnectionError("單項失敗");
      }),
    ).resolves.toBeUndefined();
    await expect(
      steps.run("twTransactions", "fetch", async () => "ok"),
    ).resolves.toBe("ok");
    await expect(
      steps.run("fcBalance", "fetch", async () => {
        throw new ChbSessionEndedError();
      }),
    ).rejects.toBeInstanceOf(ChbSessionEndedError);

    const halting = new ChbStepRunner(report);
    const fail = async () => {
      throw new ChbConnectionError("x");
    };
    for (let i = 0; i < 3; i += 1)
      await halting.run("fcTransactions", "fetch", fail);
    const ran = vi.fn(async () => "never");
    await halting.run("fcTransactions", "fetch", ran);
    expect(ran).not.toHaveBeenCalled();
  });
});
