import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FEIB_URLS,
  FeibConnectionError,
  FeibSessionEndedError,
  FeibStepRunner,
  createFeibSessionState,
  isValidCaptcha,
  runWithFeibLogout,
} from "../../../src/sources/feib/connector";
import { FeibSyncReport } from "../../../src/sources/feib/protocol";

describe("遠東商銀登入與登出", () => {
  afterEach(() => vi.restoreAllMocks());

  it("驗證碼只接受 6 位數字", () => {
    expect(isValidCaptcha("123456")).toBe(true);
    expect(isValidCaptcha("12345")).toBe(false);
    expect(isValidCaptcha("12a456")).toBe(false);
  });

  it("密碼變更提醒只走「下次登入再變更」，登出使用官方 toLogout 網址", () => {
    const later = new URL(FEIB_URLS.passwordChangeLater);
    expect(later.searchParams.get("trx")).toBe("com.lb.wibc.trx.Login");
    expect(later.searchParams.get("state")).toBe("loginAFT");
    expect(FEIB_URLS.passwordChangeLater).not.toMatch(/SSLPwdChng|state=fix/);
    expect(new URL(FEIB_URLS.logout).searchParams.get("state")).toBe(
      "verifyCard",
    );
  });

  it("送出登入後即使同步失敗也一定嘗試登出，且不覆蓋原錯誤", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = createFeibSessionState();
    const logout = vi.fn(async () => ({
      attempted: true,
      ok: true,
      reason: "http_200",
    }));
    await expect(
      runWithFeibLogout(
        session,
        async () => {
          session.loginRequested = true;
          throw new FeibConnectionError("boom");
        },
        logout,
      ),
    ).rejects.toThrow("boom");
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("尚未送出登入時不呼叫登出；登出失敗不影響同步結果", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logout = vi.fn(async () => {
      throw new Error("logout failed");
    });
    await expect(
      runWithFeibLogout(createFeibSessionState(), async () => "x", logout),
    ).resolves.toBe("x");
    expect(logout).not.toHaveBeenCalled();

    const session = { ...createFeibSessionState(), loggedIn: true };
    await expect(
      runWithFeibLogout(session, async () => "synced", logout),
    ).resolves.toBe("synced");
    expect(logout).toHaveBeenCalledTimes(1);
  });
});

describe("遠東商銀部分失敗", () => {
  afterEach(() => vi.restoreAllMocks());

  it("單項失敗只略過該項，連續失敗三次後停止其餘項目", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new FeibSyncReport();
    const runner = new FeibStepRunner(report, async () => undefined);
    const fail = async () => {
      throw new Error("帳號 09990000001111 查詢失敗");
    };
    expect(await runner.run("depositTransactions", "fetch", fail)).toBe(
      undefined,
    );
    expect(await runner.run("cardStatus", "fetch", async () => "ok")).toBe(
      "ok",
    );
    await runner.run("cardBills", "fetch", fail);
    await runner.run("cardBills", "fetch", fail);
    await runner.run("cardBills", "fetch", fail);
    const skipped = vi.fn(async () => "never");
    expect(await runner.run("cardBills", "fetch", skipped)).toBeUndefined();
    expect(skipped).not.toHaveBeenCalled();
    expect(report.counts.cardBills.failed).toBe(4);
    expect(JSON.stringify(report.summary())).not.toContain("09990000001111");
  });

  it("工作階段結束不可略過，整次同步失敗", async () => {
    const runner = new FeibStepRunner(
      new FeibSyncReport(),
      async () => undefined,
    );
    await expect(
      runner.run("deposits", "fetch", async () => {
        throw new FeibSessionEndedError();
      }),
    ).rejects.toBeInstanceOf(FeibSessionEndedError);
  });
});
